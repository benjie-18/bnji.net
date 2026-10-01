/**
 * Display-name setter for both scopes (chat plan Phase A, §4 / §10).
 *
 *   GET  /api/profile/name → { displayName, scope } — current label, so the
 *        rooms panel can show it (null until first set; never cached).
 *   POST /api/profile/name { displayName } → same shape after setting.
 *        Signed-in players rename the ACCOUNT (game_players.display_name);
 *        guests set a session-scoped label (guest_profiles, keyed by the
 *        digest of the session id — the raw cookie value is never stored).
 *        One endpoint, two scopes: the label you see follows who you are.
 *
 * Rules: shared sanitizer (src/server/display-name.ts) is the only validator;
 * POST is origin-checked, body-bounded (512 B) and KV rate-limited per IP
 * (profile naming is not chat/DM/presence/friend activity, so the KV
 * namespace rule allows it); the response never includes ids.
 */
import type { APIContext } from 'astro';
import { NAMES_CONFIG } from '../../../config/names.config';
import { serverEnvironment } from '../../../server/env';
import { sanitizeDisplayName } from '../../../server/display-name';
import { readGuestProfile, upsertGuestProfile } from '../../../server/guest-profile-store';
import { appendPlayerCookies, PlayerContextStorageError, resolvePlayerContext } from '../../../server/player-context';
import { clientIp } from '../../../server/security-helpers';
import { readBodyTextBounded } from '../../../server/read-body';
import { rateLimit, type KvRateLimitStore } from '../../../server/ratelimit';
import type { D1Database } from '../../../server/game-store';

export const prerender = false;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(data: unknown, status = 200, cookies: string[] = []): Response {
	const headers = new Headers(JSON_HEADERS);
	for (const cookie of cookies) headers.append('set-cookie', cookie);
	return new Response(JSON.stringify(data), { status, headers });
}
function dbBinding(value: unknown): D1Database | null {
	return value && typeof (value as D1Database).prepare === 'function' ? value as D1Database : null;
}
function allowedOrigin(request: Request): boolean {
	const origin = request.headers.get('origin');
	return Boolean(origin && origin === new URL(request.url).origin);
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

type Resolved = {
	db: D1Database;
	player: Awaited<ReturnType<typeof resolvePlayerContext>>;
	scope: 'account' | 'guest';
};
async function resolve(context: APIContext): Promise<Resolved | Response> {
	const env = await serverEnvironment();
	const db = dbBinding(env.BOARD_DB);
	if (!db) return json({ error: 'storage_unavailable' }, 503);
	try {
		const player = await resolvePlayerContext(context.request, db);
		return { db, player, scope: player.playerId ? 'account' : 'guest' };
	} catch (error) {
		if (error instanceof PlayerContextStorageError) return json({ error: 'storage_unavailable' }, 503);
		return json({ error: 'storage_unavailable' }, 503);
	}
}
function withContext(data: unknown, status: number, resolved: Resolved): Response {
	const response = json(data, status);
	appendPlayerCookies(response.headers, resolved.player);
	return response;
}
async function currentName(resolved: Resolved): Promise<string | null> {
	if (resolved.player.playerId) {
		const row = await resolved.db.prepare('SELECT display_name FROM game_players WHERE id = ?1 LIMIT 1')
			.bind(resolved.player.playerId).first<{ display_name: string }>();
		return row?.display_name ?? null;
	}
	const profile = await readGuestProfile(resolved.db, resolved.player.sessionId);
	return profile?.display_name ?? null;
}

export async function GET(context: APIContext): Promise<Response> {
	const resolved = await resolve(context);
	if (resolved instanceof Response) return resolved;
	try {
		return withContext({ displayName: await currentName(resolved), scope: resolved.scope }, 200, resolved);
	} catch {
		return withContext({ error: 'storage_unavailable' }, 503, resolved);
	}
}

export async function POST(context: APIContext): Promise<Response> {
	if (!allowedOrigin(context.request)) return json({ error: 'origin_not_allowed' }, 403);
	const resolved = await resolve(context);
	if (resolved instanceof Response) return resolved;
	const text = await readBodyTextBounded(context.request, 512);
	if (text === null) return withContext({ error: 'payload_too_large' }, 413, resolved);
	let body: unknown;
	try { body = JSON.parse(text || '{}'); } catch { return withContext({ error: 'invalid_json' }, 400, resolved); }
	if (!isRecord(body) || !hasOnlyKeys(body, ['displayName'])) return withContext({ error: 'invalid_payload' }, 400, resolved);
	const env = await serverEnvironment();
	try {
		const gate = await rateLimit(
			env.BOARD_KV as KvRateLimitStore | undefined,
			`profile-name:${clientIp(context.request)}`,
			NAMES_CONFIG.limits.nameChangeWindowMs,
			NAMES_CONFIG.limits.nameChangeMax,
		);
		if (!gate.allowed) {
			const response = withContext({ error: 'rate_limited', retryAfter: gate.retryAfter }, 429, resolved);
			response.headers.set('retry-after', String(gate.retryAfter));
			return response;
		}
	} catch { return withContext({ error: 'storage_unavailable' }, 503, resolved); }
	const sanitized = sanitizeDisplayName(body.displayName);
	if (!sanitized.ok) return withContext({ error: sanitized.error }, 422, resolved);
	const now = Date.now();
	try {
		if (resolved.player.playerId) {
			await resolved.db.prepare('UPDATE game_players SET display_name = ?1, updated_at = ?2 WHERE id = ?3')
				.bind(sanitized.name, now, resolved.player.playerId).run();
		} else {
			await upsertGuestProfile(resolved.db, { sessionId: resolved.player.sessionId, displayName: sanitized.name, now });
		}
	} catch { return withContext({ error: 'storage_unavailable' }, 503, resolved); }
	return withContext({ displayName: sanitized.name, scope: resolved.scope }, 200, resolved);
}
