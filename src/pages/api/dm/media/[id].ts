/**
 * BNJI.NET — chat plan Phase D (plan §10 / §7.4 step 4 — serving):
 *
 *   GET /api/dm/media/:id  ->  200 image bytes
 *
 * Authenticated route that checks conversation membership first; sets the
 * exact sniffed content type (stored server-side, never client-declared),
 * `X-Content-Type-Options: nosniff`, and `cache-control: no-store` — private
 * content, no intermediary caching (§10). The bytes are re-decoded from the
 * stored base64 with the same size ceiling that admitted them.
 */
import type { APIContext } from 'astro';
import { decodeImageBase64 } from '../../../../server/image-sniff';
import {
	requireDmAccount, requireDmEnabled, requireDmImagesEnabled, requireDmNotBanned, resolveDmContext,
} from '../../../../server/dm-routes';
import { getAttachmentForViewer } from '../../../../server/dm-store';

export const prerender = false;

export async function GET(context: APIContext): Promise<Response> {
	const resolved = await resolveDmContext(context);
	if (resolved instanceof Response) return resolved;
	const guard = requireDmAccount(resolved) ?? requireDmEnabled(resolved) ?? requireDmImagesEnabled(resolved) ?? await requireDmNotBanned(resolved);
	if (guard) return guard;

	const id = context.params.id ?? '';
	if (!/^[a-f0-9]{32}$/.test(id)) return resolved.finish({ error: 'invalid_payload' }, 400);
	// Membership lives on the attachment's conversation row; an id a member
	// of that conversation has never seen still 404s after this join resolves.
	let attachment: { mime: string; data: string } | null = null;
	try {
		attachment = await getAttachmentForViewer(resolved.db, id, resolved.player.playerId!);
	} catch {
		return resolved.finish({ error: 'storage_unavailable' }, 503);
	}
	if (!attachment) return resolved.finish({ error: 'attachment_not_found' }, 404);
	const decoded = decodeImageBase64(attachment.data);
	if (!decoded.ok) return resolved.finish({ error: 'attachment_unavailable' }, 500);
	// Uint8Array is a valid BodyInit in Workers — no Buffer in workerd.
	return new Response(decoded.bytes as unknown as BodyInit, {
		status: 200,
		headers: {
			'content-type': attachment.mime,
			'x-content-type-options': 'nosniff',
			'cache-control': 'no-store',
		},
	});
}
