/**
 * The caller's own standing on one leaderboard: personal best, rank and board
 * size. Private per caller, so it is never cached and never joins a page.
 *
 * This endpoint exists so a game can decide INDEPENDENTLY of the device whether
 * a finished run beats the player's best: the client asks here, and the answer
 * is measured over the account (every session that has signed in) rather than
 * over one browser's localStorage. A guest gets their own session's best.
 * Only the caller's rows are read — other players appear as a count.
 */
import type { APIContext } from 'astro';
import { getGame, isValidGameMode } from '../../../../data/games';
import { clientIp } from '../../../../server/security-helpers';
import { rateLimit, type KvRateLimitStore } from '../../../../server/ratelimit';
import { appendPlayerCookies, PlayerContextStorageError, resolvePlayerContext, type PlayerContext } from '../../../../server/player-context';
import { readPersonalBest, type D1Database } from '../../../../server/game-store';
import { getTrackingRetentionDays } from '../../../../server/tracking-retention';
import { serverEnvironment } from '../../../../server/env';

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
	catch { return json({ error: 'storage_unavailable' }, 503); }
	const params = context.url.searchParams;
	const gameId = params.get('gameId') ?? '';
	const modeId = params.get('mode') ?? 'default';
	const game = getGame(gameId);
	if (!game || (game.status !== 'available' && game.status !== 'unavailable')) return json({ error: 'unknown_game' }, 404, player);
	if (!isValidGameMode(modeId) || !(game.modes ?? ['default']).includes(modeId)) return json({ error: 'invalid_mode' }, 400, player);

	const limit = await rateLimit(env.BOARD_KV as KvRateLimitStore | undefined, `game-personal-best:${clientIp(context.request)}`, RATE_WINDOW_MS, RATE_MAX_HITS);
	if (!limit.allowed) return json({ error: 'rate_limited', retryAfter: limit.retryAfter }, 429, player);
	try {
		const retentionDays = await getTrackingRetentionDays(db);
		const cutoff = Date.now() - retentionDays * 86_400_000;
		const standing = await readPersonalBest(db, { gameId, modeId, sessionId: player.sessionId, playerId: player.playerId, cutoff });
		return json({ gameId, mode: modeId, scope: player.playerId ? 'account' : 'guest', ...standing }, 200, player);
	} catch {
		return json({ error: 'storage_unavailable' }, 503, player);
	}
}
