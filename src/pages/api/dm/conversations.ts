/**
 * BNJI.NET — chat plan Phase D (plan §10):
 *
 *   GET  /api/dm/conversations   -> 200 { conversations, config }
 *   POST /api/dm/conversations   { handle } -> 200 { conversation }
 *
 * The list is the product's landing surface (§7.1): conversations with
 * unread counts and a bounded preview, partner identified by handle +
 * display label only — player IDs never leave the server (§12.3).
 * POST resolves a conversation by exact handle (D8) without the caller
 * ever learning the partner's player ID.
 */
import type { APIContext } from 'astro';
import { DM_CONFIG } from '../../../config/dm.config';
import {
	requireDmAccount, requireDmEnabled, requireDmFriendship, requireDmNotBanned, requireDmRate, resolveDmContext, resolveDmConversation,
} from '../../../server/dm-routes';
import { listConversations } from '../../../server/dm-store';
import { readBodyTextBounded } from '../../../server/read-body';

export const prerender = false;

export async function GET(context: APIContext): Promise<Response> {
	const resolved = await resolveDmContext(context);
	if (resolved instanceof Response) return resolved;
	const guard = requireDmAccount(resolved) ?? requireDmEnabled(resolved) ?? await requireDmNotBanned(resolved);
	if (guard) return guard;
	try {
		const conversations = await listConversations(resolved.db, resolved.player.playerId!);
		return resolved.finish({
			conversations,
			config: {
				retentionDays: DM_CONFIG.retentionDays,
				maxTextLength: DM_CONFIG.maxTextLength,
				images: { enabled: DM_CONFIG.images.enabled, maxEdge: DM_CONFIG.images.maxEdge, maxDecodedBytes: DM_CONFIG.images.maxDecodedBytes, allowedTypes: DM_CONFIG.images.allowedTypes },
			},
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

	const text = await readBodyTextBounded(context.request, 1_024);
	if (text === null) return resolved.finish({ error: 'payload_too_large' }, 413);
	let body: unknown;
	try { body = JSON.parse(text || '{}'); } catch { return resolved.finish({ error: 'invalid_json' }, 400); }
	const payload = body as Record<string, unknown>;
	if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1) {
		return resolved.finish({ error: 'invalid_payload' }, 400);
	}

	const outcome = await resolveDmConversation(resolved.db, resolved.player, payload);
	if (!outcome.ok) return resolved.finish({ error: outcome.error }, outcome.status);

	const gatePartnerId = outcome.side === 'lo' ? outcome.conv.memberHi : outcome.conv.memberLo;
	{
		const gate = await requireDmFriendship(resolved, gatePartnerId);
		if (gate) return gate;
	}

	if (!outcome.conv.lastMessageAt) {
		// Resolved-by-handle with no row yet: return the derived identity so the
		// composer can open, but keep the actual INSERT for the first message
		// (empty conversations stay invisible in lists either way).
		const partnerId = outcome.side === 'lo' ? outcome.conv.memberHi : outcome.conv.memberLo;
		const partner = await resolved.db.prepare('SELECT handle, display_name FROM game_players WHERE id = ?1 LIMIT 1')
			.bind(partnerId).first<{ handle: string | null; display_name: string }>();
		return resolved.finish({
			conversation: {
				id: outcome.conv.id,
				mySide: outcome.side,
				partner: {
					handle: partner?.handle ?? null,
					displayName: partner?.display_name ?? 'Player',
				},
				exists: false,
			},
		}, 200);
	}
	const partnerId = outcome.side === 'lo' ? outcome.conv.memberHi : outcome.conv.memberLo;
	const partner = await resolved.db.prepare('SELECT handle, display_name FROM game_players WHERE id = ?1 LIMIT 1')
		.bind(partnerId).first<{ handle: string | null; display_name: string }>();
	return resolved.finish({
		conversation: {
			id: outcome.conv.id,
			mySide: outcome.side,
			partner: {
				handle: partner?.handle ?? null,
				displayName: partner?.display_name ?? 'Player',
			},
			exists: true,
		},
	}, 200);
}
