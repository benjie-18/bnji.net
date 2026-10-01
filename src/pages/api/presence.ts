/**
 * BNJI.NET — chat plan Phase E (plan §8.2, §10):
 *
 *   GET /api/presence   (WebSocket upgrade) -> 101 into the global Presence DO
 *
 * Same guards as the DM socket (account, feature switch, D1 connect budget —
 * never KV), then the two facts the DO needs are minted HERE from D1 and
 * passed as trusted headers: the account's handle and its ACCEPTED-friend
 * handles. A browser can never address the DO directly (only this Worker
 * holds the namespace), so §8.1's "presence visible only to accepted
 * friends" is enforced at the source; the DO never receives player IDs.
 */
import type { APIContext } from 'astro';
import { FRIENDS_CONFIG } from '../../config/friends.config';
import { serverEnvironment } from '../../server/env';
import { appendPlayerCookies } from '../../server/player-context';
import { reserveAuthAttempt, sha256Hex } from '../../server/player-store';
import { presenceNamespace, presenceServiceFetch } from '../../server/presence-gateway';
import {
	dmJson, dmOriginAllowed, requireDmAccount, resolveDmContext,
} from '../../server/dm-routes';

export const prerender = false;

export async function GET(context: APIContext): Promise<Response> {
	if (!dmOriginAllowed(context.request)) return dmJson({ error: 'origin_not_allowed' }, 403);
	if (context.request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return dmJson({ error: 'websocket_required' }, 426);

	const resolved = await resolveDmContext(context);
	if (resolved instanceof Response) return resolved;
	const accountGuard = requireDmAccount(resolved);
	if (accountGuard) return accountGuard;
	if (!FRIENDS_CONFIG.enabled) return resolved.finish({ error: 'friends_disabled' }, 403);

	const playerId = resolved.player.playerId!;
	try {
		const budget = await reserveAuthAttempt(
			resolved.db, await sha256Hex(`bnji-presence-ws:${playerId}`), Date.now(),
			{ windowMs: 60_000, maxAttempts: FRIENDS_CONFIG.presenceConnectsPerMinute },
		);
		if (!budget.allowed) {
			const response = resolved.finish({ error: 'rate_limited', retryAfter: budget.retryAfter }, 429);
			response.headers.set('retry-after', String(budget.retryAfter));
			return response;
		}

		const [identity, friendRows] = await Promise.all([
			resolved.db.prepare('SELECT handle FROM game_players WHERE id = ?1 LIMIT 1').bind(playerId).first<{ handle: string | null }>(),
			resolved.db.prepare(
				`SELECT p.handle AS handle FROM player_friends f
				 JOIN game_players p ON p.id = CASE WHEN f.player_a = ?1 THEN f.player_b ELSE f.player_a END
				 WHERE (f.player_a = ?1 OR f.player_b = ?1) AND f.state = 'accepted' AND p.handle IS NOT NULL
				 LIMIT 501`,
			).bind(playerId).all<{ handle: string | null }>(),
		]);
		const friends = friendRows.results
			.map((row) => (row.handle === null ? null : String(row.handle)))
			.filter((handle): handle is string => handle !== null)
			.slice(0, 500);

		const env = await serverEnvironment();
		if (!presenceNamespace((env as Record<string, unknown>).PRESENCE)) {
			return resolved.finish({ error: 'presence_service_unavailable' }, 503);
		}
		const response = await presenceServiceFetch(env, {
			player: `player:${playerId}`,
			handle: identity?.handle ?? '',
			friends,
			request: context.request,
		});
		if (response.status !== 101) appendPlayerCookies(response.headers, resolved.player);
		return response;
	} catch {
		return resolved.finish({ error: 'presence_service_unavailable' }, 503);
	}
}
