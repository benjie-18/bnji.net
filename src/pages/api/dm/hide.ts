/**
 * BNJI.NET — chat plan Phase D (plan D12 — delete-for-me):
 *
 *   POST /api/dm/hide  { conversation, n }  ->  200 { hidden: true }
 *
 * Sets the viewer's `hidden_for` bit: the row stays for the other
 * participant and for retention (delete-for-everyone is deferred, §9.4) —
 * the list/history queries simply stop showing it to this side. The live
 * `dm_hide` frame lets the partner's UI drop it from their view only when
 * their own bit matches (it never does for this action — the bit is ours).
 */
import type { APIContext } from 'astro';
import { serverEnvironment } from '../../../server/env';
import { pushDmFrame } from '../../../server/dm-gateway';
import { DM_PROTOCOL_VERSION, DM_SIDE_BIT } from '../../../server/dm-protocol';
import { hideMessage } from '../../../server/dm-store';
import {
	isValidConversationId, requireDmAccount, requireDmEnabled, requireDmNotBanned, resolveDmContext, resolveDmConversation,
} from '../../../server/dm-routes';
import { readBodyTextBounded } from '../../../server/read-body';

export const prerender = false;

export async function POST(context: APIContext): Promise<Response> {
	const resolved = await resolveDmContext(context, { origin: 'required' });
	if (resolved instanceof Response) return resolved;
	const guard = requireDmAccount(resolved) ?? requireDmEnabled(resolved) ?? await requireDmNotBanned(resolved);
	if (guard) return guard;

	const text = await readBodyTextBounded(context.request, 1_024);
	if (text === null) return resolved.finish({ error: 'payload_too_large' }, 413);
	let body: unknown;
	try { body = JSON.parse(text || '{}'); } catch { return resolved.finish({ error: 'invalid_json' }, 400); }
	const payload = body as Record<string, unknown>;
	if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
		!isValidConversationId(payload.conversation) ||
		!Number.isSafeInteger(payload.n) || Number(payload.n) < 1) {
		return resolved.finish({ error: 'invalid_payload' }, 400);
	}

	const outcome = await resolveDmConversation(resolved.db, resolved.player, { conversation: payload.conversation });
	if (!outcome.ok) return resolved.finish({ error: outcome.error }, outcome.status);
	let hidden = false;
	try {
		hidden = await hideMessage(resolved.db, outcome.conv.id, Number(payload.n), outcome.side);
	} catch {
		return resolved.finish({ error: 'storage_unavailable' }, 503);
	}
	if (!hidden) return resolved.finish({ error: 'message_not_found' }, 404);
	const env = await serverEnvironment();
	await pushDmFrame(env, outcome.conv.id, {
		t: 'dm_hide', v: DM_PROTOCOL_VERSION, n: Number(payload.n), bit: DM_SIDE_BIT[outcome.side],
	});
	return resolved.finish({ hidden: true }, 200);
}
