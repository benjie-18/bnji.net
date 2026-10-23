/**
 * BNJI.NET — chat plan Phase E: the friends/blocks D1 store (plan §8.1).
 *
 * All rows live in the existing `BOARD_DB` (0016_friends.sql): canonical
 * player-pair keys like dm_conversations (player_a < player_b), states
 * pending/accepted/declined with `requested_by` so a mutual request can
 * auto-accept. Blocks always win (remove friendship, cancel pending, deny new
 * requests). Friend lists are private to the account — no function here
 * returns anyone's list to anyone but its owner, and nothing writes to KV
 * (§11).
 *
 * Deletion (§9.5): `deleteFriendRows` is called from `deletePlayerAccount`
 * inside its existing batch — friends/blocks cascade with the account.
 */
import type { D1Database } from './game-store';
import { FRIENDS_CONFIG } from '../config/friends.config';

export type FriendEntry = {
	handle: string;
	displayName: string;
	/** Epoch ms when the current relationship state took effect. */
	since: number;
};

export type FriendListState = {
	friends: FriendEntry[];
	incoming: FriendEntry[];
	outgoing: FriendEntry[];
	blocked: FriendEntry[];
};

export type FriendActionOutcome =
	| { ok: true; changed: string }
	| { ok: false; error: string; status: number };

export type FriendGateState = 'friends' | 'blocked' | 'none';

const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/;

function pair(playerA: string, playerB: string): [string, string] {
	return playerA < playerB ? [playerA, playerB] : [playerB, playerA];
}

async function playerIdByHandle(db: D1Database, handle: string): Promise<{ id: string; displayName: string } | null> {
	const row = await db.prepare('SELECT id, display_name FROM game_players WHERE handle = ?1 LIMIT 1')
		.bind(handle).first<{ id: string; display_name: string }>();
	return row ? { id: String(row.id), displayName: String(row.display_name) } : null;
}

/** The four lists the /community/friends page renders, joined to display labels. */
export async function listFriendState(db: D1Database, playerId: string): Promise<FriendListState> {
	type AcceptedRow = { handle: string | null; display_name: string; since: number };
	type PendingRow = { handle: string | null; display_name: string; state: string; requested_by: string; since: number };
	type BlockRow = { handle: string | null; display_name: string; since: number };
	const acceptedQuery = db.prepare(
		`SELECT p.handle AS handle, p.display_name AS display_name, f.updated_at AS since
		 FROM player_friends f
		 JOIN game_players p ON p.id = CASE WHEN f.player_a = ?1 THEN f.player_b ELSE f.player_a END
		 WHERE (f.player_a = ?1 OR f.player_b = ?1) AND f.state = 'accepted'
		 ORDER BY p.handle LIMIT ?2`,
	).bind(playerId, 501);
	const pendingQuery = db.prepare(
		`SELECT p.handle AS handle, p.display_name AS display_name, f.state AS state,
		        f.requested_by AS requested_by, f.updated_at AS since
		 FROM player_friends f
		 JOIN game_players p ON p.id = CASE WHEN f.player_a = ?1 THEN f.player_b ELSE f.player_a END
		 WHERE (f.player_a = ?1 OR f.player_b = ?1) AND f.state = 'pending'
		 ORDER BY p.handle LIMIT ?2`,
	).bind(playerId, 501);
	const blockQuery = db.prepare(
		`SELECT p.handle AS handle, p.display_name AS display_name, b.created_at AS since
		 FROM player_blocks b
		 JOIN game_players p ON p.id = b.blocked
		 WHERE b.blocker = ?1
		 ORDER BY p.handle LIMIT ?2`,
	).bind(playerId, 501);
	type BatchRead<T> = { results?: T[] };
	let acceptedRows: AcceptedRow[];
	let pendingRows: PendingRow[];
	let blockRows: BlockRow[];
	if (db.batch) {
		// D1 batch carries the three independent private-list reads in one
		// service round trip. Keep a Promise.all fallback for small test/host
		// adapters that implement only prepare/all.
		const result = await db.batch([acceptedQuery, pendingQuery, blockQuery]) as [
			BatchRead<AcceptedRow>, BatchRead<PendingRow>, BatchRead<BlockRow>,
		];
		acceptedRows = result[0]?.results ?? [];
		pendingRows = result[1]?.results ?? [];
		blockRows = result[2]?.results ?? [];
	} else {
		const [accepted, pending, blocks] = await Promise.all([
			acceptedQuery.all<AcceptedRow>(),
			pendingQuery.all<PendingRow>(),
			blockQuery.all<BlockRow>(),
		]);
		acceptedRows = accepted.results;
		pendingRows = pending.results;
		blockRows = blocks.results;
	}
	const entry = (row: { handle: string | null; display_name: string; since: number }): FriendEntry | null =>
		row.handle === null ? null : { handle: String(row.handle), displayName: String(row.display_name), since: Number(row.since) };
	return {
		friends: acceptedRows.map(entry).filter((item): item is FriendEntry => item !== null),
		incoming: pendingRows.filter((row) => row.requested_by !== playerId).map(entry).filter((item): item is FriendEntry => item !== null),
		outgoing: pendingRows.filter((row) => row.requested_by === playerId).map(entry).filter((item): item is FriendEntry => item !== null),
		blocked: blockRows.map(entry).filter((item): item is FriendEntry => item !== null),
	};
}

/**
 * DM send/open gate (plan D7 answer: open in D, friends-only from E): the
 * pair must be accepted friends and unblocked in either direction. Block
 * checked first so callers can answer `blocked` with the sharper copy.
 */
export async function friendGateState(db: D1Database, playerA: string, playerB: string): Promise<FriendGateState> {
	const [blockRow, friendRow] = await Promise.all([
		db.prepare(
			'SELECT 1 FROM player_blocks WHERE (blocker = ?1 AND blocked = ?2) OR (blocker = ?2 AND blocked = ?1) LIMIT 1',
		).bind(playerA, playerB).first(),
		db.prepare('SELECT state FROM player_friends WHERE player_a = ?1 AND player_b = ?2 LIMIT 1')
			.bind(...pair(playerA, playerB)).first<{ state: string }>(),
	]);
	if (blockRow) return 'blocked';
	return friendRow?.state === 'accepted' ? 'friends' : 'none';
}

/** Pending outgoing count for THIS account (cap §8.1) — needs requested_by, not pair side. */
async function countPendingOutgoing(db: D1Database, playerId: string): Promise<number> {
	const row = await db.prepare(
		"SELECT COUNT(*) AS n FROM player_friends WHERE requested_by = ?1 AND state = 'pending'",
	).bind(playerId).first<{ n: number }>();
	return Number(row?.n ?? 0);
}

async function countAccepted(db: D1Database, playerId: string): Promise<number> {
	const row = await db.prepare(
		"SELECT COUNT(*) AS n FROM player_friends WHERE (player_a = ?1 OR player_b = ?1) AND state = 'accepted'",
	).bind(playerId).first<{ n: number }>();
	return Number(row?.n ?? 0);
}

/**
 * One entry point for the four mutations (§8.1 rules in order): handle shape,
 * self, target exists, block-either-way, caps, then the state transition.
 * Mutual pending → accepted automatically; a previously declined pair resets
 * to pending when re-requested.
 */
export async function friendAction(
	db: D1Database,
	playerId: string,
	action: 'request' | 'accept' | 'decline' | 'block' | 'remove' | 'unblock',
	targetHandle: string,
	now: number,
): Promise<FriendActionOutcome> {
	if (!HANDLE_PATTERN.test(targetHandle)) return { ok: false, error: 'invalid_handle', status: 400 };
	const target = await playerIdByHandle(db, targetHandle);
	if (!target) return { ok: false, error: 'not_found', status: 404 };
	if (target.id === playerId) return { ok: false, error: 'self_friend', status: 400 };
	const [myA, myB] = pair(playerId, target.id);

	const existing = await db.prepare('SELECT state, requested_by FROM player_friends WHERE player_a = ?1 AND player_b = ?2 LIMIT 1')
		.bind(myA, myB).first<{ state: string; requested_by: string }>();
	const blocked = await db.prepare(
		'SELECT blocker FROM player_blocks WHERE (blocker = ?1 AND blocked = ?2) OR (blocker = ?2 AND blocked = ?1) LIMIT 1',
	).bind(playerId, target.id).first<{ blocker: string }>();

	if (action === 'unblock') {
		if (!blocked || blocked.blocker !== playerId) return { ok: false, error: 'not_found', status: 404 };
		await db.prepare('DELETE FROM player_blocks WHERE blocker = ?1 AND blocked = ?2').bind(playerId, target.id).run();
		return { ok: true, changed: 'unblocked' };
	}

	// Block wins (§8.1): it denies everything new and, when the blocker acts,
	// removes any friendship / pending request with that pair.
	if (action === 'block') {
		await db.prepare(
			'INSERT INTO player_blocks (blocker, blocked, created_at) VALUES (?1, ?2, ?3) ON CONFLICT (blocker, blocked) DO NOTHING',
		).bind(playerId, target.id, now).run();
		await db.prepare('DELETE FROM player_friends WHERE player_a = ?1 AND player_b = ?2').bind(myA, myB).run();
		return { ok: true, changed: 'blocked' };
	}
	if (blocked) return { ok: false, error: 'blocked', status: 403 };

	if (action === 'remove') {
		// Accepted friend → unfriend; own pending outgoing → cancel it. Without
		// the cancel leg a stale request would sit forever (the recipient may
		// never respond) and count against maxPendingOutgoing. Incoming
		// pending stays the RECIPIENT's to decline (§8.1).
		if (!existing) return { ok: false, error: 'not_found', status: 404 };
		if (existing.state === 'pending' && existing.requested_by !== playerId) return { ok: false, error: 'not_found', status: 404 };
		await db.prepare('DELETE FROM player_friends WHERE player_a = ?1 AND player_b = ?2').bind(myA, myB).run();
		return { ok: true, changed: existing.state === 'accepted' ? 'removed' : 'cancelled' };
	}

	if (action === 'request') {
		if (existing?.state === 'accepted') return { ok: false, error: 'already_friends', status: 409 };
		if (existing?.state === 'pending' && existing.requested_by === playerId) return { ok: false, error: 'already_pending', status: 409 };
		// Mutual pending → auto-accept (§8.1); declined pair → fresh pending.
		if (existing?.state === 'pending') {
			await db.prepare("UPDATE player_friends SET state = 'accepted', updated_at = ?3 WHERE player_a = ?1 AND player_b = ?2")
				.bind(myA, myB, now).run();
			return { ok: true, changed: 'friends' };
		}
		const [accepted, pendingOutgoing] = await Promise.all([countAccepted(db, playerId), countPendingOutgoing(db, playerId)]);
		if (accepted >= FRIENDS_CONFIG.maxFriends) return { ok: false, error: 'friends_limit', status: 409 };
		if (pendingOutgoing >= FRIENDS_CONFIG.maxPendingOutgoing) return { ok: false, error: 'pending_limit', status: 409 };
		await db.prepare(
			`INSERT INTO player_friends (player_a, player_b, state, requested_by, created_at, updated_at)
			 VALUES (?1, ?2, 'pending', ?3, ?4, ?4)
			 ON CONFLICT (player_a, player_b) DO UPDATE SET state = 'pending', requested_by = excluded.requested_by, updated_at = excluded.updated_at`,
		).bind(myA, myB, playerId, now).run();
		return { ok: true, changed: 'requested' };
	}

	// accept / decline — only the RECIPIENT can decide (§8.1).
	if (!existing || existing.state !== 'pending') return { ok: false, error: existing?.state === 'accepted' ? 'already_friends' : 'not_found', status: existing?.state === 'accepted' ? 409 : 404 };
	if (existing.requested_by === playerId) return { ok: false, error: 'already_pending', status: 409 };
	if (action === 'accept') {
		await db.prepare("UPDATE player_friends SET state = 'accepted', updated_at = ?3 WHERE player_a = ?1 AND player_b = ?2")
			.bind(myA, myB, now).run();
		return { ok: true, changed: 'friends' };
	}
	await db.prepare("UPDATE player_friends SET state = 'declined', updated_at = ?3 WHERE player_a = ?1 AND player_b = ?2")
		.bind(myA, myB, now).run();
	return { ok: true, changed: 'declined' };
}

/** Admin-side aggregates (counts only — friend lists stay private, §8.1). */
export async function friendHealthCounts(db: D1Database): Promise<{ accepted: number; pending: number; blocks: number }> {
	const [accepted, pending, blocks] = await Promise.all([
		db.prepare("SELECT COUNT(*) AS n FROM player_friends WHERE state = 'accepted'").first<{ n: number }>(),
		db.prepare("SELECT COUNT(*) AS n FROM player_friends WHERE state = 'pending'").first<{ n: number }>(),
		db.prepare('SELECT COUNT(*) AS n FROM player_blocks').first<{ n: number }>(),
	]);
	return {
		accepted: Number(accepted?.n ?? 0),
		pending: Number(pending?.n ?? 0),
		blocks: Number(blocks?.n ?? 0),
	};
}

/** §8.3 badge: unanswered incoming requests. */
export async function countPendingFriendRequests(db: D1Database, playerId: string): Promise<number> {
	const row = await db.prepare(
		"SELECT COUNT(*) AS n FROM player_friends WHERE state = 'pending' AND requested_by <> ?1 AND (player_a = ?1 OR player_b = ?1)",
	).bind(playerId).first<{ n: number }>();
	return Number(row?.n ?? 0);
}

/** §9.5 deletion cascade — statements for deletePlayerAccount's existing batch. */
export function friendAccountStatements(db: D1Database, playerId: string) {
	return [
		db.prepare('DELETE FROM player_friends WHERE player_a = ?1 OR player_b = ?1').bind(playerId),
		db.prepare('DELETE FROM player_blocks WHERE blocker = ?1 OR blocked = ?1').bind(playerId),
	];
}

/** §9.5 export — my friendships and blocks as handle-labelled rows. */
export async function exportFriendData(db: D1Database, playerId: string): Promise<{
	friends: Array<{ handle: string; displayName: string; since: number }>;
	incoming: Array<{ handle: string; displayName: string; since: number }>;
	outgoing: Array<{ handle: string; displayName: string; since: number }>;
	blocked: Array<{ handle: string; displayName: string; since: number }>;
}> {
	const state = await listFriendState(db, playerId);
	return { friends: state.friends, incoming: state.incoming, outgoing: state.outgoing, blocked: state.blocked };
}
