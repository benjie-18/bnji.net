/** Global player identity, one-time recovery credential, session controls, export and deletion. */
import type { APIContext } from 'astro';
import { exportFiledReports, exportReportsOnAccount, getChatBan } from '../../../server/chat-moderation';
import { exportDmData } from '../../../server/dm-store';
import { exportDmReportsFiled, exportDmReportsOnAccount } from '../../../server/dm-reports';
import { clientIp } from '../../../server/security-helpers';
import { readBodyTextBounded } from '../../../server/read-body';
import { serverEnvironment } from '../../../server/env';
import type { D1Database } from '../../../server/game-store';
import {
	clearPlayerSessionCookie,
	createPlayerAccount,
	deletePlayerAccount,
	generatePlayerId,
	generatePlayerSessionToken,
	generateRecoveryCode,
	normalizeRecoveryCode,
	playerSessionCookie,
	PLAYER_SESSION_TTL_SECONDS,
	readPlayerSaves,
	reserveAuthAttempt,
	checkPlayerLoginLockout,
	recordPlayerLoginFailure,
	clearPlayerLoginFailures,
	rotateRecoveryCode,
	signInPlayer,
	setPlayerHandle,
	sha256Hex,
	type PlayerRow,
} from '../../../server/player-store';
import { appendPlayerCookies, PlayerContextStorageError, resolvePlayerContext } from '../../../server/player-context';
import { isValidHandle, sanitizeDisplayName } from '../../../server/display-name';
import { NAMES_CONFIG } from '../../../config/names.config';

export const prerender = false;
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function json(data: unknown, status = 200, cookies: string[] = []): Response {
	const headers = new Headers(JSON_HEADERS);
	for (const cookie of cookies) headers.append('set-cookie', cookie);
	return new Response(JSON.stringify(data), { status, headers });
}
function dbBinding(value: unknown): D1Database | null {
	return value && typeof (value as D1Database).prepare === 'function' ? value as D1Database : null;
}
function allowedOrigin(request: Request): boolean {
	const origin = request.headers.get('origin');
	return Boolean(origin && origin === new URL(request.url).origin);
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

async function resolve(context: APIContext): Promise<{ db: D1Database; player: Awaited<ReturnType<typeof resolvePlayerContext>> } | Response> {
	const env = await serverEnvironment();
	const db = dbBinding(env.BOARD_DB);
	if (!db) return json({ error: 'storage_unavailable' }, 503);
	try {
		const player = await resolvePlayerContext(context.request, db);
		return { db, player };
	} catch (error) {
		if (error instanceof PlayerContextStorageError) return json({ error: 'storage_unavailable' }, 503);
		return json({ error: 'storage_unavailable' }, 503);
	}
}

function responseWithContext(data: unknown, status: number, player: Awaited<ReturnType<typeof resolvePlayerContext>>): Response {
	const response = json(data, status);
	appendPlayerCookies(response.headers, player);
	return response;
}

export async function GET(context: APIContext): Promise<Response> {
	const resolved = await resolve(context);
	if (resolved instanceof Response) return resolved;
	const { db, player } = resolved;
	const saves = player.playerId ? await readPlayerSaves(db, player.playerId).catch(() => null) : null;
	if (player.playerId && !saves) return responseWithContext({ error: 'storage_unavailable' }, 503, player);
	let identity: PlayerRow & { handle?: string | null } | null = null;
	if (player.playerId) {
		try {
			identity = await db.prepare('SELECT id, display_name, handle FROM game_players WHERE id = ?1 LIMIT 1')
				.bind(player.playerId).first<PlayerRow & { handle: string | null }>();
		} catch { return responseWithContext({ error: 'storage_unavailable' }, 503, player); }
	}
	return responseWithContext({
		authenticated: Boolean(identity),
		...(identity ? { displayName: identity.display_name, saveCount: saves!.length, handle: identity.handle ?? null } : {}),
	}, 200, player);
}

export async function POST(context: APIContext): Promise<Response> {
	if (!allowedOrigin(context.request)) return json({ error: 'origin_not_allowed' }, 403);
	const resolved = await resolve(context);
	if (resolved instanceof Response) return resolved;
	const { db, player } = resolved;
	const text = await readBodyTextBounded(context.request, 2048);
	if (text === null) return responseWithContext({ error: 'payload_too_large' }, 413, player);
	let body: unknown;
	try { body = JSON.parse(text || '{}'); } catch { return responseWithContext({ error: 'invalid_json' }, 400, player); }
	if (!isRecord(body) || typeof body.action !== 'string') return responseWithContext({ error: 'invalid_payload' }, 400, player);
	const now = Date.now();

	if (body.action === 'create') {
		if (!hasOnlyKeys(body, ['action', 'displayName'])) return responseWithContext({ error: 'invalid_payload' }, 400, player);
		const created = sanitizeDisplayName(body.displayName);
		if (!created.ok) return responseWithContext({ error: created.error }, 400, player);
		const name = created.name;
		if (player.playerId) return responseWithContext({ error: 'already_authenticated' }, 409, player);
		try {
			const ipHash = await sha256Hex(`bnji-game-create:${clientIp(context.request)}`);
			const attempt = await reserveAuthAttempt(db, ipHash, now);
			if (!attempt.allowed) {
				const response = responseWithContext({ error: 'login_locked', retryAfter: attempt.retryAfter }, 429, player);
				response.headers.set('retry-after', String(attempt.retryAfter));
				return response;
			}
		} catch { return responseWithContext({ error: 'storage_unavailable' }, 503, player); }
		const recoveryCode = generateRecoveryCode();
		const token = generatePlayerSessionToken();
		try {
			await createPlayerAccount(db, {
				playerId: generatePlayerId(), recoveryHash: await sha256Hex(recoveryCode), displayName: name,
				sessionHash: await sha256Hex(token), now, guestSessionId: player.sessionId,
			});
			const response = responseWithContext({ authenticated: true, displayName: name, recoveryCode, recoveryCodeDisplayedOnce: true }, 201, player);
			response.headers.append('set-cookie', playerSessionCookie(token));
			return response;
		} catch { return responseWithContext({ error: 'account_creation_failed' }, 503, player); }
	}

	if (body.action === 'login') {
		if (!hasOnlyKeys(body, ['action', 'recoveryCode'])) return responseWithContext({ error: 'invalid_payload' }, 400, player);
		if (player.playerId) return responseWithContext({ error: 'already_authenticated' }, 409, player);
		const recoveryCode = normalizeRecoveryCode(body.recoveryCode);
		if (!recoveryCode) return responseWithContext({ error: 'invalid_recovery_code' }, 401, player);
		try {
			const ipHash = await sha256Hex(`bnji-game-login:${clientIp(context.request)}`);
			const lockout = await checkPlayerLoginLockout(db, ipHash, now);
			if (lockout.locked) {
				const response = responseWithContext({ error: 'login_locked', retryAfter: lockout.retryAfter }, 429, player);
				response.headers.set('retry-after', String(lockout.retryAfter));
				return response;
			}
			const token = generatePlayerSessionToken();
			const account = await signInPlayer(db, {
				recoveryHash: await sha256Hex(recoveryCode), sessionHash: await sha256Hex(token), now, guestSessionId: player.sessionId,
			});
			if (!account) {
				const failure = await recordPlayerLoginFailure(db, ipHash, now);
				if (failure.locked) {
					const response = responseWithContext({ error: 'login_locked', retryAfter: failure.retryAfter }, 429, player);
					response.headers.set('retry-after', String(failure.retryAfter));
					return response;
				}
				return responseWithContext({ error: 'invalid_recovery_code' }, 401, player);
			}
			await clearPlayerLoginFailures(db, ipHash);
			const response = responseWithContext({ authenticated: true, displayName: account.display_name }, 200, player);
			response.headers.append('set-cookie', playerSessionCookie(token));
			return response;
		} catch { return responseWithContext({ error: 'storage_unavailable' }, 503, player); }
	}

	if (body.action === 'sign-out') {
		if (!hasOnlyKeys(body, ['action'])) return responseWithContext({ error: 'invalid_payload' }, 400, player);
		if (!player.playerId || !player.authSessionHash) return responseWithContext({ error: 'authentication_required' }, 401, player);
		try {
			await db.prepare('UPDATE game_player_sessions SET revoked_at = ?1 WHERE token_hash = ?2 AND revoked_at IS NULL')
				.bind(now, player.authSessionHash).run();
			const response = responseWithContext({ authenticated: false }, 200, player);
			response.headers.append('set-cookie', clearPlayerSessionCookie());
			return response;
		} catch { return responseWithContext({ error: 'storage_unavailable' }, 503, player); }
	}

	if (body.action === 'rotate-recovery-code') {
		if (!hasOnlyKeys(body, ['action'])) return responseWithContext({ error: 'invalid_payload' }, 400, player);
		if (!player.playerId || !player.authSessionHash) return responseWithContext({ error: 'authentication_required' }, 401, player);
		const recoveryCode = generateRecoveryCode();
		try {
			await rotateRecoveryCode(db, {
				playerId: player.playerId, recoveryHash: await sha256Hex(recoveryCode), activeSessionHash: player.authSessionHash, now,
			});
			return responseWithContext({ recoveryCode, recoveryCodeDisplayedOnce: true }, 200, player);
		} catch { return responseWithContext({ error: 'recovery_rotation_failed' }, 503, player); }
	}

	if (body.action === 'rename') {
		if (!player.playerId) return responseWithContext({ error: 'authentication_required' }, 401, player);
		const renamed = sanitizeDisplayName(body.displayName);
		if (!renamed.ok) return responseWithContext({ error: renamed.error }, 400, player);
		try {
			await db.prepare('UPDATE game_players SET display_name = ?1, updated_at = ?2 WHERE id = ?3')
				.bind(renamed.name, now, player.playerId).run();
			return responseWithContext({ displayName: renamed.name }, 200, player);
		} catch { return responseWithContext({ error: 'storage_unavailable' }, 503, player); }
	}

	if (body.action === 'set-handle') {
		// One global handle per account, exact-match discovery only (chat plan Phase A).
		if (!hasOnlyKeys(body, ['action', 'handle'])) return responseWithContext({ error: 'invalid_payload' }, 400, player);
		if (!player.playerId) return responseWithContext({ error: 'authentication_required' }, 401, player);
		const handle = typeof body.handle === 'string' ? body.handle.trim().toLowerCase() : null;
		if (!handle || !isValidHandle(handle)) return responseWithContext({ error: 'invalid_handle' }, 400, player);
		try {
			const ipHash = await sha256Hex(`bnji-handle-claim:${clientIp(context.request)}`);
			const attempt = await reserveAuthAttempt(db, ipHash, now, {
				windowMs: NAMES_CONFIG.limits.handleAttemptWindowMs,
				maxAttempts: NAMES_CONFIG.limits.handleAttemptMax,
			});
			if (!attempt.allowed) {
				const response = responseWithContext({ error: 'rate_limited', retryAfter: attempt.retryAfter }, 429, player);
				response.headers.set('retry-after', String(attempt.retryAfter));
				return response;
			}
		} catch { return responseWithContext({ error: 'storage_unavailable' }, 503, player); }
		try {
			const result = await setPlayerHandle(db, {
				playerId: player.playerId, handle, now, cooldownDays: NAMES_CONFIG.handle.changeCooldownDays,
			});
			if (result.ok) return responseWithContext({ handle: result.handle }, 200, player);
			if (result.error === 'handle_cooldown') {
				const response = responseWithContext({ error: 'handle_cooldown', retryAfter: result.retryAfter }, 429, player);
				response.headers.set('retry-after', String(result.retryAfter));
				return response;
			}
			return responseWithContext({ error: 'handle_taken' }, 409, player);
		} catch { return responseWithContext({ error: 'storage_unavailable' }, 503, player); }
	}

	return responseWithContext({ error: 'unknown_action' }, 400, player);
}

export async function DELETE(context: APIContext): Promise<Response> {
	if (!allowedOrigin(context.request)) return json({ error: 'origin_not_allowed' }, 403);
	const resolved = await resolve(context);
	if (resolved instanceof Response) return resolved;
	const { db, player } = resolved;
	if (!player.playerId) return responseWithContext({ error: 'authentication_required' }, 401, player);
	const text = await readBodyTextBounded(context.request, 512);
	if (text === null) return responseWithContext({ error: 'payload_too_large' }, 413, player);
	let body: unknown;
	try { body = JSON.parse(text || '{}'); } catch { return responseWithContext({ error: 'invalid_json' }, 400, player); }
	if (!isRecord(body) || !hasOnlyKeys(body, ['confirmation']) || body.confirmation !== 'DELETE') return responseWithContext({ error: 'confirmation_required' }, 400, player);
	try {
		await deletePlayerAccount(db, player.playerId);
		const response = responseWithContext({ deleted: true, localSavesKept: true }, 200, player);
		response.headers.append('set-cookie', clearPlayerSessionCookie());
		return response;
	} catch { return responseWithContext({ error: 'account_delete_failed' }, 503, player); }
}

export async function exportAccount(context: APIContext): Promise<Response> {
	const resolved = await resolve(context);
	if (resolved instanceof Response) return resolved;
	const { db, player } = resolved;
	if (!player.playerId) return responseWithContext({ error: 'authentication_required' }, 401, player);
	try {
		const principalHash = await sha256Hex(`player:${player.playerId}`);
		const [identity, saves, scores, reportsOnMe, reportsFiled, ban, dms, dmReportsOnMe, dmReportsFiled] = await Promise.all([
			db.prepare('SELECT display_name, handle, created_at FROM game_players WHERE id = ?1 LIMIT 1').bind(player.playerId)
				.first<{ display_name: string; handle: string | null; created_at: number }>(),
			readPlayerSaves(db, player.playerId),
			db.prepare(
				`SELECT game_id, mode_id, score, tie_break, achieved_at, display_name, validation_state
				 FROM game_scores WHERE player_id = ?1 ORDER BY achieved_at DESC LIMIT 2500`,
			).bind(player.playerId).all<Record<string, unknown>>(),
			exportReportsOnAccount(db, principalHash),
			exportFiledReports(db, principalHash),
			getChatBan(db, principalHash),
			exportDmData(db, player.playerId),
			exportDmReportsOnAccount(db, principalHash),
			exportDmReportsFiled(db, principalHash),
		]);
		if (!identity) return responseWithContext({ error: 'authentication_required' }, 401, player);
		const data = {
			format: 'bnji.game-account-export', version: 1, exportedAt: new Date().toISOString(),
			account: { displayName: identity.display_name, handle: identity.handle ?? null, createdAt: Number(identity.created_at) },
			// Room chat (chat plan Phase B) is deliberately explicit, never silent:
			// its tables live inside ephemeral per-room Durable Objects, keyed to
			// the room rather than to this account (a hashed principal is the only
			// link; the Phase C registry lists rooms but no member→room index
			// exists), so live room text cannot be gathered here — and it cannot
			// outlive its room's ≤2 h lifetime anyway. What moderation DOES hold
			// in D1 — reported content, filed reports, bans — is exported below.
			// See docs/DATA.md §11 and CHAT-SYSTEM-PLAN.md §9.5.
			roomChat: {
				included: false,
				reason: 'Room chat lives at most 2 hours inside individual room instances. It is keyed to rooms, not to this account, and is deleted with its room — so it is never part of this export.',
			},
			chatModeration: {
				reportsOnYourMessages: reportsOnMe.map((row) => ({
					roomCode: row.roomCode, messageN: row.messageN, label: row.label, text: row.text,
					messageAt: row.messageAt, reportCount: row.reportCount, reportedAt: row.reportedAt, status: row.status,
				})),
				reportsYouFiled: reportsFiled,
				ban: ban ? { reason: ban.reason, createdAt: ban.createdAt, expiresAt: ban.expiresAt } : null,
			},
			// Phase D (plan §9.5): DMs ARE account-linked, so they export in
			// full — conversations, history, attachment bytes (bounded), and
			// both directions of DM report evidence. Sender identity is me/them;
			// partners appear as handle + display label only, never a player ID.
			directMessages: {
				included: true,
				conversations: dms.conversations,
				messages: dms.messages,
				attachmentBytesIncluded: dms.attachmentBytesIncluded,
				attachmentBytesOmitted: dms.attachmentBytesOmitted,
				reportsOnYourMessages: dmReportsOnMe,
				reportsYouFiled: dmReportsFiled,
			},
			saves: saves.map((row) => ({ gameId: row.game_id, slotId: row.slot_id, schemaVersion: Number(row.schema_version), revision: Number(row.revision), data: JSON.parse(row.data_json), updatedAt: Number(row.updated_at) })),
			scores: scores.results.map((row) => ({ gameId: row.game_id, mode: row.mode_id, score: Number(row.score), tieBreak: row.tie_break === null ? null : Number(row.tie_break), achievedAt: Number(row.achieved_at), displayName: row.display_name, status: row.validation_state })),
		};
		const response = responseWithContext(data, 200, player);
		response.headers.set('content-disposition', 'attachment; filename="bnji-game-account-export.json"');
		return response;
	} catch { return responseWithContext({ error: 'export_failed' }, 503, player); }
}
