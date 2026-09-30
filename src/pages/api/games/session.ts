/** Best-effort active-play heartbeat. Storage failure must never interrupt the game. */
import type { APIContext } from 'astro';
import { getGame } from '../../../data/games';
import { clientIp } from '../../../server/security-helpers';
import { readBodyTextBounded } from '../../../server/read-body';
import { appendPlayerCookies, resolvePlayerContext } from '../../../server/player-context';
import { recordGameSession, type D1Database } from '../../../server/game-store';
import { serverEnvironment } from '../../../server/env';
import { rateLimit, type KvRateLimitStore } from '../../../server/ratelimit';

export const prerender = false;
const VALID_SCREEN = new Set(['compact', 'standard', 'large', 'unknown']);
const VALID_INPUT = new Set(['touch', 'fine-pointer', 'mixed', 'unknown']);
const SESSION_FIELDS = new Set(['gameId', 'runId', 'kind', 'activeMs', 'screenClass', 'inputClass']);
function hasOnlySessionFields(value: Record<string, unknown>): boolean {
	return ['gameId', 'runId', 'kind', 'activeMs'].every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => SESSION_FIELDS.has(key));
}
function sameOrigin(request: Request): boolean {
	const origin = request.headers.get('origin');
	return Boolean(origin && origin === new URL(request.url).origin);
}

function deviceInfo(ua: string): { browser: string; operatingSystem: string; deviceClass: string } {
	const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other';
	const operatingSystem = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Other';
	const deviceClass = /iPad|Tablet|PlayBook/.test(ua) ? 'tablet' : /Mobi|Android|iPhone|iPod/.test(ua) ? 'mobile' : ua ? 'desktop' : 'unknown';
	return { browser, operatingSystem, deviceClass };
}

export async function POST(context: APIContext): Promise<Response> {
	const headers = new Headers({ 'cache-control': 'no-store' });
	const finish = () => new Response(null, { status: 204, headers });
	if (!sameOrigin(context.request)) return finish();

	try {
		const env = await serverEnvironment();
		const db = env.BOARD_DB as D1Database | undefined;
		const player = await resolvePlayerContext(context.request, db);
		appendPlayerCookies(headers, player);
		const text = await readBodyTextBounded(context.request, 1024);
		if (text === null) return finish();
		const body: unknown = JSON.parse(text || '{}');
		if (!body || typeof body !== 'object' || Array.isArray(body)) return finish();
		const p = body as Record<string, unknown>;
		if (!hasOnlySessionFields(p)) return finish();
		const gameId = typeof p.gameId === 'string' ? p.gameId : '';
		const runId = typeof p.runId === 'string' ? p.runId : '';
		const kind = p.kind;
		const activeMs = p.activeMs;
		if (!getGame(gameId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId) || !['start', 'heartbeat', 'end'].includes(String(kind))) return finish();
		if (typeof activeMs !== 'number' || !Number.isFinite(activeMs) || activeMs < 0 || activeMs > 65_000) return finish();
		const ip = clientIp(context.request);
		if (!db || typeof db.prepare !== 'function') return finish();
		// Starts can create rows; heartbeat updates are already atomic per-run
		// and gated to one write per 45 seconds. Avoid spending KV writes on the
		// normal minute heartbeat path (KV Free is shared account-wide).
		if (kind === 'start') {
			const limit = await rateLimit(env.BOARD_KV as KvRateLimitStore | undefined, `game-session:${ip}`, 60_000, 30);
			if (!limit.allowed) return finish();
		}
		const ua = (context.request.headers.get('user-agent') ?? '').slice(0, 512);
		const device = deviceInfo(ua);
		const screenClass = typeof p.screenClass === 'string' && VALID_SCREEN.has(p.screenClass) ? p.screenClass : 'unknown';
		const inputClass = typeof p.inputClass === 'string' && VALID_INPUT.has(p.inputClass) ? p.inputClass : 'unknown';
		await recordGameSession(db, {
			sessionId: player.sessionId,
			runId,
			playerId: player.playerId,
			gameId,
			kind: kind as 'start' | 'heartbeat' | 'end',
			activeMs: Math.floor(activeMs),
			now: Date.now(),
			ipAddress: ip.slice(0, 64),
			userAgent: ua,
			...device,
			screenClass,
			inputClass,
		});
	} catch {
		// Private tracking is best effort and intentionally has no player-facing error.
	}
	return new Response(null, { status: 204, headers });
}
