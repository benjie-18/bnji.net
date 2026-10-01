/**
 * BNJI.NET — chat plan Phase D (plan §10 / §7.3):
 *
 *   GET  /api/dm/messages?conversation=<id>[&after=<n>|&before=<n>&limit=]
 *        -> 200 { messages, myReadSeq, partnerReadSeq, lastSeq }
 *   POST /api/dm/messages { conversation | handle, body?, imageId? }
 *        -> 200 { message }
 *
 * GET is the history pull a reconnecting client uses ("everything after its
 * last seen sequence" §7.3); POST is the single write path: validate →
 * budget → D1 append → live push to the DO (in that order, §7.3). The DO
 * never sees the durable write side; strangers never resolve a conversation
 * (membership enforced in resolveDmConversation — plan §13).
 */
import type { APIContext } from 'astro';
import { DM_CONFIG } from '../../../config/dm.config';
import { sanitizePlainText } from '../../../server/display-name';
import { serverEnvironment } from '../../../server/env';
import { pushDmFrame } from '../../../server/dm-gateway';
import {
	DM_SIDE_BIT, DM_PROTOCOL_VERSION,
} from '../../../server/dm-protocol';
import {
	appendMessage, appendMessageClaimingAttachment, listMessages,
} from '../../../server/dm-store';
import {
	isValidConversationId, resolveDmContext, requireDmAccount, requireDmEnabled, requireDmImagesEnabled,
	requireDmNotBanned, requireDmRate, resolveDmConversation,
} from '../../../server/dm-routes';
import { readBodyTextBounded } from '../../../server/read-body';

export const prerender = false;

const ATTACHMENT_PATTERN = /^[a-f0-9]{32}$/;

export async function GET(context: APIContext): Promise<Response> {
	const resolved = await resolveDmContext(context);
	if (resolved instanceof Response) return resolved;
	const guard = requireDmAccount(resolved) ?? requireDmEnabled(resolved) ?? await requireDmNotBanned(resolved);
	if (guard) return guard;
	const params = context.url.searchParams;
	const conversation = params.get('conversation');
	if (!isValidConversationId(conversation)) return resolved.finish({ error: 'invalid_payload' }, 400);
	const after = params.get('after');
	const before = params.get('before');
	const limit = params.get('limit');
	const parsedAfter = after === null ? undefined : Number(after);
	const parsedBefore = before === null ? undefined : Number(before);
	const parsedLimit = limit === null ? undefined : Number(limit);
	if ((parsedAfter !== undefined && (!Number.isSafeInteger(parsedAfter) || parsedAfter < 0)) ||
		(parsedBefore !== undefined && (!Number.isSafeInteger(parsedBefore) || parsedBefore < 1)) ||
		(parsedLimit !== undefined && (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1))) {
		return resolved.finish({ error: 'invalid_payload' }, 400);
	}
	const outcome = await resolveDmConversation(resolved.db, resolved.player, { conversation });
	if (!outcome.ok) return resolved.finish({ error: outcome.error }, outcome.status);
	try {
		const messages = await listMessages(resolved.db, {
			conv: outcome.conv,
			viewerId: resolved.player.playerId!,
			after: parsedAfter,
			before: parsedBefore,
			limit: parsedLimit,
		});
		return resolved.finish({
			messages,
			myReadSeq: outcome.side === 'lo' ? outcome.conv.readSeqLo : outcome.conv.readSeqHi,
			partnerReadSeq: outcome.side === 'lo' ? outcome.conv.readSeqHi : outcome.conv.readSeqLo,
			lastSeq: outcome.conv.lastSeq,
		}, 200);
	} catch {
		return resolved.finish({ error: 'storage_unavailable' }, 503);
	}
}

export async function POST(context: APIContext): Promise<Response> {
	const resolved = await resolveDmContext(context, { origin: 'required' });
	if (resolved instanceof Response) return resolved;
	const guard = requireDmAccount(resolved) ?? requireDmEnabled(resolved) ?? await requireDmNotBanned(resolved) ?? await requireDmRate(resolved, 'send');
	if (guard) return guard;

	// Bounded body (§10): text is capped at maxTextLength code points (~8 KB
	// worst-case UTF-8) — attachments go through /api/dm/attachments instead.
	const text = await readBodyTextBounded(context.request, 16_384);
	if (text === null) return resolved.finish({ error: 'payload_too_large' }, 413);
	let body: unknown;
	try { body = JSON.parse(text || '{}'); } catch { return resolved.finish({ error: 'invalid_json' }, 400); }
	const payload = body as Record<string, unknown>;
	if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
		(payload.conversation === undefined && payload.handle === undefined) ||
		(payload.body !== undefined && typeof payload.body !== 'string') ||
		(payload.imageId !== undefined && typeof payload.imageId !== 'string')) {
		return resolved.finish({ error: 'invalid_payload' }, 400);
	}
	const rawBody = typeof payload.body === 'string' ? payload.body : '';
	const imageId = typeof payload.imageId === 'string' ? payload.imageId : null;
	if (imageId !== null && !ATTACHMENT_PATTERN.test(imageId)) return resolved.finish({ error: 'invalid_payload' }, 400);
	if (!imageId && rawBody.trim().length === 0) return resolved.finish({ error: 'empty_message' }, 422);
	if (imageId) {
		const imagesGuard = requireDmImagesEnabled(resolved);
		if (imagesGuard) return imagesGuard;
	}

	let messageBody = '';
	if (rawBody.trim().length > 0) {
		const sanitized = sanitizePlainText(rawBody, DM_CONFIG.maxTextLength);
		if (!sanitized.ok) {
			return resolved.finish({ error: sanitized.error === 'too_long' ? 'message_too_long' : 'empty_message' }, 422);
		}
		messageBody = sanitized.value;
	} else if (!imageId) {
		return resolved.finish({ error: 'empty_message' }, 422);
	}

	const outcome = await resolveDmConversation(resolved.db, resolved.player, payload);
	if (!outcome.ok) return resolved.finish({ error: outcome.error }, outcome.status);

	let message;
	try {
		message = imageId
			? await appendMessageClaimingAttachment(resolved.db, {
				conv: outcome.conv, sender: resolved.player.playerId!, body: messageBody, imageId,
			})
			: await appendMessage(resolved.db, {
				conv: outcome.conv, sender: resolved.player.playerId!, body: messageBody, imageId: null,
			});
	} catch {
		return resolved.finish({ error: 'storage_unavailable' }, 503);
	}
	if (!message) return resolved.finish({ error: 'attachment_not_available' }, 409);

	// Durable first, live second (§7.3): a push failure never fails the send.
	const env = await serverEnvironment();
	await pushDmFrame(env, outcome.conv.id, {
		t: 'dm_new',
		v: DM_PROTOCOL_VERSION,
		m: { n: message.n, senderSide: outcome.side, body: message.body, imageId: message.imageId, at: message.createdAt },
	});
	return resolved.finish({
		message: {
			n: message.n,
			from: 'me' as const,
			body: message.body,
			imageId: message.imageId,
			at: message.createdAt,
			sideBit: DM_SIDE_BIT[outcome.side],
		},
	}, 200);
}
