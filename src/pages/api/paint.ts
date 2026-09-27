/**
 * Public API for the shared board paint canvas.
 *
 * GET returns the current bounded PNG snapshot. POST replaces it only when
 * the caller's revision is current; a 409 gives the caller the newest snapshot
 * so its local transparent drawing layer can be composited and retried.
 * This keeps canvas edits independent from board_messages and prevents two
 * publishers from silently overwriting one another.
 */
import { BOARD_CONFIG } from '../../config/board.config';
import { PAINT_CONFIG } from '../../config/paint.config';
import { serverEnvironment } from '../../server/env';
import { clientIp } from '../../server/security-helpers';
import { rateLimit, type KvRateLimitStore } from '../../server/ratelimit';
import type { APIContext } from 'astro';

export const prerender = false;

// Structural types keep the endpoint server-only without importing client
// code or adding another Workers types package.
type PaintStatement = {
	bind(...values: (string | number | null)[]): PaintStatement;
	first<T>(): Promise<T | null>;
	run(): Promise<{ meta?: { changes?: number } }>;
};

type PaintD1 = {
	prepare(query: string): PaintStatement;
	batch(statements: PaintStatement[]): Promise<{ meta?: { changes?: number } }[]>;
};

type PaintState = {
	revision: number;
	image: string | null;
	updated_at: number;
	last_request_id?: string | null;
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			...headers,
		},
	});
}

function database(env: Record<string, unknown>): PaintD1 | null {
	const candidate = env.BOARD_DB as PaintD1 | undefined;
	return candidate && typeof candidate.prepare === 'function' && typeof candidate.batch === 'function'
		? candidate
		: null;
}

async function currentState(db: PaintD1): Promise<PaintState | null> {
	return db
		.prepare('SELECT revision, image, updated_at, last_request_id FROM board_paint_state WHERE id = 1')
		.first<PaintState>();
}

function etagFor(revision: number): string {
	return `W/"paint-${revision}"`;
}

function etagMatches(header: string | null, etag: string): boolean {
	if (!header) return false;
	const opaque = etag.replace(/^W\//, '');
	return header
		.split(',')
		.some((candidate) => candidate.trim().replace(/^W\//, '') === opaque);
}

function stateResponse(state: PaintState, status = 200, extra: Record<string, string> = {}): Response {
	return json(
		{
			revision: Number(state.revision),
			image: state.image,
			updatedAt: Number(state.updated_at),
		},
		status,
		{ etag: etagFor(Number(state.revision)), ...extra },
	);
}

/** Read a JSON request without allowing an unbounded body into Worker memory. */
async function readBoundedJson(request: Request): Promise<
	| { ok: true; value: unknown }
	| { ok: false; reason: 'invalid_json' | 'too_large' }
> {
	const length = Number(request.headers.get('content-length'));
	if (Number.isFinite(length) && length > PAINT_CONFIG.maxRequestBytes) {
		return { ok: false, reason: 'too_large' };
	}

	const reader = request.body?.getReader();
	if (!reader) return { ok: false, reason: 'invalid_json' };
	const chunks: Uint8Array[] = [];
	let total = 0;

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > PAINT_CONFIG.maxRequestBytes) {
				await reader.cancel();
				return { ok: false, reason: 'too_large' };
			}
			chunks.push(value);
		}
	} catch {
		return { ok: false, reason: 'invalid_json' };
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	try {
		return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
	} catch {
		return { ok: false, reason: 'invalid_json' };
	}
}

const PNG_CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit++) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	return crc >>> 0;
});

function pngCrc(bytes: Uint8Array, start: number, end: number): number {
	let crc = 0xffffffff;
	for (let i = start; i < end; i++) crc = PNG_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

/** Validate a complete, chunk-checksummed PNG and its fixed logical dimensions. */
function isCanvasPng(value: unknown): value is string {
	const prefix = 'data:image/png;base64,';
	if (
		typeof value !== 'string' ||
		value.length > PAINT_CONFIG.maxImageChars ||
		!value.startsWith(prefix)
	) {
		return false;
	}

	try {
		const encoded = value.slice(prefix.length);
		if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return false;
		const binary = atob(encoded);
		if (binary.length < 45) return false;
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		const signature = [137, 80, 78, 71, 13, 10, 26, 10];
		if (signature.some((byte, index) => bytes[index] !== byte)) return false;

		const uint32 = (index: number): number =>
			bytes[index] * 0x1000000 +
			(bytes[index + 1] << 16) +
			(bytes[index + 2] << 8) +
			bytes[index + 3];
		let offset = 8;
		let hasHeader = false;
		let hasData = false;
		let hasEnd = false;

		while (offset + 12 <= bytes.length) {
			const length = uint32(offset);
			const typeOffset = offset + 4;
			const dataOffset = offset + 8;
			const crcOffset = dataOffset + length;
			if (crcOffset + 4 > bytes.length) return false;
			const type = String.fromCharCode(...bytes.subarray(typeOffset, typeOffset + 4));
			if (pngCrc(bytes, typeOffset, crcOffset) !== uint32(crcOffset)) return false;

			if (!hasHeader) {
				if (type !== 'IHDR' || length !== 13) return false;
				const validFormat = bytes[dataOffset + 8] === 8 &&
					(bytes[dataOffset + 9] === 2 || bytes[dataOffset + 9] === 6) &&
					bytes[dataOffset + 10] === 0 && bytes[dataOffset + 11] === 0 && bytes[dataOffset + 12] === 0;
				if (uint32(dataOffset) !== PAINT_CONFIG.width || uint32(dataOffset + 4) !== PAINT_CONFIG.height || !validFormat) return false;
				hasHeader = true;
			} else if (type === 'IHDR') {
				return false;
			} else if (type === 'IDAT') {
				hasData = true;
			} else if (type === 'IEND') {
				if (length !== 0 || !hasData || crcOffset + 4 !== bytes.length) return false;
				hasEnd = true;
				break;
			}
			offset = crcOffset + 4;
		}

		return hasHeader && hasData && hasEnd;
	} catch {
		return false;
	}
}

export async function GET(context: APIContext): Promise<Response> {
	if (BOARD_CONFIG.provider !== 'd1') return json({ error: 'paint_requires_d1_board' }, 503);
	const db = database(await serverEnvironment());
	if (!db) return json({ error: 'storage_unavailable' }, 503);

	try {
		const state = await currentState(db);
		if (!state) return json({ error: 'storage_unavailable' }, 503);
		const etag = etagFor(Number(state.revision));
		if (etagMatches(context.request.headers.get('if-none-match'), etag)) {
			return new Response(null, {
				status: 304,
				headers: { etag, 'cache-control': 'no-store' },
			});
		}
		return stateResponse(state);
	} catch (error) {
		console.error('[bnji] board paint read failed:', error);
		return json({ error: 'storage_unavailable' }, 503);
	}
}

export async function POST(context: APIContext): Promise<Response> {
	if (BOARD_CONFIG.provider !== 'd1') return json({ error: 'paint_requires_d1_board' }, 503);
	const env = await serverEnvironment();
	const db = database(env);
	if (!db) return json({ error: 'storage_unavailable' }, 503);

	const kv = env.BOARD_KV as KvRateLimitStore | undefined;
	const limit = await rateLimit(
		kv,
		`board-paint:${clientIp(context.request)}`,
		3_600_000,
		PAINT_CONFIG.syncsPerHour,
	);
	if (!limit.allowed) {
		return json({ error: 'rate_limited', retryAfter: limit.retryAfter }, 429);
	}

	const parsed = await readBoundedJson(context.request);
	if (!parsed.ok) {
		return json({ error: parsed.reason }, parsed.reason === 'too_large' ? 413 : 400);
	}
	const payload = (parsed.value ?? {}) as {
		revision?: unknown;
		requestId?: unknown;
		image?: unknown;
	};
	if (
		!Number.isSafeInteger(payload.revision) ||
		Number(payload.revision) < 0 ||
		typeof payload.requestId !== 'string' ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.requestId)
	) {
		return json({ error: 'invalid_request' }, 422);
	}
	if (!isCanvasPng(payload.image)) {
		return json(
			{
				error: typeof payload.image === 'string' && payload.image.length > PAINT_CONFIG.maxImageChars
					? 'image_too_large'
					: 'invalid_canvas_image',
				maxImageChars: PAINT_CONFIG.maxImageChars,
			},
			422,
		);
	}

	const expectedRevision = Number(payload.revision);
	const requestId = payload.requestId;
	const now = Date.now();

	try {
		// Replaying the same request after a dropped response must not apply a
		// transparent/local drawing layer twice or lose a later publisher's edit.
		const priorCommit = await db
			.prepare('SELECT request_id FROM board_paint_commits WHERE request_id = ?1')
			.bind(requestId)
			.first<{ request_id: string }>();
		if (priorCommit) {
			const latest = await currentState(db);
			return latest ? stateResponse(latest, 200, { 'x-paint-already-applied': 'true' }) : json({ error: 'storage_unavailable' }, 503);
		}

		const state = await currentState(db);
		if (!state) return json({ error: 'storage_unavailable' }, 503);
		if (Number(state.revision) !== expectedRevision) {
			return stateResponse(state, 409, { 'x-paint-conflict': 'true' });
		}

		const nextRevision = expectedRevision + 1;
		const results = await db.batch([
			db
				.prepare(
					`UPDATE board_paint_state
					 SET image = ?1, revision = revision + 1, updated_at = ?2, last_request_id = ?3
					 WHERE id = 1 AND revision = ?4`,
				)
				.bind(payload.image, now, requestId, expectedRevision),
			db
				.prepare(
					`INSERT INTO board_paint_commits (request_id, revision, created_at)
					 SELECT ?1, ?2, ?3
					 WHERE EXISTS (
						 SELECT 1 FROM board_paint_state
						 WHERE id = 1 AND revision = ?2 AND last_request_id = ?1
					 )`,
				)
				.bind(requestId, nextRevision, now),
			db
				.prepare(
					`DELETE FROM board_paint_commits
					 WHERE request_id NOT IN (
						 SELECT request_id FROM board_paint_commits
						 ORDER BY created_at DESC, rowid DESC LIMIT ?1
					 )`,
				)
				.bind(PAINT_CONFIG.retainedCommitIds),
		]);

		if ((results[0]?.meta?.changes ?? 0) === 0) {
			const latest = await currentState(db);
			return latest ? stateResponse(latest, 409, { 'x-paint-conflict': 'true' }) : json({ error: 'storage_unavailable' }, 503);
		}

		return json({ revision: nextRevision, updatedAt: now }, 200, { etag: etagFor(nextRevision) });
	} catch (error) {
		console.error('[bnji] board paint write failed:', error);
		return json({ error: 'storage_unavailable' }, 503);
	}
}
