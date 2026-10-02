/**
 * Chat plan Phase B — room chat inside the real `GameRoom` Durable Object.
 *
 * Runs in workerd (hibernation, attachments, DO SQLite are real). Covers the
 * plan's §5 matrix: delivery + sanitised labels, reconnect history with
 * byte-aware chunking, soft rejections that never close the socket, the
 * §5.4 rate restructure (8/s pre-parse close + soft per-member token bucket),
 * §5.5 moderation (host remove, self-delete, kick, mute surviving reconnect),
 * §5.3 chat-never-moves-revision, config-disabled behaviour, and alarm
 * teardown deleting chat with the room.
 */
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CHAT_CONFIG } from '../../src/config/chat.config';
import { GameRoom } from '../../src/server/game-room-do';
import { ROOM_TTL_MS } from '../../src/server/game-room-protocol';
import {
	connect, createRoom, delay, PRINCIPAL_A, PRINCIPAL_B, principalHash,
	snapshotOf, sqlRows, stubFor, uniqueRoomCode, type BoxFrame,
} from './support';

const LABEL_A = { 'x-bnji-chat-label': encodeURIComponent('Alice') };
const LABEL_B = { 'x-bnji-chat-label': encodeURIComponent('Bob') };
const chatOf = (frame: BoxFrame): boolean => frame.type === 'chat';
const historyOf = (frame: BoxFrame): boolean => frame.type === 'chat_history';
const membersOf = (frame: BoxFrame): boolean => frame.type === 'members';
const send = (socket: WebSocket, payload: Record<string, unknown>): void => socket.send(JSON.stringify(payload));

describe('GameRoom — chat delivery and history', () => {
	it('delivers sanitized chat to every member with per-socket mine flags and never moves revision', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A);
		const a = await connect(code, PRINCIPAL_A, LABEL_A);
		await a.box.next(snapshotOf);
		const b = await connect(code, PRINCIPAL_B, LABEL_B);
		await b.box.next(snapshotOf);
		await a.box.next((frame) => membersOf(frame) && (frame.members as unknown[]).length >= 2);

		send(b.socket, { v: 1, type: 'chat', text: '  hello\u202E  world  ' });
		const seenByA = await a.box.next(chatOf);
		expect(seenByA.n).toBe(1);
		expect(seenByA.label).toBe('Bob');
		expect(seenByA.text, 'NFKC/whitespace/Cf pipeline ran server-side').toBe('hello world');
		expect(seenByA.mine).toBe(false);
		const seenByB = await b.box.next(chatOf);
		expect(seenByB.mine, 'the author sees its own frame flagged per socket').toBe(true);
		expect(seenByB.n).toBe(1);

		send(a.socket, { v: 1, type: 'chat', text: 'second' });
		expect((await a.box.next(chatOf)).label).toBe('Alice');
		expect((await b.box.next(chatOf)).label).toBe('Alice');

		// §5.3: chat is a transport feature, never room state.
		const rooms = await sqlRows<{ revision: number; state_json: string }>(code, 'SELECT revision, state_json FROM game_room WHERE id = 1');
		expect(Number(rooms[0].revision)).toBe(0);
		expect(rooms[0].state_json).toBe('{}');
		void a.socket; void b.socket;
	});

	it('replays history after reconnect in order, chunked, with mine flags and author labels', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A);
		const a = await connect(code, PRINCIPAL_A, LABEL_A);
		await a.box.next(snapshotOf);
		send(a.socket, { v: 1, type: 'chat', text: 'one' });
		await a.box.next(chatOf);
		send(a.socket, { v: 1, type: 'chat', text: 'two' });
		await a.box.next(chatOf);
		a.socket.close(1000, 'reload');
		await a.box.closed();

		// 30 pre-seeded rows prove the 25-per-frame chunking (25 + 5).
		const aHash = await principalHash(PRINCIPAL_A);
		await runInDurableObject(stubFor(code), (_instance: GameRoom, state) => {
			for (let index = 0; index < 30; index += 1) {
				state.storage.sql.exec(
					'INSERT INTO game_room_chat (label, principal_hash, text, created_at, removed) VALUES (?, ?, ?, ?, NULL)',
					'Alice', aHash, `seed-${index}`, 1_700_000_000_000 + index,
				);
			}
		});

		const rejoined = await connect(code, PRINCIPAL_A, LABEL_A);
		await rejoined.box.next(snapshotOf);
		const first = await rejoined.box.next(historyOf);
		const second = await rejoined.box.next(historyOf);
		const frames = [first, second];
		expect((first.messages as BoxFrame[]).length).toBe(25);
		expect(first.more).toBe(true);
		expect((second.messages as BoxFrame[]).length, '2 live + 30 seeded = 32 → 25 + 7').toBe(7);
		expect(second.more).toBe(false);
		const ordered = frames.flatMap((frame) => (frame.messages as Array<BoxFrame>).map((message) => Number(message.n)));
		expect(ordered, 'history arrives in ascending n').toEqual([...ordered].sort((x, y) => x - y));
		expect(ordered.length).toBe(32);
		const live = frames.flatMap((frame) => frame.messages as BoxFrame[]).filter((message) => message.text === 'one' || message.text === 'two');
		expect(live.length).toBe(2);
		expect(live.every((message) => message.mine === true), 'own messages flagged for the reconnecting author').toBe(true);
		void rejoined.socket;
	});

	it('soft-rejects invalid text without closing the socket', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A);
		const a = await connect(code, PRINCIPAL_A, LABEL_A);
		await a.box.next(snapshotOf);

		send(a.socket, { v: 1, type: 'chat', text: '   ' });
		expect(await a.box.next((frame) => frame.type === 'chat_rejected')).toMatchObject({ error: 'invalid_text' });
		send(a.socket, { v: 1, type: 'chat', text: 'x'.repeat(CHAT_CONFIG.maxTextLength + 1) });
		expect(await a.box.next((frame) => frame.type === 'chat_rejected')).toMatchObject({ error: 'invalid_text' });

		// The socket survived both refusals.
		send(a.socket, { v: 1, type: 'chat', text: 'still here' });
		expect((await a.box.next(chatOf)).text).toBe('still here');
		void a.socket;
	});
});

describe('GameRoom — chat rate limits (plan §5.4)', () => {
	it('soft-rejects past the per-member burst, keeps the socket open, and admits after refill', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A);
		const a = await connect(code, PRINCIPAL_A, LABEL_A);
		await a.box.next(snapshotOf);

		for (let index = 0; index < CHAT_CONFIG.rate.burst; index += 1) {
			send(a.socket, { v: 1, type: 'chat', text: `burst-${index}` });
			expect((await a.box.next(chatOf)).text).toBe(`burst-${index}`);
		}
		send(a.socket, { v: 1, type: 'chat', text: 'too fast' });
		const rejected = await a.box.next((frame) => frame.type === 'chat_rejected');
		expect(rejected.error).toBe('rate_limited');
		expect(Number(rejected.retryAfterMs)).toBeGreaterThan(0);
		expect(Number(rejected.retryAfterMs)).toBeLessThanOrEqual(CHAT_CONFIG.rate.refillMs);

		// Soft: a second denied send still produces a frame on an OPEN socket.
		send(a.socket, { v: 1, type: 'chat', text: 'still too fast' });
		expect((await a.box.next((frame) => frame.type === 'chat_rejected')).error).toBe('rate_limited');

		await delay(CHAT_CONFIG.rate.refillMs + 400);
		send(a.socket, { v: 1, type: 'chat', text: 'after refill' });
		expect((await a.box.next(chatOf)).text).toBe('after refill');
		void a.socket;
	});

	it('closes with 1013 only past the pre-parse global ceiling', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A);
		const a = await connect(code, PRINCIPAL_A, LABEL_A);
		await a.box.next(snapshotOf);

		// 17 frames guarantee ≥9 land in one wall-clock second (pigeonhole),
		// which is past the 8/s global ceiling — earlier frames in the burst
		// are chat frames (bucket-denied after 5) and never close on their own.
		for (let index = 0; index < 17; index += 1) {
			try { send(a.socket, { v: 1, type: 'chat', text: `flood-${index}` }); } catch { break; }
		}
		const closed = await a.box.closed(10_000);
		expect(closed.code).toBe(1013);
	});
});

describe('GameRoom — moderation inside the room (plan §5.5)', () => {
	it('host removes, author self-deletes, tombstones persist, actions are logged', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A);
		const a = await connect(code, PRINCIPAL_A, LABEL_A);
		await a.box.next(snapshotOf);
		const b = await connect(code, PRINCIPAL_B, LABEL_B);
		await b.box.next(snapshotOf);
		await a.box.next(membersOf);

		const chatText = (text: string) => (frame: BoxFrame): boolean => frame.type === 'chat' && frame.text === text;
		send(b.socket, { v: 1, type: 'chat', text: 'mine' });
		await a.box.next(chatText('mine'));
		await b.box.next(chatText('mine'));
		send(a.socket, { v: 1, type: 'chat', text: 'host text' });
		const fromA = await b.box.next(chatText('host text'));
		await a.box.next(chatText('host text'));
		send(b.socket, { v: 1, type: 'chat', text: 'also mine' });
		await a.box.next(chatText('also mine'));
		await b.box.next(chatText('also mine'));

		// B is neither the author nor the host: refused, softly.
		send(b.socket, { v: 1, type: 'chat_delete', n: Number(fromA.n) });
		expect(await b.box.next((frame) => frame.type === 'chat_rejected')).toMatchObject({ error: 'not_allowed' });

		// Host removes B's first message.
		const bFirst = await sqlRows<{ n: number }>(code, "SELECT n FROM game_room_chat WHERE text = 'mine'");
		send(a.socket, { v: 1, type: 'chat_delete', n: Number(bFirst[0].n) });
		expect(await b.box.next((frame) => frame.type === 'chat_delete')).toMatchObject({ n: Number(bFirst[0].n), source: 'host' });
		expect(await a.box.next((frame) => frame.type === 'chat_delete')).toMatchObject({ source: 'host' });

		// Author self-deletes its own message.
		const bLast = await sqlRows<{ n: number }>(code, "SELECT n FROM game_room_chat WHERE text = 'also mine'");
		send(b.socket, { v: 1, type: 'chat_delete', n: Number(bLast[0].n) });
		expect(await a.box.next((frame) => frame.type === 'chat_delete')).toMatchObject({ n: Number(bLast[0].n), source: 'self' });

		const rows = await sqlRows<{ text: string; removed: string | null }>(code, 'SELECT text, removed FROM game_room_chat ORDER BY n');
		const tombstones = rows.filter((row) => row.removed !== null);
		expect(tombstones.length).toBe(2);
		expect(tombstones.every((row) => row.text === ''), 'tombstones keep sequence numbers but hold no text').toBe(true);
		const log = await sqlRows<{ action: string }>(code, 'SELECT action FROM game_room_chat_log ORDER BY id');
		expect(log.map((row) => row.action)).toEqual(['delete_host', 'delete_self']);

		// Tombstones survive into history for late/reconnecting members.
		b.socket.close(1000, 'reload');
		await b.box.closed();
		const back = await connect(code, PRINCIPAL_B, LABEL_B);
		await back.box.next(snapshotOf);
		const history = await back.box.next(historyOf);
		const seen = (history.messages as BoxFrame[]).filter((message) => message.removed);
		expect(seen.length).toBe(2);
		void a.socket; void back.socket;
	});

	it('mute survives reconnect, kick closes 4003, and only the host may act', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A);
		const a = await connect(code, PRINCIPAL_A, LABEL_A);
		await a.box.next(snapshotOf);
		const b = await connect(code, PRINCIPAL_B, LABEL_B);
		await b.box.next(snapshotOf);
		const roster = await a.box.next((frame) => membersOf(frame) && (frame.members as unknown[]).length >= 2);
		const bMemberId = (roster.members as Array<{ memberId: string; isSelf: boolean; label: string }>).
			find((member) => !member.isSelf && member.label === 'Bob')?.memberId;
		expect(bMemberId).toBeTruthy();

		// Only the host may kick/mute; B is refused.
		send(b.socket, { v: 1, type: 'kick', member: 'a'.repeat(24) });
		expect(await b.box.next((frame) => frame.type === 'chat_rejected')).toMatchObject({ error: 'not_allowed' });
		// The host cannot kick itself.
		send(a.socket, { v: 1, type: 'kick', member: (roster.members as Array<{ memberId: string; isSelf: boolean }>).find((member) => member.isSelf)!.memberId });
		expect(await a.box.next((frame) => frame.type === 'chat_rejected')).toMatchObject({ error: 'invalid_target' });

		// Host mutes B: roster reflects it, B's sends are refused, socket stays open.
		send(a.socket, { v: 1, type: 'mute', member: bMemberId! });
		const mutedRoster = await a.box.next((frame) => frame.type === 'members' && (frame.members as Array<{ muted: boolean }>).some((member) => member.muted));
		expect(mutedRoster).toBeTruthy();
		send(b.socket, { v: 1, type: 'chat', text: 'let me in' });
		expect(await b.box.next((frame) => frame.type === 'chat_rejected')).toMatchObject({ error: 'muted' });

		// Mute is principal-scoped: it survives B reconnecting with a new socket.
		b.socket.close(1000, 'reconnect');
		await b.box.closed();
		const bAgain = await connect(code, PRINCIPAL_B, LABEL_B);
		await bAgain.box.next(snapshotOf);
		send(bAgain.socket, { v: 1, type: 'chat', text: 'still muted?' });
		expect(await bAgain.box.next((frame) => frame.type === 'chat_rejected')).toMatchObject({ error: 'muted' });

		// Kick: B's socket closes 4003 and its membership row is gone — but the
		// seat is not B's to take back. The lockout row makes the removal durable
		// for the room's lifetime, so a rejoin is upgraded and closed at once.
		send(a.socket, { v: 1, type: 'kick', member: bMemberId! });
		expect((await bAgain.box.closed()).code).toBe(4003);
		const members = await sqlRows<{ count: number }>(code, 'SELECT COUNT(*) AS count FROM game_room_members');
		expect(Number(members[0].count)).toBe(1);
		const kicks = await sqlRows<{ principal_hash: string }>(code, 'SELECT principal_hash FROM game_room_kicks');
		expect(kicks.map((row) => row.principal_hash)).toEqual([await principalHash(PRINCIPAL_B)]);
		const rejoin = await connect(code, PRINCIPAL_B, LABEL_B);
		expect((await rejoin.box.closed()).code).toBe(4003);
		const membersAfter = await sqlRows<{ count: number }>(code, 'SELECT COUNT(*) AS count FROM game_room_members');
		expect(Number(membersAfter[0].count)).toBe(1);
		const log = await sqlRows<{ action: string }>(code, 'SELECT action FROM game_room_chat_log ORDER BY id');
		expect(log.map((row) => row.action)).toContain('mute');
		expect(log.map((row) => row.action)).toContain('kick');
		void a.socket; void rejoin.socket;
	});
});

describe('GameRoom — chat lifecycle', () => {
	it('alarm() deletes chat, log and mute rows with the room — nothing outlives it', async () => {
		const code = uniqueRoomCode();
		await createRoom(code, PRINCIPAL_A, Date.now() - ROOM_TTL_MS + 1_500);
		const a = await connect(code, PRINCIPAL_A, LABEL_A);
		await a.box.next(snapshotOf);
		send(a.socket, { v: 1, type: 'chat', text: 'about to expire' });
		await a.box.next(chatOf);
		expect(Number((await sqlRows<{ count: number }>(code, 'SELECT COUNT(*) AS count FROM game_room_chat'))[0].count)).toBe(1);

		await delay(1_700);
		await runDurableObjectAlarm(stubFor(code));
		expect((await a.box.closed()).code).toBe(4002);
		for (const table of ['game_room_chat', 'game_room_chat_log', 'game_room_mutes', 'game_room_members', 'game_room']) {
			const rows = await sqlRows<{ count: number }>(code, `SELECT COUNT(*) AS count FROM ${table}`);
			expect(Number(rows[0].count), `${table} deleted with the room`).toBe(0);
		}
	});

	it('refuses chat with chat_disabled when the config flag is off, leaving other frames working', async () => {
		CHAT_CONFIG.enabled = false;
		try {
			const code = uniqueRoomCode();
			await createRoom(code, PRINCIPAL_A);
			const a = await connect(code, PRINCIPAL_A, LABEL_A);
			await a.box.next(snapshotOf);
			send(a.socket, { v: 1, type: 'chat', text: 'disabled?' });
			expect(await a.box.next((frame) => frame.type === 'chat_rejected')).toMatchObject({ error: 'chat_disabled' });
			// Leave (a non-chat frame) still behaves normally.
			send(a.socket, { v: 1, type: 'leave' });
			expect((await a.box.closed()).code).toBe(1000);
		} finally {
			CHAT_CONFIG.enabled = true;
		}
	});
});
