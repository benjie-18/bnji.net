/**
 * BNJI.NET — chat plan Phase D (plan §10 / §7.4 steps 1–3):
 *
 *   POST /api/dm/attachments  { conversation, data }  ->  200 { attachment }
 *
 * The CLIENT has already normalised the image through <canvas> (longest edge
 * bounded, re-encoded — which strips EXIF/GPS before the bytes ever left the
 * browser). This route: membership, upload budget (§7.5), bounded base64
 * decode, magic-byte sniff + allowlist (no SVG), then D1 base64 storage under
 * the board's documented 1.4 MB ceiling (D6 — R2 stays unprovisioned per the
 * owner's answer). The attachment is inert until a message claims it; stale
 * unclaimed uploads are swept hourly.
 */
import type { APIContext } from 'astro';
import { DM_CONFIG } from '../../../config/dm.config';
import { validateImageUpload } from '../../../server/image-sniff';
import { readBodyTextBounded } from '../../../server/read-body';
import {
	requireDmAccount, requireDmEnabled, requireDmImagesEnabled, requireDmNotBanned, requireDmRate, resolveDmContext, resolveDmConversation,
} from '../../../server/dm-routes';
import { createAttachment } from '../../../server/dm-store';

export const prerender = false;

function randomAttachmentId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function POST(context: APIContext): Promise<Response> {
	const resolved = await resolveDmContext(context, { origin: 'required' });
	if (resolved instanceof Response) return resolved;
	const guard = requireDmAccount(resolved) ?? requireDmEnabled(resolved) ?? requireDmImagesEnabled(resolved) ??
		await requireDmNotBanned(resolved) ?? await requireDmRate(resolved, 'image');
	if (guard) return guard;

	// base64 of ≤1.4 MB decoded ≈ 1.87 M chars + envelope.
	const bodyBound = Math.ceil(DM_CONFIG.images.maxDecodedBytes * 4 / 3) + 4_096;
	const text = await readBodyTextBounded(context.request, bodyBound);
	if (text === null) return resolved.finish({ error: 'payload_too_large' }, 413);
	let body: unknown;
	try { body = JSON.parse(text || '{}'); } catch { return resolved.finish({ error: 'invalid_json' }, 400); }
	const payload = body as Record<string, unknown>;
	if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
		typeof payload.conversation !== 'string' || typeof payload.data !== 'string') {
		return resolved.finish({ error: 'invalid_payload' }, 400);
	}

	const outcome = await resolveDmConversation(resolved.db, resolved.player, { conversation: payload.conversation });
	if (!outcome.ok) return resolved.finish({ error: outcome.error }, outcome.status);

	const validated = validateImageUpload(payload.data);
	if (!validated.ok) {
		return resolved.finish({ error: validated.error }, validated.error === 'image_too_large' ? 413 : 422);
	}
	try {
		const id = randomAttachmentId();
		await createAttachment(resolved.db, {
			id,
			convId: outcome.conv.id,
			uploader: resolved.player.playerId!,
			mime: validated.mime,
			data: payload.data.trim(),
		});
		return resolved.finish({ attachment: { id, mime: validated.mime, bytes: validated.bytes.length } }, 200);
	} catch {
		return resolved.finish({ error: 'storage_unavailable' }, 503);
	}
}
