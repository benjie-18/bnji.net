/**
 * BNJI.NET — chat plan Phase D: shared guards for the /api/dm/* routes
 * (plan §10: every route is `prerender = false`, same-origin on mutations,
 * bounded bodies, explicit error vocabulary, `no-store` on anything private).
 *
 * One place decides "may this account use DMs right now": feature switches
 * (plan §14 rollback), the Phase C chat ban extended to DM sends (owner
 * answer 2026-09-30: the §12.5 gate includes the existing ban path), and the
 * D1-backed per-account rate budgets of plan §7.5 (never KV — §11).
 */
import type { APIContext } from 'astro';
import { DM_CONFIG } from '../config/dm.config';
import { serverEnvironment } from './env';
import type { D1Database } from './game-store';
import { activeChatBan } from './chat-moderation';
import { appendPlayerCookies, PlayerContextStorageError, resolvePlayerContext, type PlayerContext } from './player-context';
import { reserveAuthAttempt, sha256Hex } from './player-store';
import { isValidHandle } from './display-name';
import {
	ensureConversation, getConversation, sideOf, type ConversationRow,
} from './dm-store';
import type { DmSide } from './dm-protocol';
import { FRIENDS_CONFIG } from '../config/friends.config';
import { friendGateState } from './friend-store';

export function dmJson(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

export function dmOriginAllowed(request: Request): boolean {
	const origin = request.headers.get('origin');
	return Boolean(origin && origin === new URL(request.url).origin);
}

export type DmRouteContext = {
	db: D1Database;
	player: PlayerContext;
	finish: (data: unknown, status: number) => Response;
};

/** env → D1 → player context, with cookies preserved on every response. */
export async function resolveDmContext(context: APIContext, options: { origin?: 'required' } = {}): Promise<DmRouteContext | Response> {
	if (options.origin === 'required' && !dmOriginAllowed(context.request)) return dmJson({ error: 'origin_not_allowed' }, 403);
	const env = await serverEnvironment();
	const db = env.BOARD_DB as D1Database | undefined;
	if (!db || typeof db.prepare !== 'function') return dmJson({ error: 'storage_unconfigured' }, 503);
	let player: PlayerContext;
	try {
		player = await resolvePlayerContext(context.request, db);
	} catch (error) {
		return dmJson({ error: error instanceof PlayerContextStorageError ? 'storage_unavailable' : 'storage_unavailable' }, 503);
	}
	const finish = (data: unknown, status: number): Response => {
		const response = dmJson(data, status);
		appendPlayerCookies(response.headers, player);
		return response;
	};
	return { db, player, finish };
}

/** Phase E friends switch (plan §14 rollback for E). */
export function requireFriendsEnabled(context: DmRouteContext): Response | null {
	if (!FRIENDS_CONFIG.enabled) return context.finish({ error: 'friends_disabled' }, 403);
	return null;
}

/**
 * Phase E D7 gate: open/send/attachments are friends-only from E onwards
 * (owner answer on plan D7: "open between accounts now, tightens to
 * friends-only in E"). `blocked` answers when a block exists either way —
 * sharper copy than not_friends, never reveals who blocked (§8.1 keeps
 * blocks unlisted); plain not_friends otherwise. Reads, media and the
 * socket stay membership-gated (plan §8/§10) — existing conversations keep
 * working only if the pair is still friends; a block removes the
 * friendship, so sends die for BOTH sides as §8.1 requires.
 */
export async function requireDmFriendship(context: DmRouteContext, partnerId: string): Promise<Response | null> {
	if (!FRIENDS_CONFIG.enabled) return null;
	const playerId = context.player.playerId;
	if (!playerId || playerId === partnerId) return null;
	try {
		const state = await friendGateState(context.db, playerId, partnerId);
		if (state === 'blocked') return context.finish({ error: 'blocked' }, 403);
		if (state !== 'friends') return context.finish({ error: 'not_friends' }, 403);
	} catch {
		return context.finish({ error: 'storage_unavailable' }, 503);
	}
	return null;
}

/** Account-only product (plan §7.1): guests never get a conversation. */
export function requireDmAccount(context: DmRouteContext): Response | null {
	if (!context.player.playerId) return context.finish({ error: 'authentication_required' }, 401);
	return null;
}

/** Master switch (plan §14). */
export function requireDmEnabled(context: DmRouteContext): Response | null {
	if (!DM_CONFIG.enabled) return context.finish({ error: 'dm_disabled' }, 403);
	return null;
}

export function requireDmImagesEnabled(context: DmRouteContext): Response | null {
	if (!DM_CONFIG.images.enabled) return context.finish({ error: 'images_disabled' }, 403);
	return null;
}

/**
 * Phase C ban, now enforced on DMs too (owner answer 2026-09-30 — the block/
 * ban leg of plan §12.5). Same vocabulary as the room socket: 403
 * `chat_banned`. A D1 blip never blocks a join-side read (same tolerance as
 * the room `/ws` route).
 */
export async function requireDmNotBanned(context: DmRouteContext, options: { strict?: boolean } = {}): Promise<Response | null> {
	const playerId = context.player.playerId;
	if (!playerId) return null;
	try {
		const bannedUntil = await activeChatBan(context.db, await sha256Hex(`player:${playerId}`), Date.now());
		if (bannedUntil) return context.finish({ error: 'chat_banned', retryAfterMs: Math.max(1_000, bannedUntil - Date.now()) }, 403);
	} catch {
		if (options.strict) return context.finish({ error: 'storage_unavailable' }, 503);
	}
	return null;
}

/** Per-account D1 budget (plan §7.5, §12.4): reserveAuthAttempt with a dm prefix. */
export async function requireDmRate(context: DmRouteContext, kind: 'send' | 'image' | 'report' | 'ws'): Promise<Response | null> {
	const playerId = context.player.playerId;
	if (!playerId) return null;
	const limits = kind === 'send'
		? { windowMs: 60_000, maxAttempts: DM_CONFIG.rate.sendPerMinute }
		: kind === 'image'
			? { windowMs: 3_600_000, maxAttempts: DM_CONFIG.rate.uploadsPerHour }
			: kind === 'report'
				? { windowMs: DM_CONFIG.rate.reportWindowMs, maxAttempts: DM_CONFIG.rate.reportsPerWindow }
				: { windowMs: 60_000, maxAttempts: DM_CONFIG.rate.connectsPerMinute };
	try {
		const budget = await reserveAuthAttempt(context.db, await sha256Hex(`bnji-dm-${kind}:${playerId}`), Date.now(), limits);
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

const CONVERSATION_PATTERN = /^[a-f0-9]{64}$/;

export function isValidConversationId(value: unknown): value is string {
	return typeof value === 'string' && CONVERSATION_PATTERN.test(value);
}

/**
 * Resolve the conversation for a request: either an explicit id (membership
 * enforced — "a stranger must not read a conversation", plan §13) or a handle
 * (exact match only, D8), which derives the canonical pair digest without
 * needing a row to exist yet (§7.2 — no lookup race can fork the pair).
 */
export async function resolveDmConversation(db: D1Database, player: PlayerContext, payload: { conversation?: unknown; handle?: unknown }): Promise<
	{ ok: true; conv: ConversationRow; side: DmSide } | { ok: false; error: string; status: number }
> {
	const playerId = player.playerId;
	if (!playerId) return { ok: false, error: 'authentication_required', status: 401 };
	if (payload.conversation !== undefined) {
		if (!isValidConversationId(payload.conversation)) return { ok: false, error: 'invalid_payload', status: 400 };
		const conv = await getConversation(db, payload.conversation);
		if (!conv) return { ok: false, error: 'conversation_not_found', status: 404 };
		const side = sideOf(conv, playerId);
		if (!side) return { ok: false, error: 'not_a_member', status: 403 };
		return { ok: true, conv, side };
	}
	if (typeof payload.handle !== 'string' || !isValidHandle(payload.handle)) return { ok: false, error: 'invalid_handle', status: 400 };
	const partner = await db.prepare('SELECT id FROM game_players WHERE handle = ?1 LIMIT 1').bind(payload.handle).first<{ id: string }>();
	if (!partner) return { ok: false, error: 'handle_not_found', status: 404 };
	if (partner.id === playerId) return { ok: false, error: 'self_conversation', status: 403 };
	const conv = await ensureConversation(db, playerId, String(partner.id));
	const side = sideOf(conv, playerId);
	if (!side) return { ok: false, error: 'not_a_member', status: 403 };
	return { ok: true, conv, side };
}
