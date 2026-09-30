/** Public leaderboard read API. The response includes only display name and score fields. */
import type { APIContext } from 'astro';
import { getGame, isValidGameMode } from '../../../data/games';
import { clientIp } from '../../../server/security-helpers';
import { rateLimit, type KvRateLimitStore } from '../../../server/ratelimit';
import { appendPlayerCookies, PlayerContextStorageError, resolvePlayerContext, type PlayerContext } from '../../../server/player-context';
import { readLeaderboard, type D1Database } from '../../../server/game-store';
import { getTrackingRetentionDays } from '../../../server/tracking-retention';
import { serverEnvironment } from '../../../server/env';

export const prerender = false;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_HITS = 60;

function json(data: unknown, status = 200, player?: PlayerContext): Response {
	const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	if (player) appendPlayerCookies(headers, player);
	return new Response(JSON.stringify(data), { status, headers });
}

export async function GET(context: APIContext): Promise<Response> {
	const env = await serverEnvironment();
	const db = env.BOARD_DB as D1Database | undefined;
	if (!db || typeof db.prepare !== 'function') return json({ error: 'storage_unavailable' }, 503);
	let player: PlayerContext;
	try { player = await resolvePlayerContext(context.request, db); }
	catch (error) { return json({ error: error instanceof PlayerContextStorageError ? 'storage_unavailable' : 'storage_unavailable' }, 503); }
	const params = context.url.searchParams;
	const gameId = params.get('gameId') ?? '';
	const modeId = params.get('mode') ?? 'default';
	const pageText = params.get('page') ?? '0';
	const page = /^\d{1,3}$/.test(pageText) ? Number(pageText) : -1;
	const game = getGame(gameId);
	if (!game || (game.status !== 'available' && game.status !== 'unavailable')) return json({ error: 'unknown_game' }, 404, player);
	if (!isValidGameMode(modeId) || !(game.modes ?? ['default']).includes(modeId)) return json({ error: 'invalid_mode' }, 400, player);
	if (!Number.isInteger(page) || page < 0 || page > 19) return json({ error: 'invalid_page' }, 400, player);

	const limit = await rateLimit(env.BOARD_KV as KvRateLimitStore | undefined, `game-leaderboard:${clientIp(context.request)}`, RATE_WINDOW_MS, RATE_MAX_HITS);
	if (!limit.allowed) return json({ error: 'rate_limited', retryAfter: limit.retryAfter }, 429, player);
	try {
		// Keep this public read-only route free of cleanup writes; expired scores
		// are filtered here and the bounded Worker sweep deletes them separately.
		const retentionDays = await getTrackingRetentionDays(db);
		const cutoff = Date.now() - retentionDays * 86_400_000;
		const result = await readLeaderboard(db, gameId, modeId, page, 25, cutoff);
		return json({ gameId, mode: modeId, page, pageSize: 25, hasMore: result.hasMore, rows: result.rows }, 200, player);
	} catch {
		return json({ error: 'storage_unavailable' }, 503, player);
	}
}
