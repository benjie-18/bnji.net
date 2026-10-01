/**
 * BNJI.NET — chat plan Phase D: authenticated upgrade boundary for one
 * DMConversation Durable Object (mirrors the room `/ws` route; plan §10).
 *
 *   GET /api/dm/ws?conversation=<id>   (WebSocket upgrade)
 *
 * Same guards as every DM surface: account-only, feature switch, Phase C
 * ban, D1 connect budget (never KV), then membership resolved HERE — the DO
 * only re-validates header shapes. The trusted principal + side headers are
 * minted by the gateway from the resolved membership, never from the client.
 */
import type { APIContext } from 'astro';
import { serverEnvironment } from '../../../server/env';
import { dmNamespace, dmServiceFetch } from '../../../server/dm-gateway';
import { appendPlayerCookies } from '../../../server/player-context';
import {
	isValidConversationId, requireDmAccount, requireDmEnabled, requireDmNotBanned, requireDmRate, resolveDmContext, resolveDmConversation,
} from '../../../server/dm-routes';

export const prerender = false;

function json(data: unknown, status = 400): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
function allowedOrigin(request: Request): boolean {
	const origin = request.headers.get('origin');
	return Boolean(origin && origin === new URL(request.url).origin);
}

export async function GET(context: APIContext): Promise<Response> {
	if (!allowedOrigin(context.request)) return json({ error: 'origin_not_allowed' }, 403);
	if (context.request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'websocket_required' }, 426);
	const conversation = context.url.searchParams.get('conversation');
	if (!isValidConversationId(conversation)) return json({ error: 'invalid_payload' }, 400);

	const resolved = await resolveDmContext(context);
	if (resolved instanceof Response) return resolved;
	const guard = requireDmAccount(resolved) ?? requireDmEnabled(resolved) ?? await requireDmNotBanned(resolved) ?? await requireDmRate(resolved, 'ws');
	if (guard) return guard;

	const outcome = await resolveDmConversation(resolved.db, resolved.player, { conversation });
	if (!outcome.ok) return resolved.finish({ error: outcome.error }, outcome.status);
	try {
		const env = await serverEnvironment();
		if (!dmNamespace(env.DM_CONVERSATIONS)) {
			return resolved.finish({ error: 'dm_service_unavailable' }, 503);
		}
		const response = await dmServiceFetch(env, outcome.conv.id, {
			path: '/ws', player: resolved.player, side: outcome.side, request: context.request,
		});
		// Mirror the room route: cookies ride every non-101 response; the 101
		// itself carries no headers to append to beyond the upgrade.
		if (response.status !== 101) appendPlayerCookies(response.headers, resolved.player);
		return response;
	} catch {
		return resolved.finish({ error: 'dm_service_unavailable' }, 503);
	}
}
