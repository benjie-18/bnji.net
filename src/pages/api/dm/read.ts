/**
 * BNJI.NET — chat plan Phase D (plan §10, §7.1):
 *
 *   POST /api/dm/read  { conversation, seq? }  ->  200 { readSeq }
 *
 * One read watermark per member per conversation — never per message.
 * `seq` defaults to the conversation's last_seq (the client marking the
 * thread as seen). The partner's live socket receives `dm_read` so the
 * "seen" indicator updates without polling.
 */
import type { APIContext } from 'astro';
import { serverEnvironment } from '../../../server/env';
import { pushDmFrame } from '../../../server/dm-gateway';
import { DM_PROTOCOL_VERSION } from '../../../server/dm-protocol';
import { markRead } from '../../../server/dm-store';
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
	if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !isValidConversationId(payload.conversation) ||
		(payload.seq !== undefined && (!Number.isSafeInteger(payload.seq) || Number(payload.seq) < 0))) {
		return resolved.finish({ error: 'invalid_payload' }, 400);
	}

	const outcome = await resolveDmConversation(resolved.db, resolved.player, { conversation: payload.conversation });
	if (!outcome.ok) return resolved.finish({ error: outcome.error }, outcome.status);
	const seq = payload.seq === undefined ? outcome.conv.lastSeq : Number(payload.seq);
	const capped = Math.min(seq, outcome.conv.lastSeq);
	try {
		await markRead(resolved.db, outcome.conv.id, outcome.side, capped);
	} catch {
		return resolved.finish({ error: 'storage_unavailable' }, 503);
	}
	const env = await serverEnvironment();
	await pushDmFrame(env, outcome.conv.id, { t: 'dm_read', v: DM_PROTOCOL_VERSION, side: outcome.side, seq: capped });
	return resolved.finish({ readSeq: capped }, 200);
}
