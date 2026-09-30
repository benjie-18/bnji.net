/**
 * Chat plan Phase B — protocol-level room chat rules (pure, node:test).
 * Platform behaviour (DO storage, sockets, hibernation) is covered by
 * tests/workerd/room-chat.spec.ts; this file locks the parsers, the shared
 * text sanitising, history packing against the client's frame guard, and the
 * per-member token bucket.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CHAT_CONFIG } from '../src/config/chat.config';
import {
	consumeChatToken, packChatHistory, parseRoomClientMessage, parseRoomStateMessage,
	ROOM_MAX_OUTBOUND_FRAME_BYTES, sanitizeChatText, type RoomChatFrame,
} from '../src/server/game-room-protocol';

test('chat client frames parse structure-only and reject malformed shapes', () => {
	const ok = parseRoomClientMessage(JSON.stringify({ v: 1, type: 'chat', text: 'hello' }));
	assert.equal(ok.ok, true);
	if (ok.ok && ok.message.type === 'chat') assert.equal(ok.message.text, 'hello');

	assert.equal(parseRoomClientMessage(JSON.stringify({ v: 1, type: 'chat', text: 'hi', extra: 1 })).ok, false);
	assert.equal(parseRoomClientMessage(JSON.stringify({ v: 1, type: 'chat', text: 42 })).ok, false);
	assert.equal(parseRoomClientMessage(JSON.stringify({ v: 2, type: 'chat', text: 'hi' })).ok, false);
	// The 4 KiB envelope cap still applies before any chat handling.
	const tooBig = parseRoomClientMessage(JSON.stringify({ v: 1, type: 'chat', text: 'x'.repeat(5_000) }));
	assert.equal(tooBig.ok, false);
	if (!tooBig.ok) assert.equal(tooBig.error, 'too_large');

	const del = parseRoomClientMessage(JSON.stringify({ v: 1, type: 'chat_delete', n: 7 }));
	assert.equal(del.ok, true);
	if (del.ok && del.message.type === 'chat_delete') assert.equal(del.message.n, 7);
	assert.equal(parseRoomClientMessage(JSON.stringify({ v: 1, type: 'chat_delete', n: 0 })).ok, false);
	assert.equal(parseRoomClientMessage(JSON.stringify({ v: 1, type: 'chat_delete', n: '7' })).ok, false);

	const member = 'a'.repeat(24);
	for (const type of ['kick', 'mute']) {
		const parsed = parseRoomClientMessage(JSON.stringify({ v: 1, type, member }));
		assert.equal(parsed.ok, true, type);
		assert.equal(parseRoomClientMessage(JSON.stringify({ v: 1, type, member: 'short' })).ok, false, type);
		assert.equal(parseRoomClientMessage(JSON.stringify({ v: 1, type, member: `${member}ff` })).ok, false, type);
	}
	// State parsing must not let chat-shaped messages through the named parser.
	const state = parseRoomStateMessage(JSON.stringify({ v: 1, type: 'chat', text: 'hi' }));
	assert.equal(state.ok, false);
	assert.equal(parseRoomStateMessage(JSON.stringify({ v: 1, type: 'state', baseRevision: 0, state: {} })).ok, true);
});

test('chat text runs the shared sanitising pipeline with the chat length cap', () => {
	assert.deepEqual(sanitizeChatText('  hello   world  '), { ok: true, text: 'hello world' });
	assert.deepEqual(sanitizeChatText('ﬁne — really?! 100%'), { ok: true, text: 'fine — really?! 100%' }, 'punctuation and em dash are plain text');
	assert.deepEqual(sanitizeChatText('a\u202Eb'), { ok: true, text: 'ab' }, 'bidi override stripped');
	assert.deepEqual(sanitizeChatText('a\tb\nc'), { ok: true, text: 'a b c' }, 'whitespace controls collapse');
	assert.deepEqual(sanitizeChatText('🎉 party'), { ok: true, text: '🎉 party' }, 'emoji are chat text, unlike display names');
	assert.equal(sanitizeChatText('   ').ok, false);
	assert.equal(sanitizeChatText('').ok, false);
	const atCap = 'x'.repeat(CHAT_CONFIG.maxTextLength);
	assert.equal(sanitizeChatText(atCap).ok, true);
	const over = sanitizeChatText(`${atCap}x`);
	assert.equal(over.ok, false);
	if (!over.ok) assert.equal(over.error, 'too_long');
	// Astral code points count as one, not two.
	assert.equal(sanitizeChatText('𐀀'.repeat(CHAT_CONFIG.maxTextLength)).ok, true);
	assert.equal(sanitizeChatText('𐀀'.repeat(CHAT_CONFIG.maxTextLength + 1)).ok, false);
});

test('history packing respects both the message-count and the outbound byte guard', () => {
	const make = (n: number, text: string): RoomChatFrame => ({ v: 1, type: 'chat', n, label: 'Player', text, at: 1_700_000_000_000, mine: false });
	const encoder = new TextEncoder();

	// Many short messages: capped at 25 per frame, every frame under the guard.
	const short: RoomChatFrame[] = Array.from({ length: 60 }, (_, index) => make(index + 1, 'ok'));
	const shortChunks = packChatHistory(short, CHAT_CONFIG.historyChunkMessages);
	assert.ok(shortChunks.length >= 3);
	for (const chunk of shortChunks) {
		assert.ok(chunk.messages.length <= CHAT_CONFIG.historyChunkMessages);
		assert.ok(encoder.encode(JSON.stringify(chunk)).byteLength <= ROOM_MAX_OUTBOUND_FRAME_BYTES);
	}
	assert.deepEqual(shortChunks.flatMap((chunk) => chunk.messages.map((message) => message.n)), short.map((message) => message.n), 'order and completeness preserved');
	assert.equal(shortChunks.at(-1)?.more, false);
	assert.ok(shortChunks.slice(0, -1).every((chunk) => chunk.more), 'more=true while another chunk follows');

	// Long messages: byte packing cuts BEFORE 25 so no frame trips the guard.
	const long: RoomChatFrame[] = Array.from({ length: 40 }, (_, index) => make(index + 1, 'y'.repeat(CHAT_CONFIG.maxTextLength)));
	const longChunks = packChatHistory(long, CHAT_CONFIG.historyChunkMessages);
	assert.ok(longChunks.length > 2, 'long frames must split below the count cap');
	for (const chunk of longChunks) {
		assert.ok(encoder.encode(JSON.stringify(chunk)).byteLength <= ROOM_MAX_OUTBOUND_FRAME_BYTES, 'byte guard holds');
	}
	assert.deepEqual(longChunks.flatMap((chunk) => chunk.messages.map((message) => message.n)), long.map((message) => message.n));
	assert.deepEqual(packChatHistory([], CHAT_CONFIG.historyChunkMessages), []);
});

test('the per-member chat token bucket bursts, denies, refills, and caps', () => {
	const limits = { burst: CHAT_CONFIG.rate.burst, refillMs: CHAT_CONFIG.rate.refillMs };
	const now = 1_000_000;
	// First send on a fresh connection: initialises the bucket and passes.
	const first = consumeChatToken(null, now, limits);
	assert.equal(first.allowed, true, 'first send initialises the bucket');
	let state = first.state;
	// The rest of the burst passes at the same instant…
	for (let index = 1; index < limits.burst; index += 1) {
		const result = consumeChatToken(state, now, limits);
		assert.equal(result.allowed, true, `send ${index + 1} inside the burst`);
		state = result.state;
	}
	// …the next is soft-denied with a bounded retry hint.
	const denied = consumeChatToken(state, now, limits);
	assert.equal(denied.allowed, false);
	assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= limits.refillMs);
	state = denied.state;
	// A partial refill is not enough…
	const stillDenied = consumeChatToken(state, now + Math.floor(limits.refillMs / 2), limits);
	assert.equal(stillDenied.allowed, false);
	// …one full refill interval later exactly one token exists.
	const refilled = consumeChatToken(state, now + limits.refillMs, limits);
	assert.equal(refilled.allowed, true);
	// The bucket never exceeds the burst, whatever state it inherits.
	const overfull = consumeChatToken({ tokens: 99, at: now }, now, limits);
	assert.equal(overfull.state.tokens, limits.burst - 1);
	// …and it refills from `null` again after hibernation-style loss.
	assert.equal(consumeChatToken(undefined, now, limits).allowed, true);
});
