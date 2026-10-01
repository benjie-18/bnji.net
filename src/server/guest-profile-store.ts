/**
 * BNJI.NET — guest display names (chat plan Phase A, §4).
 *
 * A guest picks a label for this browser's session; it is keyed by the
 * SHA-256 digest of the bnji_ps session id so the raw session id never
 * reaches storage (same rule as every other table: hash at the seam).
 * The name outlives no session by more than NAMES_CONFIG.guestProfiles
 * retentionDays — the hourly retention sweep expires it (see
 * src/server/tracking-retention.ts).
 */
import type { D1Database } from './game-store';
import { sha256Hex } from './player-store';

export type GuestProfileRow = {
	display_name: string;
	created_at: number;
	updated_at: number;
};

/** Digest of the raw session id — the only form of the session this store stores. */
export async function guestProfileKey(sessionId: string): Promise<string> {
	return sha256Hex(sessionId);
}

export async function readGuestProfile(db: D1Database, sessionId: string): Promise<GuestProfileRow | null> {
	const sessionHash = await sha256Hex(sessionId);
	const row = await db.prepare(
		'SELECT display_name, created_at, updated_at FROM guest_profiles WHERE session_hash = ?1 LIMIT 1',
	).bind(sessionHash).first<GuestProfileRow>();
	return row ?? null;
}

export async function upsertGuestProfile(
	db: D1Database,
	input: { sessionId: string; displayName: string; now: number },
): Promise<void> {
	const sessionHash = await sha256Hex(input.sessionId);
	await db.prepare(
		`INSERT INTO guest_profiles (session_hash, display_name, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?3)
		 ON CONFLICT(session_hash) DO UPDATE SET
		   display_name = excluded.display_name,
		   updated_at = excluded.updated_at`,
	).bind(sessionHash, input.displayName, input.now).run();
}
