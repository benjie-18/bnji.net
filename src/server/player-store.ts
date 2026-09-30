/** Global game identity, opaque sessions, save CAS, and account lifecycle. */
import { accountModerationStatements } from './chat-moderation';
import type { D1Database } from './game-store';

export const PLAYER_SESSION_COOKIE = 'bnji_ga';
export const PLAYER_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const PLAYER_SAVE_MAX_BYTES = 16 * 1024;
export const PLAYER_SAVE_MAX_SLOTS = 25;
export const PLAYER_SAVE_MAX_SCHEMA_VERSION = 10_000;
export const PLAYER_SESSION_MAX_ACTIVE = 10;
const AUTH_WINDOW_MS = 15 * 60_000;
const AUTH_MAX_ATTEMPTS = 8;

export type PlayerRow = { id: string; display_name: string };
export type SaveRow = {
	game_id: string; slot_id: string; schema_version: number; revision: number; data_json: string; updated_at: number;
};

function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}
function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
export function generatePlayerId(): string { return bytesToHex(randomBytes(16)); }
export function generatePlayerSessionToken(): string { return bytesToBase64Url(randomBytes(32)); }
export function generateRecoveryCode(): string {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let buffer = 0;
	let bits = 0;
	let encoded = '';
	for (const byte of randomBytes(20)) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			encoded += alphabet[(buffer >>> bits) & 31];
		}
	}
	return `BNJI-${encoded}`;
}
export function validPlayerSessionToken(token: unknown): token is string {
	return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
}
export function normalizeRecoveryCode(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, (match) => match.includes('-') ? '-' : '');
	return /^BNJI-[A-HJ-NP-Z2-9]{32}$/.test(normalized) ? normalized : null;
}
export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return bytesToHex(new Uint8Array(digest));
}

export function playerSessionCookie(token: string): string {
	return `${PLAYER_SESSION_COOKIE}=${token}; Path=/; Max-Age=${PLAYER_SESSION_TTL_SECONDS}; SameSite=Lax; Secure; HttpOnly`;
}
export function clearPlayerSessionCookie(): string {
	return `${PLAYER_SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly`;
}

export async function readPlayerBySessionHash(db: D1Database, tokenHash: string, now = Date.now()): Promise<PlayerRow | null> {
	return db.prepare(
		`SELECT p.id, p.display_name FROM game_player_sessions s
		 JOIN game_players p ON p.id = s.player_id
		 WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND s.revoked_at IS NULL LIMIT 1`,
	).bind(tokenHash, now).first<PlayerRow>();
}

/**
 * One shared, increment-only per-IP attempt counter (game_auth_attempts).
 * Defaults to the login window (15 min / 8 attempts); callers outside the
 * login flow — handle claim and handle search (chat plan Phase A) — pass
 * their own limits from NAMES_CONFIG with a distinguishable ip_hash prefix
 * so spaces cannot spend each other's budget.
 */
export async function reserveAuthAttempt(
	db: D1Database,
	ipHash: string,
	now = Date.now(),
	limits?: { windowMs?: number; maxAttempts?: number },
): Promise<{ allowed: boolean; retryAfter: number }> {
	const windowMs = limits?.windowMs ?? AUTH_WINDOW_MS;
	const maxAttempts = limits?.maxAttempts ?? AUTH_MAX_ATTEMPTS;
	const windowStart = now - windowMs;
	const row = await db.prepare(
		`INSERT INTO game_auth_attempts (ip_hash, window_started_at, attempts, updated_at)
		 VALUES (?1, ?2, 1, ?2)
		 ON CONFLICT(ip_hash) DO UPDATE SET
		   window_started_at = CASE WHEN game_auth_attempts.window_started_at <= ?3 THEN excluded.window_started_at ELSE game_auth_attempts.window_started_at END,
		   attempts = CASE WHEN game_auth_attempts.window_started_at <= ?3 THEN 1 ELSE MIN(1000, game_auth_attempts.attempts + 1) END,
		   updated_at = excluded.updated_at
		 RETURNING attempts, window_started_at`,
	).bind(ipHash, now, windowStart).first<{ attempts: number; window_started_at: number }>();
	if (!row) throw new Error('auth_attempt_counter_unavailable');
	if (Number(row.attempts) <= maxAttempts) return { allowed: true, retryAfter: 0 };
	return { allowed: false, retryAfter: Math.max(1, Math.ceil((Number(row.window_started_at) + windowMs - now) / 1000)) };
}

export async function checkPlayerLoginLockout(db: D1Database, ipHash: string, now = Date.now()): Promise<{ locked: boolean; retryAfter: number }> {
	const row = await db.prepare('SELECT attempts, window_started_at FROM game_auth_attempts WHERE ip_hash = ?1 LIMIT 1')
		.bind(ipHash).first<{ attempts: number; window_started_at: number }>();
	if (!row || Number(row.window_started_at) <= now - AUTH_WINDOW_MS || Number(row.attempts) < AUTH_MAX_ATTEMPTS) return { locked: false, retryAfter: 0 };
	return { locked: true, retryAfter: Math.max(1, Math.ceil((Number(row.window_started_at) + AUTH_WINDOW_MS - now) / 1000)) };
}

export async function recordPlayerLoginFailure(db: D1Database, ipHash: string, now = Date.now()): Promise<{ locked: boolean; retryAfter: number }> {
	const row = await db.prepare(
		`INSERT INTO game_auth_attempts (ip_hash, window_started_at, attempts, updated_at) VALUES (?1, ?2, 1, ?2)
		 ON CONFLICT(ip_hash) DO UPDATE SET
		   window_started_at = CASE WHEN game_auth_attempts.window_started_at <= ?3 THEN excluded.window_started_at ELSE game_auth_attempts.window_started_at END,
		   attempts = CASE WHEN game_auth_attempts.window_started_at <= ?3 THEN 1 ELSE MIN(1000, game_auth_attempts.attempts + 1) END,
		   updated_at = excluded.updated_at
		 RETURNING attempts, window_started_at`,
	).bind(ipHash, now, now - AUTH_WINDOW_MS).first<{ attempts: number; window_started_at: number }>();
	if (!row) throw new Error('auth_failure_counter_unavailable');
	const locked = Number(row.attempts) >= AUTH_MAX_ATTEMPTS;
	return { locked, retryAfter: locked ? Math.max(1, Math.ceil((Number(row.window_started_at) + AUTH_WINDOW_MS - now) / 1000)) : 0 };
}
export async function clearPlayerLoginFailures(db: D1Database, ipHash: string): Promise<void> {
	await db.prepare('DELETE FROM game_auth_attempts WHERE ip_hash = ?1').bind(ipHash).run();
}

/** Create the one-time recovery credential and claim only this validated guest session's history. */
export async function createPlayerAccount(db: D1Database, input: {
	playerId: string; recoveryHash: string; displayName: string; sessionHash: string; now: number; guestSessionId: string;
}): Promise<void> {
	if (!db.batch) throw new Error('atomic_player_batch_unavailable');
	await db.batch([
		db.prepare('INSERT INTO game_players (id, recovery_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)')
			.bind(input.playerId, input.recoveryHash, input.displayName, input.now),
		db.prepare('INSERT INTO game_player_sessions (token_hash, player_id, created_at, expires_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?3)')
			.bind(input.sessionHash, input.playerId, input.now, input.now + PLAYER_SESSION_TTL_SECONDS * 1000),
		db.prepare('UPDATE game_sessions SET player_id = ?1 WHERE session_id = ?2 AND player_id IS NULL')
			.bind(input.playerId, input.guestSessionId),
		db.prepare('UPDATE game_scores SET player_id = ?1 WHERE session_id = ?2 AND player_id IS NULL')
			.bind(input.playerId, input.guestSessionId),
	]);
}

/** Sign in with the recovery credential; linking is again restricted to the current guest cookie. */
export async function signInPlayer(db: D1Database, input: {
	recoveryHash: string; sessionHash: string; now: number; guestSessionId: string;
}): Promise<PlayerRow | null> {
	const player = await db.prepare('SELECT id, display_name FROM game_players WHERE recovery_hash = ?1 LIMIT 1')
		.bind(input.recoveryHash).first<PlayerRow>();
	if (!player) return null;
	if (!db.batch) throw new Error('atomic_player_batch_unavailable');
	await db.batch([
		db.prepare('DELETE FROM game_player_sessions WHERE player_id = ?1 AND (revoked_at IS NOT NULL OR expires_at <= ?2)')
			.bind(player.id, input.now),
		db.prepare('INSERT INTO game_player_sessions (token_hash, player_id, created_at, expires_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?3)')
			.bind(input.sessionHash, player.id, input.now, input.now + PLAYER_SESSION_TTL_SECONDS * 1000),
		db.prepare(
			`DELETE FROM game_player_sessions WHERE player_id = ?1 AND token_hash NOT IN (
			 SELECT token_hash FROM game_player_sessions WHERE player_id = ?1
			 ORDER BY (token_hash = ?2) DESC, last_seen_at DESC LIMIT ?3
			)`,
		).bind(player.id, input.sessionHash, PLAYER_SESSION_MAX_ACTIVE),
		db.prepare('UPDATE game_player_sessions SET last_seen_at = ?1 WHERE token_hash = ?2 AND revoked_at IS NULL')
			.bind(input.now, input.sessionHash),
		db.prepare('UPDATE game_sessions SET player_id = ?1 WHERE session_id = ?2 AND player_id IS NULL')
			.bind(player.id, input.guestSessionId),
		db.prepare('UPDATE game_scores SET player_id = ?1 WHERE session_id = ?2 AND player_id IS NULL')
			.bind(player.id, input.guestSessionId),
	]);
	return player;
}

export async function rotateRecoveryCode(db: D1Database, input: {
	playerId: string; recoveryHash: string; activeSessionHash: string; now: number;
}): Promise<void> {
	if (!db.batch) throw new Error('atomic_player_batch_unavailable');
	await db.batch([
		db.prepare('UPDATE game_players SET recovery_hash = ?1, updated_at = ?2 WHERE id = ?3')
			.bind(input.recoveryHash, input.now, input.playerId),
		db.prepare('DELETE FROM game_player_sessions WHERE player_id = ?1 AND token_hash <> ?2')
			.bind(input.playerId, input.activeSessionHash),
		db.prepare('UPDATE game_player_sessions SET last_seen_at = ?1 WHERE token_hash = ?2 AND player_id = ?3 AND revoked_at IS NULL')
			.bind(input.now, input.activeSessionHash, input.playerId),
	]);
}

export async function revokePlayerSession(db: D1Database, sessionHash: string, now = Date.now()): Promise<void> {
	await db.prepare('UPDATE game_player_sessions SET revoked_at = ?1 WHERE token_hash = ?2 AND revoked_at IS NULL')
		.bind(now, sessionHash).run();
}

export async function deletePlayerAccount(db: D1Database, playerId: string): Promise<void> {
	if (!db.batch) throw new Error('atomic_player_batch_unavailable');
	// Chat plan Phase C (§9.5): reported content, filed reports, chat bans and
	// owned room-registry rows hang off the account's room principal.
	const principalHash = await sha256Hex(`player:${playerId}`);
	await db.batch([
		db.prepare('DELETE FROM game_scores WHERE player_id = ?1').bind(playerId),
		db.prepare('DELETE FROM game_sessions WHERE player_id = ?1').bind(playerId),
		db.prepare('DELETE FROM game_players WHERE id = ?1').bind(playerId),
		...accountModerationStatements(db, principalHash),
	]);
}

export async function readPlayerSaves(db: D1Database, playerId: string): Promise<SaveRow[]> {
	const result = await db.prepare(
		`SELECT game_id, slot_id, schema_version, revision, data_json, updated_at
		 FROM game_saves WHERE player_id = ?1 ORDER BY updated_at DESC, game_id, slot_id LIMIT ?2`,
	).bind(playerId, PLAYER_SAVE_MAX_SLOTS).all<SaveRow>();
	return result.results;
}

export async function writePlayerSave(db: D1Database, input: {
	playerId: string; gameId: string; slotId: string; schemaVersion: number; dataJson: string; expectedRevision: number | null; now: number;
}): Promise<{ kind: 'saved'; revision: number; updatedAt: number } | { kind: 'conflict'; current: SaveRow | null } | { kind: 'limit' }> {
	const expected = input.expectedRevision ?? 0;
	const row = await db.prepare(
		`INSERT INTO game_saves (player_id, game_id, slot_id, schema_version, revision, data_json, updated_at)
		 SELECT ?1, ?2, ?3, ?4, 1, ?5, ?6
		 WHERE EXISTS (SELECT 1 FROM game_saves WHERE player_id = ?1 AND game_id = ?2 AND slot_id = ?3)
		    OR (SELECT COUNT(*) FROM game_saves WHERE player_id = ?1) < ?7
		 ON CONFLICT(player_id, game_id, slot_id) DO UPDATE SET
		   schema_version = excluded.schema_version,
		   revision = game_saves.revision + 1,
		   data_json = excluded.data_json,
		   updated_at = excluded.updated_at
		 WHERE game_saves.revision = ?8
		 RETURNING revision, updated_at`,
	).bind(input.playerId, input.gameId, input.slotId, input.schemaVersion, input.dataJson, input.now, PLAYER_SAVE_MAX_SLOTS, expected)
		.first<{ revision: number; updated_at: number }>();
	if (row) return { kind: 'saved', revision: Number(row.revision), updatedAt: Number(row.updated_at) };
	const existing = await db.prepare(
		'SELECT game_id, slot_id, schema_version, revision, data_json, updated_at FROM game_saves WHERE player_id = ?1 AND game_id = ?2 AND slot_id = ?3 LIMIT 1',
	).bind(input.playerId, input.gameId, input.slotId).first<SaveRow>();
	if (!existing && input.expectedRevision === null) {
		const count = await db.prepare('SELECT COUNT(*) AS count FROM game_saves WHERE player_id = ?1').bind(input.playerId).first<{ count: number }>();
		if (Number(count?.count ?? 0) >= PLAYER_SAVE_MAX_SLOTS) return { kind: 'limit' };
	}
	return { kind: 'conflict', current: existing };
}

export async function deletePlayerSave(db: D1Database, input: {
	playerId: string; gameId: string; slotId: string; expectedRevision: number;
}): Promise<boolean> {
	const result = await db.prepare(
		'DELETE FROM game_saves WHERE player_id = ?1 AND game_id = ?2 AND slot_id = ?3 AND revision = ?4',
	).bind(input.playerId, input.gameId, input.slotId, input.expectedRevision).run();
	if ((result.meta?.changes ?? 0) > 0) return true;
	const current = await db.prepare(
		'SELECT 1 AS found FROM game_saves WHERE player_id = ?1 AND game_id = ?2 AND slot_id = ?3 LIMIT 1',
	).bind(input.playerId, input.gameId, input.slotId).first<{ found: number }>();
	return current === null;
}

export async function readPlayerAdminSummary(db: D1Database, now = Date.now()): Promise<{
	players: number; activeSessions: number; saveBlobs: number; saveBytes: number;
}> {
	const row = await db.prepare(
		`SELECT
		 (SELECT COUNT(*) FROM game_players) AS players,
		 (SELECT COUNT(*) FROM game_player_sessions WHERE revoked_at IS NULL AND expires_at > ?1) AS active_sessions,
		 (SELECT COUNT(*) FROM game_saves) AS save_blobs,
		 (SELECT COALESCE(SUM(length(CAST(data_json AS BLOB))), 0) FROM game_saves) AS save_bytes`,
	).bind(now).first<{ players: number; active_sessions: number; save_blobs: number; save_bytes: number }>();
	return {
		players: Number(row?.players ?? 0), activeSessions: Number(row?.active_sessions ?? 0),
		saveBlobs: Number(row?.save_blobs ?? 0), saveBytes: Number(row?.save_bytes ?? 0),
	};
}

export function validateSaveData(value: unknown): { ok: true; json: string } | { ok: false; error: string } {
	let json: string;
	try { json = JSON.stringify(value); } catch { return { ok: false, error: 'invalid_save_data' }; }
	if (json === undefined) return { ok: false, error: 'invalid_save_data' };
	if (new TextEncoder().encode(json).byteLength > PLAYER_SAVE_MAX_BYTES) return { ok: false, error: 'save_too_large' };
	let nodes = 0;
	const visit = (item: unknown, depth: number): boolean => {
		if (++nodes > 2_000 || depth > 16) return false;
		if (item === null || typeof item === 'string' || typeof item === 'boolean') return true;
		if (typeof item === 'number') return Number.isFinite(item);
		if (Array.isArray(item)) return item.every((child) => visit(child, depth + 1));
		if (typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
			return Object.entries(item as Record<string, unknown>).every(([key, child]) => key.length <= 128 && visit(child, depth + 1));
		}
		return false;
	};
	if (!visit(value, 0)) return { ok: false, error: 'invalid_save_data' };
	return { ok: true, json };
}

export type SetHandleResult =
	| { ok: true; handle: string }
	| { ok: false; error: 'handle_taken' | 'handle_cooldown'; retryAfter: number };

/**
 * Claim or change the one global account handle (chat plan Phase A).
 * Rules, in order:
 *   - idempotent re-submit of the owned handle always succeeds (and must not
 *     restart the cooldown clock — otherwise the clock is meaningless);
 *   - first claim (handle NULL) is never cooldown-blocked;
 *   - a different handle inside cooldownDays is refused with retryAfter;
 *   - uniqueness is pre-checked for a friendly error, and the UNIQUE index on
 *     game_players(handle) is the final arbiter if two accounts race.
 * Format validation (isValidHandle) happens at the route, before this call.
 */
export async function setPlayerHandle(
	db: D1Database,
	input: { playerId: string; handle: string; now: number; cooldownDays: number },
): Promise<SetHandleResult> {
	const current = await db.prepare(
		'SELECT handle, handle_changed_at FROM game_players WHERE id = ?1 LIMIT 1',
	).bind(input.playerId).first<{ handle: string | null; handle_changed_at: number | null }>();
	if (!current) throw new Error('player_not_found');
	if (current.handle === input.handle) return { ok: true, handle: input.handle };
	const changedAt = current.handle_changed_at === null ? null : Number(current.handle_changed_at);
	const cooldownMs = input.cooldownDays * 86_400_000;
	if (changedAt !== null && input.now < changedAt + cooldownMs) {
		return { ok: false, error: 'handle_cooldown', retryAfter: Math.max(1, Math.ceil((changedAt + cooldownMs - input.now) / 1000)) };
	}
	const taken = await db.prepare(
		'SELECT 1 AS present FROM game_players WHERE handle = ?1 AND id <> ?2 LIMIT 1',
	).bind(input.handle, input.playerId).first<{ present: number }>();
	if (taken) return { ok: false, error: 'handle_taken', retryAfter: 0 };
	try {
		const update = await db.prepare(
			'UPDATE game_players SET handle = ?1, handle_changed_at = ?2, updated_at = ?2 WHERE id = ?3',
		).bind(input.handle, input.now, input.playerId).run();
		// Zero rows means the account vanished between the read and the write —
		// that is a storage error, not a successful claim.
		if (Number(update?.meta?.changes ?? 0) === 0) throw new Error('player_not_found');
	} catch (error) {
		// Lost a race to the UNIQUE index → taken; anything else is storage.
		if (/unique|constraint/i.test(String(error))) return { ok: false, error: 'handle_taken', retryAfter: 0 };
		throw error;
	}
	return { ok: true, handle: input.handle };
}

/** Exact-match handle lookup for discovery (chat plan §4: no directory, no prefix search). */
export async function findPlayerByHandle(
	db: D1Database,
	handle: string,
): Promise<{ handle: string; display_name: string } | null> {
	const row = await db.prepare(
		'SELECT handle, display_name FROM game_players WHERE handle = ?1 LIMIT 1',
	).bind(handle).first<{ handle: string; display_name: string }>();
	return row ?? null;
}

export const PLAYER_AUTH_WINDOW_MS = AUTH_WINDOW_MS;
export const PLAYER_AUTH_MAX_ATTEMPTS = AUTH_MAX_ATTEMPTS;
