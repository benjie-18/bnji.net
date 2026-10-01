/**
 * BNJI.NET — chat plan Phase D: D1 persistence for private messaging
 * (plan §7.2/§7.3/§9.1/§9.3/§9.5).
 *
 * The split mirrors the plan exactly: D1 is the durable record (D5); the
 * DMConversation Durable Object only ever fans out live frames and never
 * reads or writes these tables. Nothing here touches KV — the standing rule
 * keeps chat/messaging out of KV (plan §11); rate budgets reuse the D1
 * `game_auth_attempts` counter with `bnji-dm-*` prefixes (§12.4).
 *
 * Side convention: conversations are canonically `member_lo < member_hi` and
 * every per-side column (read watermark, hidden_for bit) is addressed by
 * side, so "who writes first" never matters (§7.2).
 */
import { DM_CONFIG } from '../config/dm.config';
import type { D1Database, D1Statement } from './game-store';
import { DM_SIDE_BIT, type DmSide } from './dm-protocol';
import { sha256Hex } from './player-store';

/** An unclaimed upload that never becomes a message dies after this long (§7.4). */
export const DM_UNCLAIMED_ATTACHMENT_TTL_MS = 60 * 60_000;

export type ConversationRow = {
	id: string;
	memberLo: string;
	memberHi: string;
	createdAt: number;
	lastMessageAt: number | null;
	lastSeq: number;
	readSeqLo: number;
	readSeqHi: number;
};

export type MessageRow = {
	convId: string;
	n: number;
	sender: string;
	body: string;
	imageId: string | null;
	createdAt: number;
	hiddenFor: number;
};

export type AttachmentRow = {
	id: string;
	convId: string;
	uploader: string;
	mime: string;
	data: string;
	createdAt: number;
	claimedN: number | null;
};

export type ConversationListItem = {
	id: string;
	partner: { handle: string | null; displayName: string };
	mySide: DmSide;
	lastSeq: number;
	myReadSeq: number;
	partnerReadSeq: number;
	unread: number;
	updatedAt: number | null;
	preview: { body: string; hasImage: boolean; fromMe: boolean; at: number } | null;
};

export type SerializedMessage = {
	n: number;
	from: 'me' | 'them';
	body: string;
	imageId: string | null;
	at: number;
};

/** Plan §7.2: sha256([a, b].sort().join(':')) over the two player IDs. */
export async function conversationIdFor(a: string, b: string): Promise<string> {
	return sha256Hex([a, b].sort().join(':'));
}

export function sideOf(row: Pick<ConversationRow, 'memberLo' | 'memberHi'>, playerId: string): DmSide | null {
	if (row.memberLo === playerId) return 'lo';
	if (row.memberHi === playerId) return 'hi';
	return null;
}

function mapConversation(row: Record<string, unknown>): ConversationRow {
	return {
		id: String(row.id),
		memberLo: String(row.member_lo),
		memberHi: String(row.member_hi),
		createdAt: Number(row.created_at),
		lastMessageAt: row.last_message_at === null || row.last_message_at === undefined ? null : Number(row.last_message_at),
		lastSeq: Number(row.last_seq),
		readSeqLo: Number(row.read_seq_lo),
		readSeqHi: Number(row.read_seq_hi),
	};
}

function mapMessage(row: Record<string, unknown>): MessageRow {
	return {
		convId: String(row.conv_id),
		n: Number(row.n),
		sender: String(row.sender),
		body: String(row.body ?? ''),
		imageId: row.image_id === null || row.image_id === undefined ? null : String(row.image_id),
		createdAt: Number(row.created_at),
		hiddenFor: Number(row.hidden_for ?? 0),
	};
}

export async function getConversation(db: D1Database, id: string): Promise<ConversationRow | null> {
	const row = await db.prepare(
		'SELECT id, member_lo, member_hi, created_at, last_message_at, last_seq, read_seq_lo, read_seq_hi FROM dm_conversations WHERE id = ?1 LIMIT 1',
	).bind(id).first<Record<string, unknown>>();
	return row ? mapConversation(row) : null;
}

/** Resolve-or-create the single row for a pair (idempotent — §7.2's no-duplicate-race). */
export async function ensureConversation(db: D1Database, a: string, b: string, now = Date.now()): Promise<ConversationRow> {
	const [lo, hi] = [a, b].sort();
	const id = await sha256Hex(`${lo}:${hi}`);
	await db.prepare(
		'INSERT OR IGNORE INTO dm_conversations (id, member_lo, member_hi, created_at) VALUES (?1, ?2, ?3, ?4)',
	).bind(id, lo, hi, now).run();
	const row = await getConversation(db, id);
	if (!row) throw new Error('dm_conversation_unavailable');
	return row;
}

/**
 * Conversations for one member, newest activity first: partner identity by
 * handle + display label (player IDs never leave the server — §12.3),
 * unread = messages past my watermark from them that are not hidden for me,
 * and a last-message preview (body trimmed to 140 code points).
 */
export async function listConversations(db: D1Database, playerId: string, limit = 50): Promise<ConversationListItem[]> {
	const capped = Math.min(100, Math.max(1, limit));
	const mySideSql = `CASE WHEN c.member_lo = ?1 THEN 'lo' ELSE 'hi' END`;
	const partnerSql = `CASE WHEN c.member_lo = ?1 THEN c.member_hi ELSE c.member_lo END`;
	const rows = await db.prepare(
		`SELECT c.id, c.member_lo, c.member_hi, c.last_message_at, c.last_seq, c.read_seq_lo, c.read_seq_hi,
			${mySideSql} AS my_side,
			p.handle AS partner_handle, p.display_name AS partner_name,
			m.body AS last_body, m.image_id AS last_image_id, m.sender AS last_sender, m.created_at AS last_at,
			(SELECT COUNT(*) FROM dm_messages um
			 WHERE um.conv_id = c.id
			   AND um.n > CASE WHEN c.member_lo = ?1 THEN c.read_seq_lo ELSE c.read_seq_hi END
			   AND um.sender <> ?1
			   AND (um.hidden_for & CASE WHEN c.member_lo = ?1 THEN 1 ELSE 2 END) = 0) AS unread
			FROM dm_conversations c
			LEFT JOIN game_players p ON p.id = ${partnerSql}
			LEFT JOIN dm_messages m ON m.conv_id = c.id AND m.n = (
				SELECT m2.n FROM dm_messages m2 WHERE m2.conv_id = c.id ORDER BY m2.n DESC LIMIT 1)
			WHERE (c.member_lo = ?1 OR c.member_hi = ?1) AND c.last_message_at IS NOT NULL
			ORDER BY c.last_message_at DESC LIMIT ?2`,
	).bind(playerId, capped).all<Record<string, unknown>>();
	return rows.results.map((row) => {
		const mySide = String(row.my_side) as DmSide;
		const fromMe = row.last_sender === null || row.last_sender === undefined ? false : String(row.last_sender) === playerId;
		const body = row.last_body === null || row.last_body === undefined ? '' : String(row.last_body);
		return {
			id: String(row.id),
			partner: {
				handle: row.partner_handle === null || row.partner_handle === undefined ? null : String(row.partner_handle),
				displayName: row.partner_name === null || row.partner_name === undefined ? 'Player' : String(row.partner_name),
			},
			mySide,
			lastSeq: Number(row.last_seq),
			myReadSeq: mySide === 'lo' ? Number(row.read_seq_lo) : Number(row.read_seq_hi),
			partnerReadSeq: mySide === 'lo' ? Number(row.read_seq_hi) : Number(row.read_seq_lo),
			unread: Number(row.unread ?? 0),
			updatedAt: row.last_message_at === null || row.last_message_at === undefined ? null : Number(row.last_message_at),
			preview: row.last_at === null || row.last_at === undefined ? null : {
				body: [...body].length > 140 ? `${[...body].slice(0, 140).join('')}…` : body,
				hasImage: Boolean(row.last_image_id),
				fromMe,
				at: Number(row.last_at),
			},
		} satisfies ConversationListItem;
	});
}

/**
 * Append the next message. Two statements, both individually atomic:
 * the conversation's `last_seq` increments with RETURNING (a single
 * read-modify-write, so concurrent senders cannot collide on n), then the
 * message row inserts with that n. The sender's own read watermark advances
 * with it — nobody accrues unread for their own messages.
 */
export async function appendMessage(db: D1Database, input: {
	conv: ConversationRow; sender: string; body: string; imageId: string | null; now?: number;
}): Promise<MessageRow> {
	const now = input.now ?? Date.now();
	const side = sideOf(input.conv, input.sender);
	if (!side) throw new Error('dm_not_a_member');
	// Idempotent ensure: the pair row may not exist for a first message.
	await db.prepare(
		'INSERT OR IGNORE INTO dm_conversations (id, member_lo, member_hi, created_at) VALUES (?1, ?2, ?3, ?4)',
	).bind(input.conv.id, input.conv.memberLo, input.conv.memberHi, input.conv.createdAt).run();
	const watermarkColumn = side === 'lo' ? 'read_seq_lo' : 'read_seq_hi';
	const advanced = await db.prepare(
		`UPDATE dm_conversations SET last_seq = last_seq + 1, last_message_at = ?2,
			${watermarkColumn} = CASE WHEN last_seq + 1 > ${watermarkColumn} THEN last_seq + 1 ELSE ${watermarkColumn} END
		 WHERE id = ?1 RETURNING last_seq`,
	).bind(input.conv.id, now).first<{ last_seq: number }>();
	if (!advanced) throw new Error('dm_conversation_unavailable');
	const n = Number(advanced.last_seq);
	await db.prepare(
		'INSERT INTO dm_messages (conv_id, n, sender, body, image_id, created_at, hidden_for) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)',
	).bind(input.conv.id, n, input.sender, input.body, input.imageId, now).run();
	return { convId: input.conv.id, n, sender: input.sender, body: input.body, imageId: input.imageId, createdAt: now, hiddenFor: 0 };
}

/**
 * Image send (plan §7.4): reserve n on the conversation, claim the
 * attachment, THEN insert the message. A lost claim race inserts nothing
 * (caller answers 409); a crash between claim and insert leaves a claimed
 * row with no message, which the hourly orphan sweep removes — never a
 * message pointing at an attachment somebody else claimed. (No
 * data-modifying CTE: SQLite has none.)
 */
export async function appendMessageClaimingAttachment(db: D1Database, input: {
	conv: ConversationRow; sender: string; body: string; imageId: string; now?: number;
}): Promise<MessageRow | null> {
	const now = input.now ?? Date.now();
	const side = sideOf(input.conv, input.sender);
	if (!side) throw new Error('dm_not_a_member');
	await db.prepare(
		'INSERT OR IGNORE INTO dm_conversations (id, member_lo, member_hi, created_at) VALUES (?1, ?2, ?3, ?4)',
	).bind(input.conv.id, input.conv.memberLo, input.conv.memberHi, input.conv.createdAt).run();
	const watermarkColumn = side === 'lo' ? 'read_seq_lo' : 'read_seq_hi';
	// Claim FIRST with a sentinel: a lost race or a double-submit 409 must
	// consume no sequence number and never advance the sender's watermark
	// (that path is the common case, not a rare race). The sweep treats a
	// stranded `-1` row as a claimed orphan.
	const claimed = await db.prepare(
		'UPDATE dm_attachments SET claimed_n = -1 WHERE id = ? AND conv_id = ? AND uploader = ? AND claimed_n IS NULL',
	).bind(input.imageId, input.conv.id, input.sender).run();
	if ((claimed.meta?.changes ?? 0) === 0) return null;
	let advanced: { last_seq: number } | null = null;
	let n = -1;
	try {
		advanced = await db.prepare(
			`UPDATE dm_conversations SET last_seq = last_seq + 1, last_message_at = ?2,
				${watermarkColumn} = CASE WHEN last_seq + 1 > ${watermarkColumn} THEN last_seq + 1 ELSE ${watermarkColumn} END
			 WHERE id = ?1 RETURNING last_seq`,
		).bind(input.conv.id, now).first<{ last_seq: number }>();
		if (!advanced) throw new Error('dm_conversation_unavailable');
		n = Number(advanced.last_seq);
		await db.prepare(
			'UPDATE dm_attachments SET claimed_n = ? WHERE id = ? AND claimed_n = -1 AND uploader = ?',
		).bind(n, input.imageId, input.sender).run();
		await db.prepare(
			'INSERT INTO dm_messages (conv_id, n, sender, body, image_id, created_at, hidden_for) VALUES (?, ?, ?, ?, ?, ?, 0)',
		).bind(input.conv.id, n, input.sender, input.body, input.imageId, now).run();
	} catch (error) {
		// Release the sentinel so the upload stays usable; the sequence gap
		// from a mid-flight failure is crash-only (the sweep covers the rest).
		await db.prepare(
			'UPDATE dm_attachments SET claimed_n = NULL WHERE id = ? AND claimed_n = -1 AND uploader = ?',
		).bind(input.imageId, input.sender).run();
		throw error;
	}
	return { convId: input.conv.id, n, sender: input.sender, body: input.body, imageId: input.imageId, createdAt: now, hiddenFor: 0 };
}

/**
 * Bounded history pull (§7.3 "everything after its last seen sequence").
 * `after` serves catch-up, `before` serves scrollback, neither serves the
 * newest page. Hidden-for-the-viewer rows are omitted (D12 delete-for-me).
 */
export async function listMessages(db: D1Database, input: {
	conv: ConversationRow; viewerId: string; after?: number; before?: number; limit?: number;
}): Promise<SerializedMessage[]> {
	const viewerSide = sideOf(input.conv, input.viewerId);
	if (!viewerSide) throw new Error('dm_not_a_member');
	const bit = DM_SIDE_BIT[viewerSide];
	const limit = Math.min(100, Math.max(1, input.limit ?? DM_CONFIG.historyPage));
	let rows;
	if (input.after !== undefined) {
		rows = await db.prepare(
			`SELECT conv_id, n, sender, body, image_id, created_at, hidden_for FROM dm_messages
			 WHERE conv_id = ?1 AND n > ?2 AND (hidden_for & ?4) = 0 ORDER BY n ASC LIMIT ?3`,
		).bind(input.conv.id, input.after, limit, bit).all<Record<string, unknown>>();
	} else if (input.before !== undefined) {
		const page = await db.prepare(
			`SELECT conv_id, n, sender, body, image_id, created_at, hidden_for FROM dm_messages
			 WHERE conv_id = ?1 AND n < ?2 AND (hidden_for & ?4) = 0 ORDER BY n DESC LIMIT ?3`,
		).bind(input.conv.id, input.before, limit, bit).all<Record<string, unknown>>();
		rows = { results: [...page.results].reverse() };
	} else {
		const page = await db.prepare(
			`SELECT conv_id, n, sender, body, image_id, created_at, hidden_for FROM dm_messages
			 WHERE conv_id = ?1 AND (hidden_for & ?3) = 0 ORDER BY n DESC LIMIT ?2`,
		).bind(input.conv.id, limit, bit).all<Record<string, unknown>>();
		rows = { results: [...page.results].reverse() };
	}
	return rows.results.map((row) => {
		const message = mapMessage(row);
		return {
			n: message.n,
			from: message.sender === input.viewerId ? 'me' : 'them',
			body: message.body,
			imageId: message.imageId,
			at: message.createdAt,
		} satisfies SerializedMessage;
	});
}

/** D12 delete-for-me: set the viewer's bit. Returns false when nothing matched. */
export async function hideMessage(db: D1Database, convId: string, n: number, viewerSide: DmSide): Promise<boolean> {
	const result = await db.prepare(
		'UPDATE dm_messages SET hidden_for = hidden_for | ?3 WHERE conv_id = ?1 AND n = ?2',
	).bind(convId, n, DM_SIDE_BIT[viewerSide]).run();
	return (result.meta?.changes ?? 0) > 0;
}

/** §7.1: one read watermark per member per conversation, never per message. */
export async function markRead(db: D1Database, convId: string, side: DmSide, seq: number): Promise<void> {
	const column = side === 'lo' ? 'read_seq_lo' : 'read_seq_hi';
	await db.prepare(
		`UPDATE dm_conversations SET ${column} = MAX(${column}, ?2) WHERE id = ?1`,
	).bind(convId, Math.max(0, Math.floor(seq))).run();
}

/* ------------------------------------------------- attachments (D6: base64) */

export async function createAttachment(db: D1Database, input: {
	id: string; convId: string; uploader: string; mime: string; data: string; now?: number;
}): Promise<void> {
	await db.prepare(
		'INSERT INTO dm_attachments (id, conv_id, uploader, mime, data, created_at, claimed_n) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)',
	).bind(input.id, input.convId, input.uploader, input.mime, input.data, input.now ?? Date.now()).run();
}

/** Claim exactly once: the UPDATE's change count is the idempotency check. */
export async function claimAttachment(db: D1Database, input: { id: string; convId: string; uploader: string; n: number }): Promise<boolean> {
	const result = await db.prepare(
		'UPDATE dm_attachments SET claimed_n = ?4 WHERE id = ?1 AND conv_id = ?2 AND uploader = ?3 AND claimed_n IS NULL',
	).bind(input.id, input.convId, input.uploader, input.n).run();
	return (result.meta?.changes ?? 0) > 0;
}

/** Membership-checked read for the authenticated media route (§7.4 step 4). */
export async function getAttachmentForViewer(db: D1Database, id: string, viewerId: string): Promise<{ mime: string; data: string } | null> {
	const row = await db.prepare(
		`SELECT a.mime, a.data FROM dm_attachments a
		 JOIN dm_conversations c ON c.id = a.conv_id
		 WHERE a.id = ?1 AND (c.member_lo = ?2 OR c.member_hi = ?2) LIMIT 1`,
	).bind(id, viewerId).first<{ mime: string; data: string }>();
	return row ? { mime: String(row.mime), data: String(row.data) } : null;
}

/* --------------------------------------------------- export / deletion §9.5 */

/** The account's conversations + history for export (partner as handle+label only). */
export async function exportDmData(db: D1Database, playerId: string, limits = { conversations: 100, messages: 2_500, attachments: 100 }): Promise<{
	conversations: Array<Record<string, unknown>>;
	messages: Array<Record<string, unknown>>;
	attachmentBytesIncluded: number;
	attachmentBytesOmitted: number;
}> {
	const conversations = await db.prepare(
		`SELECT c.id, c.created_at, c.last_message_at, c.last_seq, c.read_seq_lo, c.read_seq_hi,
			CASE WHEN c.member_lo = ?1 THEN 'lo' ELSE 'hi' END AS my_side,
			p.handle AS partner_handle, p.display_name AS partner_name
		 FROM dm_conversations c
		 LEFT JOIN game_players p ON p.id = CASE WHEN c.member_lo = ?1 THEN c.member_hi ELSE c.member_lo END
		 WHERE c.member_lo = ?1 OR c.member_hi = ?1
		 ORDER BY c.created_at DESC LIMIT ?2`,
	).bind(playerId, limits.conversations).all<Record<string, unknown>>();
	const messages = await db.prepare(
		`SELECT m.conv_id, m.n, m.sender, m.body, m.image_id, m.created_at, m.hidden_for
		 FROM dm_messages m JOIN dm_conversations c ON c.id = m.conv_id
		 WHERE c.member_lo = ?1 OR c.member_hi = ?1
		 ORDER BY m.created_at DESC LIMIT ?2`,
	).bind(playerId, limits.messages).all<Record<string, unknown>>();
	const serializedConversations = conversations.results.map((row) => ({
		id: String(row.id),
		createdAt: Number(row.created_at),
		lastMessageAt: row.last_message_at === null || row.last_message_at === undefined ? null : Number(row.last_message_at),
		lastSeq: Number(row.last_seq),
		mySide: String(row.my_side),
		partner: {
			handle: row.partner_handle === null || row.partner_handle === undefined ? null : String(row.partner_handle),
			displayName: row.partner_name === null || row.partner_name === undefined ? 'Player' : String(row.partner_name),
		},
	}));
	// The viewer's hidden_for bit depends on their SIDE in each conversation,
	// never on who sent the message.
	const hiddenBit: Record<DmSide, number> = DM_SIDE_BIT;
	const sideByConv = new Map<string, DmSide>(serializedConversations.map((row) => [row.id, row.mySide as DmSide]));
	const serializedMessages = messages.results.map((row) => {
		const sender = String(row.sender);
		const convId = String(row.conv_id);
		const mySide = sideByConv.get(convId) ?? (sender === playerId ? 'lo' : 'hi');
		return {
			convId,
			n: Number(row.n),
			from: sender === playerId ? 'me' : 'them',
			body: String(row.body ?? ''),
			imageId: row.image_id === null || row.image_id === undefined ? null : String(row.image_id),
			at: Number(row.created_at),
			hiddenForMe: (Number(row.hidden_for ?? 0) & hiddenBit[mySide]) !== 0,
		};
	});
	// Attachments referenced by the exported messages, bytes included up to a cap.
	const referenced = serializedMessages.map((message) => message.imageId).filter((id): id is string => Boolean(id)).slice(0, limits.attachments);
	let attachmentBytesIncluded = 0;
	const attachments = new Map<string, { id: string; mime: string; data: string }>();
	for (const id of referenced) {
		const row = await db.prepare('SELECT id, mime, data FROM dm_attachments WHERE id = ?1 LIMIT 1').bind(id).first<{ id: string; mime: string; data: string }>();
		if (row) { attachments.set(id, { id: String(row.id), mime: String(row.mime), data: String(row.data) }); attachmentBytesIncluded += 1; }
	}
	for (const message of serializedMessages) {
		const attachment = message.imageId ? attachments.get(message.imageId) : undefined;
		(message as Record<string, unknown>).image = attachment ? { id: attachment.id, mime: attachment.mime, data: attachment.data } : null;
	}
	const totalReferenced = serializedMessages.filter((message) => message.imageId).length;
	return {
		conversations: serializedConversations,
		messages: serializedMessages,
		attachmentBytesIncluded,
		attachmentBytesOmitted: Math.max(0, totalReferenced - attachmentBytesIncluded),
	};
}

/**
 * Account-deletion cascade (§9.3/§9.5): conversations the account belongs to
 * leave whole — messages and attachments with them (plan wording: "extends
 * the existing cascade: conversations, messages, attachments"). Report rows
 * are swept by hashed principal, mirroring Phase C's treatment; the audit log
 * stays (hashed, unlinkable — §9.5). Statements are ordered so FK-off
 * engines (tests) and FK-on engines (D1) both end consistent.
 */
export function dmAccountStatements(db: D1Database, playerId: string, principalHash: string): D1Statement[] {
	const membership = '(SELECT id FROM dm_conversations WHERE member_lo = ?1 OR member_hi = ?1)';
	return [
		db.prepare(`DELETE FROM dm_attachments WHERE conv_id IN ${membership}`).bind(playerId),
		db.prepare(`DELETE FROM dm_messages WHERE conv_id IN ${membership}`).bind(playerId),
		db.prepare(`DELETE FROM dm_conversations WHERE member_lo = ?1 OR member_hi = ?1`).bind(playerId),
		db.prepare('DELETE FROM dm_reporters WHERE reporter_hash = ?1').bind(principalHash),
		db.prepare('DELETE FROM dm_reports WHERE author_hash = ?1 OR reporter_hash = ?1').bind(principalHash),
	];
}

/* --------------------------------------------------------- retention §9.3 */

/** Minimal structural DB shape for the sweep (same rationale as chat-moderation's SweepDb). */
export type DmSweepDb = {
	prepare(sql: string): { bind(...values: (string | number)[]): { run(): Promise<{ meta?: { changes?: number } }> } };
};

export async function purgeDmRows(
	db: DmSweepDb,
	input: { now?: number; messageCutoff: number; reportCutoff: number; limit?: number },
): Promise<{ messages: number; orphans: number; unclaimed: number; reports: number; reporters: number }> {
	const now = input.now ?? Date.now();
	const limit = Math.max(1, input.limit ?? 50);
	const messages = await db.prepare(
		`DELETE FROM dm_messages WHERE (conv_id, n) IN (
			SELECT conv_id, n FROM dm_messages WHERE created_at < ?1 ORDER BY created_at ASC LIMIT ?2)`,
	).bind(input.messageCutoff, limit).run();
	const orphans = await db.prepare(
		`DELETE FROM dm_attachments WHERE id IN (
			SELECT id FROM dm_attachments WHERE claimed_n IS NOT NULL AND created_at < ?1 AND NOT EXISTS (
				SELECT 1 FROM dm_messages m WHERE m.conv_id = dm_attachments.conv_id AND m.n = dm_attachments.claimed_n
			) ORDER BY created_at ASC LIMIT ?2)`,
	).bind(now, limit).run();
	const unclaimed = await db.prepare(
		`DELETE FROM dm_attachments WHERE id IN (
			SELECT id FROM dm_attachments WHERE claimed_n IS NULL AND created_at < ?1 ORDER BY created_at ASC LIMIT ?2)`,
	).bind(now - DM_UNCLAIMED_ATTACHMENT_TTL_MS, limit).run();
	const reports = await db.prepare(
		'DELETE FROM dm_reports WHERE (conv_id, message_n) IN (SELECT conv_id, message_n FROM dm_reports WHERE reported_at < ?1 ORDER BY reported_at ASC LIMIT ?2)',
	).bind(input.reportCutoff, limit).run();
	const reporters = await db.prepare(
		`DELETE FROM dm_reporters WHERE (conv_id, message_n, reporter_hash) IN (
			SELECT conv_id, message_n, reporter_hash FROM dm_reporters WHERE created_at < ?1 ORDER BY created_at ASC LIMIT ?2)`,
	).bind(input.reportCutoff, limit).run();
	return {
		messages: messages.meta?.changes ?? 0,
		orphans: orphans.meta?.changes ?? 0,
		unclaimed: unclaimed.meta?.changes ?? 0,
		reports: reports.meta?.changes ?? 0,
		reporters: reporters.meta?.changes ?? 0,
	};
}
