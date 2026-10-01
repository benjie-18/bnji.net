/**
 * BNJI.NET — chat plan Phase E (plan §8.3, §10):
 *
 *   GET /api/notifications -> 200 { unreadMessages, pendingFriendRequests }
 *
 * The in-app badge is the ONLY notifications surface (§8.3: push/email
 * deferred); signed-in browsers poll it (~60 s) while a page is open. Read-only
 * counts for the caller — no per-message detail, no other account's data, and
 * never KV (§11).
 */
import type { APIContext } from 'astro';
import { FRIENDS_CONFIG } from '../../config/friends.config';
import { countPendingFriendRequests } from '../../server/friend-store';
import { countUnreadDmMessages } from '../../server/dm-store';
import { requireDmAccount, resolveDmContext } from '../../server/dm-routes';

export const prerender = false;

export async function GET(context: APIContext): Promise<Response> {
	const resolved = await resolveDmContext(context);
	if (resolved instanceof Response) return resolved;
	const guard = requireDmAccount(resolved);
	if (guard) return guard;
	const playerId = resolved.player.playerId!;
	try {
		const [unreadMessages, pendingFriendRequests] = await Promise.all([
			countUnreadDmMessages(resolved.db, playerId),
			// Rollback lever (§14): with friends off the badge must not nag
			// about rows the feature is pretending not to have.
			FRIENDS_CONFIG.enabled ? countPendingFriendRequests(resolved.db, playerId) : Promise.resolve(0),
		]);
		return resolved.finish({ unreadMessages, pendingFriendRequests }, 200);
	} catch {
		return resolved.finish({ error: 'storage_unavailable' }, 503);
	}
}
