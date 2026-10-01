/**
 * BNJI.NET — chat plan Phase E (plan §8.1, §10):
 *
 *   GET    /api/friends                       -> 200 { friends, incoming, outgoing, blocked, config }
 *   POST   /api/friends { action, handle }    -> 200 lists   action: request | accept | decline | block
 *   DELETE /api/friends { action, handle }    -> 200 lists   action: remove | unblock
 *                                                (remove = unfriend, or cancel
 *                                                 your own outgoing request)
 *
 * Account-only (plan §7.1), same-origin mutations, bounded bodies, D1 rate
 * budgets never KV (§11). Player IDs never leave the server — everything is
 * handle-labelled (§12.3); the lists are strictly private (§8.1) and only the
 * caller's own rows are ever queried. Errors: invalid_payload, invalid_handle,
 * self_friend, already_friends, already_pending, not_found, blocked,
 * friends_limit, pending_limit, rate_limited, friends_disabled,
 * storage_unavailable.
 */
import type { APIContext } from 'astro';
import { FRIENDS_CONFIG } from '../../config/friends.config';
import {
	dmJson, dmOriginAllowed, requireDmAccount, resolveDmContext, type DmRouteContext,
} from '../../server/dm-routes';
import { friendAction, listFriendState } from '../../server/friend-store';
import { reserveAuthAttempt, sha256Hex } from '../../server/player-store';
import { readBodyTextBounded } from '../../server/read-body';

export const prerender = false;

const REQUEST_ACTIONS = new Set(['request', 'accept', 'decline', 'block']);
const REMOVE_ACTIONS = new Set(['remove', 'unblock']);

function requireFriendsEnabled(context: DmRouteContext): Response | null {
	if (!FRIENDS_CONFIG.enabled) return context.finish({ error: 'friends_disabled' }, 403);
	return null;
}

async function requireFriendRate(context: DmRouteContext, kind: 'request' | 'decision'): Promise<Response | null> {
	const playerId = context.player.playerId;
	if (!playerId) return null;
	const limits = kind === 'request'
		? { windowMs: 60_000, maxAttempts: FRIENDS_CONFIG.requestsPerMinute }
		: { windowMs: 60_000, maxAttempts: FRIENDS_CONFIG.decisionsPerMinute };
	try {
		const budget = await reserveAuthAttempt(context.db, await sha256Hex(`bnji-friend-${kind}:${playerId}`), Date.now(), limits);
		if (!budget.allowed) {
			const response = context.finish({ error: 'rate_limited', retryAfter: budget.retryAfter }, 429);
			response.headers.set('retry-after', String(budget.retryAfter));
			return response;
		}
	} catch {
		return context.finish({ error: 'storage_unavailable' }, 503);
	}
	return null;
}

async function lists(context: DmRouteContext): Promise<ReturnType<typeof listFriendState>> {
	return listFriendState(context.db, context.player.playerId!);
}

export async function GET(context: APIContext): Promise<Response> {
	const resolved = await resolveDmContext(context);
	if (resolved instanceof Response) return resolved;
	const guard = requireDmAccount(resolved) ?? requireFriendsEnabled(resolved);
	if (guard) return guard;
	try {
		const state = await lists(resolved);
		return resolved.finish({ ...state, config: { maxFriends: FRIENDS_CONFIG.maxFriends, maxPendingOutgoing: FRIENDS_CONFIG.maxPendingOutgoing } }, 200);
	} catch {
		return resolved.finish({ error: 'storage_unavailable' }, 503);
	}
}

async function mutate(context: APIContext, method: 'POST' | 'DELETE'): Promise<Response> {
	const resolved = await resolveDmContext(context, { origin: 'required' });
	if (resolved instanceof Response) return resolved;
	const guard = requireDmAccount(resolved) ?? requireFriendsEnabled(resolved);
	if (guard) return guard;

	const text = await readBodyTextBounded(context.request, 1_024);
	if (text === null) return resolved.finish({ error: 'payload_too_large' }, 413);
	let body: unknown;
	try { body = JSON.parse(text || '{}'); } catch { return resolved.finish({ error: 'invalid_json' }, 400); }
	const payload = body as Record<string, unknown>;
	if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
		typeof payload.action !== 'string' || typeof payload.handle !== 'string' ||
		Object.keys(payload).length !== 2 ||
		(method === 'POST' ? !REQUEST_ACTIONS.has(payload.action) : !REMOVE_ACTIONS.has(payload.action))) {
		return resolved.finish({ error: 'invalid_payload' }, 400);
	}

	const rateGuard = await requireFriendRate(resolved, method === 'POST' && payload.action === 'request' ? 'request' : 'decision');
	if (rateGuard) return rateGuard;

	try {
		const outcome = await friendAction(
			resolved.db, resolved.player.playerId!,
			payload.action as 'request' | 'accept' | 'decline' | 'block' | 'remove' | 'unblock',
			payload.handle, Date.now(),
		);
		if (!outcome.ok) return resolved.finish({ error: outcome.error }, outcome.status);
		const state = await lists(resolved);
		return resolved.finish({ changed: outcome.changed, ...state, config: { maxFriends: FRIENDS_CONFIG.maxFriends, maxPendingOutgoing: FRIENDS_CONFIG.maxPendingOutgoing } }, 200);
	} catch {
		return resolved.finish({ error: 'storage_unavailable' }, 503);
	}
}

export async function POST(context: APIContext): Promise<Response> {
	return mutate(context, 'POST');
}

export async function DELETE(context: APIContext): Promise<Response> {
	return mutate(context, 'DELETE');
}

/** Same-origin guard helper kept next to the mutations for tests/readers. */
export function friendsOriginAllowed(request: Request): boolean {
	return dmOriginAllowed(request);
}
