/**
 * BNJI.NET — chat plan Phase D (plan §12.5's report path; owner answer
 * 2026-09-30: fill the image gate inside Phase D):
 *
 *   POST /api/dm/report  { conversation, n }  ->  200 { reported, reportCount }
 *
 * Mirrors the room flow (`POST /api/chat/report`): a report never removes
 * anything — it snapshots the message into `dm_reports` (D1 is the durable
 * store, so no DO round-trip is needed), de-dups distinct reporters, and
 * lands in the SAME `chat_moderation_log` audit trail the admin Chat tab
 * reads. Only the receiving side may report: the sender reporting their own
 * message is refused (`report_own_message`).
 */
import type { APIContext } from 'astro';
import { sha256Hex } from '../../../server/player-store';
import { logDmReport, recordDmReport } from '../../../server/dm-reports';
import {
	isValidConversationId, requireDmAccount, requireDmEnabled, requireDmNotBanned, requireDmRate, resolveDmContext, resolveDmConversation,
} from '../../../server/dm-routes';
import { readBodyTextBounded } from '../../../server/read-body';

export const prerender = false;

type MessageSnapshotRow = { sender: string; body: string; image_id: string | null; created_at: number };

export async function POST(context: APIContext): Promise<Response> {
	const resolved = await resolveDmContext(context, { origin: 'required' });
	if (resolved instanceof Response) return resolved;
	const guard = requireDmAccount(resolved) ?? requireDmEnabled(resolved) ?? await requireDmNotBanned(resolved) ?? await requireDmRate(resolved, 'report');
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
	const n = Number(payload.n);

	const outcome = await resolveDmConversation(resolved.db, resolved.player, { conversation: payload.conversation });
	if (!outcome.ok) return resolved.finish({ error: outcome.error }, outcome.status);

	// Membership came from the conversation row; the snapshot comes straight
	// from the durable message (§7.3 — D1 is the record, no DO needed).
	const message = await resolved.db.prepare(
		'SELECT sender, body, image_id, created_at FROM dm_messages WHERE conv_id = ?1 AND n = ?2 LIMIT 1',
	).bind(outcome.conv.id, n).first<MessageSnapshotRow>();
	if (!message) return resolved.finish({ error: 'message_not_found' }, 404);
	if (message.sender === resolved.player.playerId) return resolved.finish({ error: 'report_own_message' }, 403);

	try {
		const { reportCount } = await recordDmReport(resolved.db, {
			convId: outcome.conv.id,
			messageN: n,
			snapshot: {
				sender: message.sender,
				body: message.body,
				imageId: message.image_id ?? null,
				messageAt: Number(message.created_at),
			},
			reporterId: resolved.player.playerId!,
		});
		await logDmReport(resolved.db, {
			convId: outcome.conv.id,
			messageN: n,
			reporterHash: await sha256Hex(`player:${resolved.player.playerId!}`),
		});
		return resolved.finish({ reported: true, reportCount }, 200);
	} catch {
		return resolved.finish({ error: 'storage_unavailable' }, 503);
	}
}
