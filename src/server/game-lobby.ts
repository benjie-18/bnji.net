/**
 * BNJI.NET — open-lobby listing.
 *
 * A room lives in a Durable Object, addressed by its code. Nothing can
 * enumerate Durable Objects, so a lobby list has exactly two ingredients: the
 * D1 `room_registry` rows (which rooms were created and for which game) and a
 * live probe of each candidate DO (whether the room is still there, and how many
 * seats it has taken). Only the Worker can reach both, which is why this is a
 * server module and not a DO feature.
 *
 * Two failure directions, and they are not equally bad:
 *   - a room missing from the list is harmless — its code still works, and
 *     `room_registry` inserts are best-effort by design;
 *   - a room LISTED but not joinable is the bad one, because a player clicks
 *     it. So a probe that fails, times out, reports `live:false`, or reports a
 *     full room removes the row. The list is a claim of joinability, not a
 *     catalogue of everything that exists.
 */
import { LOBBY_CONFIG, type LobbyConfig } from '../config/lobby.config';
import type { D1Database } from './game-store';
import type { KvRateLimitStore } from './ratelimit';

export type LobbyRow = {
	roomCode: string;
	gameId: string;
	players: number;
	capacity: number;
	createdAt: number;
	expiresAt: number;
	revision: number;
};

export type LobbyList = {
	lobbies: LobbyRow[];
	/** True when more registry rows existed than the configured page size. */
	truncated: boolean;
	/** True when at least one candidate was dropped for not answering. */
	stale: boolean;
	checkedAt: number;
	refreshAfterSeconds: number;
};

export const LOBBY_CACHE_PREFIX = 'bnji-lobby:';
const CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * Candidate rooms for one game (or for every game when `gameId` is empty),
 * newest first. `expires_at > now` is part of the query rather than a filter
 * afterwards: an expired row is not a room, it is a row the hourly sweep has
 * not reached yet.
 */
export async function readRegistryRows(
	db: D1Database,
	gameId: string,
	now: number,
	limit: number,
): Promise<Array<{ code: string; game_id: string; created_at: number; expires_at: number }>> {
	const sql = gameId
		? 'SELECT code, game_id, created_at, expires_at FROM room_registry WHERE expires_at > ?1 AND game_id = ?2 ORDER BY created_at DESC LIMIT ?3'
		: 'SELECT code, game_id, created_at, expires_at FROM room_registry WHERE expires_at > ?1 ORDER BY created_at DESC LIMIT ?2';
	const statement = gameId
		? db.prepare(sql).bind(now, gameId, limit)
		: db.prepare(sql).bind(now, limit);
	const result = await statement.all<{ code: string; game_id: string; created_at: number; expires_at: number }>();
	return Array.isArray(result?.results) ? result.results : [];
}

/**
 * Run `probe` over `items` with at most `concurrency` in flight, each abandoned
 * after `timeoutMs`. A browser tab that opens the lobby panel while six rooms
 * exist must not fire six serial round-trips, and a room whose DO is waking from
 * a cold start must not hold the whole list hostage.
 */
export async function probeRooms<Item, Probed>(
	items: Item[],
	probe: (item: Item) => Promise<Probed | null>,
	concurrency: number,
	timeoutMs: number,
): Promise<Array<Probed | null>> {
	const out: Array<Probed | null> = new Array(items.length).fill(null);
	let cursor = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = cursor;
			cursor += 1;
			if (index >= items.length) return;
			const item = items[index]!;
			try {
				out[index] = await withTimeout(probe(item), timeoutMs);
			} catch {
				out[index] = null;
			}
		}
	};
	const width = Math.max(1, Math.min(concurrency, items.length || 1));
	await Promise.all(Array.from({ length: width }, () => worker()));
	return out;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Turn a probe response into a lobby row, or into `null` when the room must not
 * be listed. Everything here is a removal rule: the list is only as strong as
 * the claim that clicking a row puts you in a room.
 */
export function lobbyRowFromProbe(
	entry: { code: string; game_id: string; created_at: number; expires_at: number },
	probed: unknown,
	now: number,
): LobbyRow | null {
	if (!CODE_PATTERN.test(entry.code)) return null;
	if (!probed || typeof probed !== 'object') return null;
	const value = probed as Record<string, unknown>;
	if (value.live !== true) return null;
	// The probe must agree which game the room is for. A room that answers with a
	// different gameId than its registry row is a bug or a lie, and either way a
	// player would be sent to the wrong game page — so it is not listed.
	if (typeof value.gameId !== 'string' || value.gameId !== entry.game_id) return null;
	const players = Number(value.players);
	const capacity = Number(value.capacity);
	if (!Number.isInteger(players) || players < 0 || !Number.isInteger(capacity) || capacity < 1) return null;
	const expiresAt = Number(value.expiresAt);
	if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
	// A full room is genuinely not joinable, and "joinable" is the only promise
	// this list makes.
	if (players >= capacity) return null;
	return {
		roomCode: entry.code,
		gameId: entry.game_id,
		players,
		capacity,
		createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : entry.created_at,
		expiresAt,
		revision: Number.isFinite(Number(value.revision)) ? Number(value.revision) : 0,
	};
}

export function emptyLobbyList(now: number, config: LobbyConfig = LOBBY_CONFIG): LobbyList {
	return { lobbies: [], truncated: false, stale: false, checkedAt: now, refreshAfterSeconds: config.cacheTtlSeconds };
}

/** The list itself: candidates → probes → rows, with the counters the UI needs. */
export async function listOpenLobbies(input: {
	db: D1Database | undefined;
	gameId: string;
	now: number;
	probe: (code: string) => Promise<unknown | null>;
	config?: LobbyConfig;
}): Promise<LobbyList> {
	const config = input.config ?? LOBBY_CONFIG;
	if (!input.db || !config.enabled) return emptyLobbyList(input.now, config);
	const entries = await readRegistryRows(input.db, input.gameId, input.now, config.listLimit);
	if (entries.length === 0) {
		return { lobbies: [], truncated: false, stale: false, checkedAt: input.now, refreshAfterSeconds: config.cacheTtlSeconds };
	}
	const probed = await probeRooms(entries, (entry) => input.probe(entry.code), config.probeConcurrency, config.probeTimeoutMs);
	const lobbies: LobbyRow[] = [];
	let stale = false;
	entries.forEach((entry, index) => {
		const row = lobbyRowFromProbe(entry, probed[index] ?? null, input.now);
		if (row) lobbies.push(row);
		else stale = true;
	});
	// Soonest-expiring first: those are the rows a player can still catch.
	lobbies.sort((a, b) => a.expiresAt - b.expiresAt);
	return {
		lobbies,
		truncated: entries.length >= config.listLimit,
		stale,
		checkedAt: input.now,
		refreshAfterSeconds: config.cacheTtlSeconds,
	};
}

/* ------------------------------------------------------------------- cache */

export function lobbyCacheKey(gameId: string): string {
	return `${LOBBY_CACHE_PREFIX}${gameId || 'all'}`;
}

/**
 * The KV cache is what keeps a public lobby list affordable: without it, every
 * visitor costs one D1 read plus one subrequest per candidate room. A missing or
 * failing KV is a performance loss, never an error — that is the same trade-off
 * the rate limiter documents, and the reason the cache lives here rather than in
 * front of the route.
 */
export async function readLobbyCache(kv: KvRateLimitStore | undefined, key: string): Promise<LobbyList | null> {
	if (!kv || typeof kv.get !== 'function') return null;
	try {
		const raw = await kv.get(key, 'text');
		if (!raw) return null;
		const parsed = JSON.parse(raw) as unknown;
		return isLobbyList(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export async function writeLobbyCache(kv: KvRateLimitStore | undefined, key: string, list: LobbyList, ttlSeconds: number): Promise<void> {
	if (!kv || typeof kv.put !== 'function') return;
	try {
		await kv.put(key, JSON.stringify(list), { expirationTtl: Math.max(60, Math.min(3_600, Math.round(ttlSeconds))) });
	} catch { /* a cache that will not take the write is still a working list */ }
}

function isLobbyList(value: unknown): value is LobbyList {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	if (!Array.isArray(candidate.lobbies) || !Number.isFinite(Number(candidate.checkedAt))) return false;
	return candidate.lobbies.every((row) => {
		if (!row || typeof row !== 'object') return false;
		const item = row as Record<string, unknown>;
		return typeof item.roomCode === 'string' && CODE_PATTERN.test(item.roomCode)
			&& typeof item.gameId === 'string'
			&& Number.isFinite(Number(item.players)) && Number.isFinite(Number(item.capacity))
			&& Number.isFinite(Number(item.expiresAt)) && Number(item.expiresAt) > Date.now();
	});
}
