/**
 * The people index: search the accounts that chose a handle, so a friend request
 * does not require knowing an exact handle out of band.
 *
 *   GET /api/people[?query=frag] → { people: [{ handle, displayName, friendState }], truncated }
 *
 * Account-only, same-origin, `no-store`, and rate-limited per account in KV. The
 * row is two public labels plus the caller's own edge to that account; a player
 * id, session, email, IP or "last seen" never appears here, and an account
 * without a handle is simply not part of the index. Accounts that block each
 * other in either direction are filtered out in SQL, so this endpoint can never be
 * used to discover a block.
 */
import type { APIContext } from 'astro';
import { DIRECTORY_CONFIG } from '../../config/directory.config';
import { FRIENDS_CONFIG } from '../../config/friends.config';
import { serverEnvironment } from '../../server/env';
import { dmJson, dmOriginAllowed, resolveDmContext } from '../../server/dm-routes';
import { listPeople, normalizePeopleQuery } from '../../server/people-index';
import { rateLimit, type KvRateLimitStore } from '../../server/ratelimit';
import { sha256Hex } from '../../server/player-store';

export const prerender = false;

export async function GET(context: APIContext): Promise<Response> {
	if (!dmOriginAllowed(context.request)) return dmJson({ error: 'origin_not_allowed' }, 403);
	const resolved = await resolveDmContext(context);
	if (resolved instanceof Response) return resolved;
	const { player, finish } = resolved;
	if (!DIRECTORY_CONFIG.enabled) return finish({ error: 'directory_disabled' }, 503);
	// The index exists to feed a friend request. With Phase E switched off there
	// is nothing to act on, so an index would only widen exposure for no benefit.
	if (!FRIENDS_CONFIG.enabled) return finish({ error: 'friends_disabled' }, 503);
	const playerId = player.playerId;
	if (!playerId) return finish({ error: 'account_required' }, 403);

	const normalized = normalizePeopleQuery(context.url.searchParams.get('query'));
	if ('error' in normalized) return finish({ error: normalized.error }, 400);

	const env = await serverEnvironment();
	const limit = await rateLimit(
		env.BOARD_KV as KvRateLimitStore | undefined,
		`people-index:${await sha256Hex(`player:${playerId}`)}`,
		DIRECTORY_CONFIG.rate.windowMs,
		DIRECTORY_CONFIG.rate.requests,
	);
	if (!limit.allowed) {
		const response = finish({ error: 'rate_limited', retryAfter: limit.retryAfter }, 429);
		response.headers.set('retry-after', String(limit.retryAfter));
		return response;
	}

	try {
		const page = await listPeople(resolved.db, playerId, normalized.query);
		return finish({ ...page, minQueryLength: DIRECTORY_CONFIG.minQueryLength }, 200);
	} catch {
		return finish({ error: 'storage_unavailable' }, 503);
	}
}
