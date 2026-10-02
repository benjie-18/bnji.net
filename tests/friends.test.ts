/**
 * Chat plan Phase E — friends, presence and notifications: identity rules,
 * the D1 store, the D7 friendship gate on DM, export/deletion, and the
 * /api/friends, /api/presence, /api/notifications route guards through the
 * real handlers and the real migration SQL (same harness as
 * tests/dm-messaging.test.ts).
 *
 * Platform behaviour (the Presence DO inside real workerd: snapshots,
 * announcements, multi-tab) is covered by tests/workerd/presence.spec.ts;
 * browser wiring by tests/e2e/friends.spec.ts (local Playwright run required).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './support/d1.mjs';
import { FRIENDS_CONFIG } from '../src/config/friends.config';
import {
	friendAction, friendGateState, listFriendState, countPendingFriendRequests,
} from '../src/server/friend-store';
import { countUnreadDmMessages } from '../src/server/dm-store';
import { deletePlayerAccount } from '../src/server/player-store';

const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();
const accountApi = await import('../src/pages/api/games/account.ts');
const exportRoute = await import('../src/pages/api/games/account/export.ts');
const friendsApi = await import('../src/pages/api/friends.ts');
const notificationsApi = await import('../src/pages/api/notifications.ts');
const presenceApi = await import('../src/pages/api/presence.ts');
const conversationsApi = await import('../src/pages/api/dm/conversations.ts');
const messagesApi = await import('../src/pages/api/dm/messages.ts');
const attachmentsApi = await import('../src/pages/api/dm/attachments.ts');
const readApi = await import('../src/pages/api/dm/read.ts');

// Store functions take D1Database; the node harness wrapper is sync-compatible at runtime.
const asD1 = (db: unknown): never => db as never;
const GUEST_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const GUEST_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const GUEST_C = 'cccccccccccccccccccccccccccccccc';

/* ------------------------------------------------------------------ harness */

type CapturedPresence = { url: string; headers: Record<string, string>; body?: unknown };

function database() {
	const db = createTestD1();
	for (const name of migrations) db.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
	const presenceCalls: CapturedPresence[] = [];
	globalThis.__BNJI_TEST_BINDINGS__ = {
		BOARD_DB: db,
		DM_CONVERSATIONS: {
			idFromName: (name: string) => name,
			get: () => ({ fetch: async () => new Response('{}', { status: 200 }) }),
		},
		PRESENCE: {
			idFromName: (name: string) => name,
			get: () => ({
				fetch: async (request: Request) => {
					const headers: Record<string, string> = {};
					request.headers.forEach((value, key) => { headers[key] = value; });
					const body = request.method === 'POST' ? await request.clone().json().catch(() => null) : undefined;
					presenceCalls.push({ url: request.url, headers, body });
					// Node cannot mint a real 101 response; the route then
					// answers 200 and the test asserts the minted headers.
					const responseBody = request.url.endsWith('/admin/refresh')
						? { refreshedHandles: (body as { handles?: string[] } | null)?.handles ?? [] }
						: {};
					return new Response(JSON.stringify(responseBody), { status: 200 });
				},
			}),
		},
	};
	globalThis.__BNJI_TEST_SECRETS__ = { ACCESS_SECRET: 'friends-test-secret' };
	return { db, presenceCalls };
}

function requestContext(path: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string; ip?: string; query?: string; upgrade?: boolean } = {}): APIContext {
	const url = `http://localhost${path}${options.query ?? ''}`;
	const headers = new Headers({ origin: options.origin ?? 'http://localhost' });
	if (options.cookie) headers.set('cookie', options.cookie);
	if (options.ip) headers.set('cf-connecting-ip', options.ip);
	if (options.upgrade) headers.set('upgrade', 'websocket');
	if (options.body !== undefined) headers.set('content-type', 'application/json');
	const body = options.body === undefined ? undefined : JSON.stringify(options.body);
	const request = new Request(url, { method: options.method ?? 'GET', headers, ...(body === undefined ? {} : { body }) });
	return { request, url: new URL(url), params: {}, cookies: { get: () => undefined } } as unknown as APIContext;
}

function responseCookies(response: Response): string[] {
	const list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? ''];
	return list.filter(Boolean);
}

function cookieValue(response: Response, name: string): string {
	const cookie = responseCookies(response).find((item) => item.startsWith(`${name}=`));
	assert.ok(cookie, `missing ${name} Set-Cookie`);
	return cookie!.slice(name.length + 1).split(';', 1)[0];
}

async function createAccount(guest: string, name: string, ip: string): Promise<string> {
	const response = await accountApi.POST(requestContext('/api/games/account', { method: 'POST', cookie: `bnji_ps=${guest}`, body: { action: 'create', displayName: name }, ip }));
	assert.equal(response.status, 201, await response.clone().text());
	return `bnji_ps=${guest}; bnji_ga=${cookieValue(response, 'bnji_ga')}`;
}

async function claimHandle(cookie: string, handle: string, ip: string): Promise<void> {
	const response = await accountApi.POST(requestContext('/api/games/account', { method: 'POST', cookie, body: { action: 'set-handle', handle }, ip }));
	assert.equal(response.status, 200, await response.clone().text());
}

function playerIdByName(db: { raw: ReturnType<typeof createTestD1>['raw'] }, displayName: string): string {
	const row = db.raw.prepare('SELECT id FROM game_players WHERE display_name = ?').get(displayName) as { id: string } | undefined;
	assert.ok(row, `player ${displayName} exists`);
	return row!.id;
}

async function friend(cookie: string, method: 'POST' | 'DELETE', action: string, handle: string): Promise<Response> {
	return friendsApi[method](requestContext('/api/friends', { method, cookie, body: { action, handle } }));
}

type ListsBody = {
	changed?: string;
	friends: Array<{ handle: string; displayName: string }>;
	incoming: Array<{ handle: string }>;
	outgoing: Array<{ handle: string }>;
	blocked: Array<{ handle: string }>;
	config?: { maxFriends: number; maxPendingOutgoing: number };
	presenceSynced?: boolean;
	error?: string;
};

async function body(response: Response): Promise<ListsBody> {
	return await response.json() as ListsBody;
}

/** Two signed-in accounts with handles, in a fresh database. */
async function pair(options: { blockDb?: boolean } = {}) {
	const store = database();
	const alice = await createAccount(GUEST_A, 'Alice', '198.51.100.1');
	const bob = await createAccount(GUEST_B, 'Bob', '198.51.100.2');
	await claimHandle(alice, 'alice', '198.51.100.1');
	await claimHandle(bob, 'bob', '198.51.100.2');
	void options.blockDb;
	return { ...store, alice, bob, aliceId: playerIdByName(store.db, 'Alice'), bobId: playerIdByName(store.db, 'Bob') };
}

/* ------------------------------------------------------- §8.1 state machine */

test('friends: request → accept lifecycle, mutual auto-accept, decline, remove', async () => {
	const { db, alice, bob, carolCookie } = await (async () => {
		const store = await pair();
		const carol = await createAccount(GUEST_C, 'Carol', '198.51.100.3');
		await claimHandle(carol, 'carol', '198.51.100.3');
		return { ...store, carolCookie: carol };
	})();

	// Request by exact handle.
	const sent = await friend(alice, 'POST', 'request', 'bob');
	assert.equal(sent.status, 200, await sent.clone().text());
	assert.equal((await body(sent)).changed, 'requested');
	const afterRequest = await body(await friendsApi.GET(requestContext('/api/friends', { cookie: alice })));
	assert.deepEqual(afterRequest.outgoing.map((row) => row.handle), ['bob']);
	const bobView = await body(await friendsApi.GET(requestContext('/api/friends', { cookie: bob })));
	assert.deepEqual(bobView.incoming.map((row) => row.handle), ['alice'], 'the recipient sees it as incoming');
	assert.equal(bobView.incoming.length, 1);

	// Duplicate + self + unknown + bad shape.
	const dup = await friend(alice, 'POST', 'request', 'bob');
	assert.equal(dup.status, 409);
	assert.equal((await body(dup)).error, 'already_pending');
	const self = await friend(alice, 'POST', 'request', 'alice');
	assert.equal(self.status, 400);
	assert.equal((await body(self)).error, 'self_friend');
	const unknown = await friend(alice, 'POST', 'request', 'nobody_here');
	assert.equal(unknown.status, 404);
	assert.equal((await body(unknown)).error, 'not_found');
	const badShape = await friend(alice, 'POST', 'request', 'Bob!');
	assert.equal(badShape.status, 400);
	assert.equal((await body(badShape)).error, 'invalid_handle');

	// Only the recipient may accept; accepting twice is already_friends.
	const wrongAccept = await friend(alice, 'POST', 'accept', 'bob');
	assert.equal(wrongAccept.status, 409);
	assert.equal((await body(wrongAccept)).error, 'already_pending', 'the requester still waits — their own request');
	const accepted = await friend(bob, 'POST', 'accept', 'alice');
	assert.equal(accepted.status, 200, await accepted.clone().text());
	assert.equal((await body(accepted)).changed, 'friends');
	const again = await friend(bob, 'POST', 'accept', 'alice');
	assert.equal(again.status, 409);
	assert.equal((await body(again)).error, 'already_friends');

	// Both sides now list each other as accepted friends.
	for (const cookie of [alice, bob]) {
		const lists = await body(await friendsApi.GET(requestContext('/api/friends', { cookie })));
		assert.equal(lists.friends.length, 1);
		assert.equal(lists.config?.maxFriends, FRIENDS_CONFIG.maxFriends);
	}
	assert.equal(await friendGateState(asD1(db), playerIdByName(db, 'Alice'), playerIdByName(db, 'Bob')), 'friends');

	// Mutual pending → auto-accept (§8.1).
	assert.equal((await friend(alice, 'POST', 'request', 'carol')).status, 200);
	const mutual = await friend(carolCookie, 'POST', 'request', 'alice');
	assert.equal(mutual.status, 200, await mutual.clone().text());
	assert.equal((await body(mutual)).changed, 'friends', 'a mutual request becomes friends automatically');

	// Remove is symmetric and immediate.
	const removed = await friend(alice, 'DELETE', 'remove', 'bob');
	assert.equal(removed.status, 200);
	assert.equal((await body(removed)).changed, 'removed');
	assert.equal(await friendGateState(asD1(db), playerIdByName(db, 'Alice'), playerIdByName(db, 'Bob')), 'none');
	const bobAfter = await body(await friendsApi.GET(requestContext('/api/friends', { cookie: bob })));
	assert.equal(bobAfter.friends.length, 0, 'removal shows on both sides');
});

test('friends: decline then re-request is a fresh pending row', async () => {
	const { alice, bob } = await pair();
	assert.equal((await friend(alice, 'POST', 'request', 'bob')).status, 200);
	const declined = await friend(bob, 'POST', 'decline', 'alice');
	assert.equal(declined.status, 200);
	assert.equal((await body(declined)).changed, 'declined');
	// Decliner cannot decline again; the requester cannot accept.
	const again = await friend(bob, 'POST', 'decline', 'alice');
	assert.equal(again.status, 404);
	const wrong = await friend(alice, 'POST', 'accept', 'bob');
	assert.equal(wrong.status, 404);
	// Re-request works — the declined row resets to pending.
	const retry = await friend(alice, 'POST', 'request', 'bob');
	assert.equal(retry.status, 200, await retry.clone().text());
	assert.equal((await body(retry)).changed, 'requested');
	const incoming = await body(await friendsApi.GET(requestContext('/api/friends', { cookie: bob })));
	assert.deepEqual(incoming.incoming.map((row) => row.handle), ['alice']);

	// The SENDER can cancel their own outgoing request with DELETE remove —
	// otherwise a never-answered row would sit forever and count against
	// maxPendingOutgoing. The recipient cannot use remove on an incoming row
	// (their verb stays decline).
	const byRecipient = await friend(bob, 'DELETE', 'remove', 'alice');
	assert.equal(byRecipient.status, 404, 'incoming pending is not removable by the recipient');
	const cancelled = await friend(alice, 'DELETE', 'remove', 'bob');
	assert.equal(cancelled.status, 200, await cancelled.clone().text());
	assert.equal((await body(cancelled)).changed, 'cancelled');
	const afterCancel = await body(await friendsApi.GET(requestContext('/api/friends', { cookie: alice })));
	assert.deepEqual(afterCancel.outgoing, [], 'the cancelled request is gone');
	assert.equal((await friend(alice, 'POST', 'request', 'bob')).status, 200, 'cancelling frees the pair for a fresh request');
});

test('friends: block wins — removes friendship, cancels pending, denies new, unblock restores', async () => {
	const { db, alice, bob, aliceId, bobId } = await pair();

	// Pending request from Alice → Bob blocks → pending gone, request denied both ways.
	await friend(alice, 'POST', 'request', 'bob');
	const blocked = await friend(bob, 'POST', 'block', 'alice');
	assert.equal(blocked.status, 200);
	assert.equal((await body(blocked)).changed, 'blocked');
	const deniedRequest = await friend(alice, 'POST', 'request', 'bob');
	assert.equal(deniedRequest.status, 403);
	assert.equal((await body(deniedRequest)).error, 'blocked', 'the blocked side cannot even re-request');
	const lists = await body(await friendsApi.GET(requestContext('/api/friends', { cookie: alice })));
	assert.equal(lists.outgoing.length, 0, 'the pending request was cancelled by the block');
	assert.equal(await friendGateState(asD1(db), aliceId, bobId), 'blocked');

	// Friendship dies too when a block lands after acceptance.
	await friend(bob, 'DELETE', 'unblock', 'alice');
	await friend(alice, 'POST', 'request', 'bob');
	await friend(bob, 'POST', 'accept', 'alice');
	assert.equal(await friendGateState(asD1(db), aliceId, bobId), 'friends');
	await friend(bob, 'POST', 'block', 'alice');
	assert.equal(await friendGateState(asD1(db), aliceId, bobId), 'blocked', 'block removes the friendship (§8.1)');
	assert.equal((await body(await friendsApi.GET(requestContext('/api/friends', { cookie: alice })))).friends.length, 0);

	// Unblock → requests possible again.
	const unblocked = await friend(bob, 'DELETE', 'unblock', 'alice');
	assert.equal(unblocked.status, 200);
	assert.equal((await body(unblocked)).changed, 'unblocked');
	assert.equal((await friend(alice, 'POST', 'request', 'bob')).status, 200);
	// Blocking with no block row → not_found.
	const noop = await friend(alice, 'DELETE', 'unblock', 'nobody_here');
	assert.equal(noop.status, 404);
});

test('friends: caps (§8.1) — 500 accepted, 100 pending outgoing', async () => {
	const { db, alice } = await pair();
	const me = playerIdByName(db, 'Alice');
	// 500 accepted rows (arbitrary opponent ids — the count is pair-scoped).
	for (let i = 0; i < 500; i += 1) {
		const other = `f${String(i).padStart(31, '0')}`;
		const [lo, hi] = me < other ? [me, other] : [other, me];
		db.raw.prepare("INSERT INTO player_friends (player_a, player_b, state, requested_by, created_at, updated_at) VALUES (?, ?, 'accepted', ?, 1, 1)").run(lo, hi, me);
	}
	// A fresh target exists so the request passes validation and hits the cap.
	const carol = await createAccount(GUEST_C, 'Carol Cap', '198.51.100.9');
	await claimHandle(carol, 'carol_cap', '198.51.100.9');
	const overLimit = await friend(alice, 'POST', 'request', 'carol_cap');
	assert.equal(overLimit.status, 409, await overLimit.clone().text());
	assert.equal((await body(overLimit)).error, 'friends_limit');
	assert.equal((await countPendingFriendRequests(asD1(db), me)), 0);

	// Pending cap: 100 waiting outgoing requests.
	db.raw.exec('DELETE FROM player_friends');
	for (let i = 0; i < 100; i += 1) {
		const other = `p${String(i).padStart(31, '0')}`;
		const [lo, hi] = me < other ? [me, other] : [other, me];
		db.raw.prepare("INSERT INTO player_friends (player_a, player_b, state, requested_by, created_at, updated_at) VALUES (?, ?, 'pending', ?, 1, 1)").run(lo, hi, me);
	}
	const tooManyPending = await friend(alice, 'POST', 'request', 'carol_cap');
	assert.equal(tooManyPending.status, 409, await tooManyPending.clone().text());
	assert.equal((await body(tooManyPending)).error, 'pending_limit');
});

test('friends: rate budget (D1, never KV) and the friends_disabled kill switch', async () => {
	const { alice } = await pair();
	// requestsPerMinute = 20; every POST burns budget before validation.
	let last: Response | null = null;
	for (let i = 0; i < 21; i += 1) {
		last = await friend(alice, 'POST', 'request', 'nobody_home');
		if (last.status === 429) break;
	}
	assert.equal(last!.status, 429, await last!.clone().text());
	assert.equal((await body(last!)).error, 'rate_limited');
	assert.ok(last!.headers.get('retry-after'), 'retry-after header rides the 429');

	// §14 rollback: switch off → route 403, DM gate reverts to open.
	const flag = FRIENDS_CONFIG as unknown as { enabled: boolean };
	flag.enabled = false;
	try {
		const disabled = await friendsApi.GET(requestContext('/api/friends', { cookie: alice }));
		assert.equal(disabled.status, 403);
		assert.equal((await body(disabled)).error, 'friends_disabled');
	} finally {
		flag.enabled = true;
	}
});

/* --------------------------------------------------- D7 gate: DM is friends-only */

test('DM gate: open/send/attachments answer not_friends until the pair is friends', async () => {
	const { db, alice, bob, aliceId, bobId } = await pair();

	// Open by handle without friendship → 403 not_friends (the D7 answer).
	const openDenied = await conversationsApi.POST(requestContext('/api/dm/conversations', { method: 'POST', cookie: alice, body: { handle: 'bob' } }));
	assert.equal(openDenied.status, 403, await openDenied.clone().text());
	assert.equal((await openDenied.json() as { error: string }).error, 'not_friends');

	// Membership-shaped requests with a fabricated conversation id stay
	// membership-gated (unknown id → conversation_not_found, not not_friends).
	const ghost = await messagesApi.POST(requestContext('/api/dm/messages', { method: 'POST', cookie: alice, body: { conversation: 'ab'.repeat(32), body: 'hi' } }));
	assert.equal(ghost.status, 404);

	// Become friends → open works, send works, attachments work.
	await friend(alice, 'POST', 'request', 'bob');
	await friend(bob, 'POST', 'accept', 'alice');
	const open = await conversationsApi.POST(requestContext('/api/dm/conversations', { method: 'POST', cookie: alice, body: { handle: 'bob' } }));
	assert.equal(open.status, 200, await open.clone().text());
	const conversationId = ((await open.json()) as { conversation: { id: string } }).conversation.id;
	const sent = await messagesApi.POST(requestContext('/api/dm/messages', { method: 'POST', cookie: alice, body: { conversation: conversationId, body: 'hello friend' } }));
	assert.equal(sent.status, 200, await sent.clone().text());
	const png = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52));
	const upload = await attachmentsApi.POST(requestContext('/api/dm/attachments', { method: 'POST', cookie: alice, body: { conversation: conversationId, data: png } }));
	assert.equal(upload.status, 200, await upload.clone().text());

	// A block removes the friendship → sends die for BOTH sides (§8.1).
	await friend(bob, 'POST', 'block', 'alice');
	const aliceDenied = await messagesApi.POST(requestContext('/api/dm/messages', { method: 'POST', cookie: alice, body: { conversation: conversationId, body: 'still there?' } }));
	assert.equal(aliceDenied.status, 403);
	assert.equal((await aliceDenied.json() as { error: string }).error, 'blocked');
	const bobDenied = await messagesApi.POST(requestContext('/api/dm/messages', { method: 'POST', cookie: bob, body: { conversation: conversationId, body: 'me neither' } }));
	assert.equal(bobDenied.status, 403, 'the blocker cannot send either — the friendship is gone');
	assert.equal((await bobDenied.json() as { error: string }).error, 'blocked');

	// Reads stay membership-gated even while sends are blocked (plan §8/§10).
	const history = await messagesApi.GET(requestContext('/api/dm/messages', { cookie: alice, query: `?conversation=${conversationId}` }));
	assert.equal(history.status, 200, await history.clone().text());
	const marked = await readApi.POST(requestContext('/api/dm/read', { method: 'POST', cookie: alice, body: { conversation: conversationId, seq: 1 } }));
	assert.equal(marked.status, 200, await marked.clone().text());
	void bobId; void aliceId; void db;
});

test('DM gate: with the friends switch off, Phase D open behaviour returns', async () => {
	const { alice, bob } = await pair();
	const flag = FRIENDS_CONFIG as unknown as { enabled: boolean };
	flag.enabled = false;
	try {
		const open = await conversationsApi.POST(requestContext('/api/dm/conversations', { method: 'POST', cookie: alice, body: { handle: 'bob' } }));
		assert.equal(open.status, 200, await open.clone().text());
	} finally {
		flag.enabled = true;
	}
	void bob;
});

/* --------------------------------------------------- §8.3 notifications + route guards */

test('notifications: unread messages + incoming requests, one honest number', async () => {
	const { db, alice, bob } = await pair();
	// Signed-out → 401 (badge stays hidden for guests).
	const guest = await notificationsApi.GET(requestContext('/api/notifications', { cookie: 'bnji_ps=99999999999999999999999999999999' }));
	assert.equal(guest.status, 401);

	// Incoming friend request counts.
	await friend(alice, 'POST', 'request', 'bob');
	let counts = await (await notificationsApi.GET(requestContext('/api/notifications', { cookie: bob }))).json() as { unreadMessages: number; pendingFriendRequests: number };
	assert.deepEqual(counts, { unreadMessages: 0, pendingFriendRequests: 1 });
	assert.equal((await friend(bob, 'POST', 'accept', 'alice')).status, 200);
	counts = await (await notificationsApi.GET(requestContext('/api/notifications', { cookie: bob }))).json() as typeof counts;
	assert.equal(counts.pendingFriendRequests, 0, 'accepting clears the request count');

	// Unread DM counts past Bob's watermark, from Alice.
	const open = await conversationsApi.POST(requestContext('/api/dm/conversations', { method: 'POST', cookie: alice, body: { handle: 'bob' } }));
	const conversationId = ((await open.json()) as { conversation: { id: string } }).conversation.id;
	await messagesApi.POST(requestContext('/api/dm/messages', { method: 'POST', cookie: alice, body: { conversation: conversationId, body: 'ping' } }));
	assert.equal(await countUnreadDmMessages(asD1(db), playerIdByName(db, 'Bob')), 1);
	counts = await (await notificationsApi.GET(requestContext('/api/notifications', { cookie: bob }))).json() as typeof counts;
	assert.equal(counts.unreadMessages, 1);
	// Marking read moves it for Bob only.
	await readApi.POST(requestContext('/api/dm/read', { method: 'POST', cookie: bob, body: { conversation: conversationId, seq: 1 } }));
	counts = await (await notificationsApi.GET(requestContext('/api/notifications', { cookie: bob }))).json() as typeof counts;
	assert.equal(counts.unreadMessages, 0);
	assert.equal(await countUnreadDmMessages(asD1(db), playerIdByName(db, 'Alice')), 0, 'her own send never unreads herself (the 66bc7f8 watermark contract)');
});

test('friendship changes refresh the counterpart presence socket, pending requests do not', async () => {
	const { alice, bob, presenceCalls } = await pair();
	const refreshes = (): CapturedPresence[] => presenceCalls.filter((call) => call.url.endsWith('/admin/refresh'));

	assert.equal((await friend(alice, 'POST', 'request', 'bob')).status, 200);
	assert.equal(refreshes().length, 0, 'pending requests do not alter presence visibility');

	const mutual = await friend(bob, 'POST', 'request', 'alice');
	assert.equal(mutual.status, 200, await mutual.clone().text());
	const mutualBody = await body(mutual);
	assert.equal(mutualBody.changed, 'friends');
	assert.equal(mutualBody.presenceSynced, true, 'the caller can rely on the DO refresh instead of reconnecting twice');
	assert.deepEqual(refreshes()[0]?.body, { handles: ['alice', 'bob'] }, 'both sides refresh after mutual auto-accept');

	const removed = await friend(bob, 'DELETE', 'remove', 'alice');
	assert.equal(removed.status, 200, await removed.clone().text());
	assert.deepEqual(refreshes()[1]?.body, { handles: ['alice', 'bob'] }, 'unfriend invalidates both attachments');
});

test('presence route: origin/upgrade/account guards, then minted headers for the DO', async () => {
	const { alice, bob, aliceId, presenceCalls } = await pair();
	// Make the pair friends so the friend-handles header has content.
	await friend(alice, 'POST', 'request', 'bob');
	await friend(bob, 'POST', 'accept', 'alice');

	const badOrigin = await presenceApi.GET(requestContext('/api/presence', { cookie: alice, origin: 'https://attacker.test', upgrade: true }));
	assert.equal(badOrigin.status, 403);
	const noUpgrade = await presenceApi.GET(requestContext('/api/presence', { cookie: alice }));
	assert.equal(noUpgrade.status, 426);
	const guest = await presenceApi.GET(requestContext('/api/presence', { cookie: 'bnji_ps=99999999999999999999999999999999', upgrade: true }));
	assert.equal(guest.status, 401);

	const upgraded = await presenceApi.GET(requestContext('/api/presence', { cookie: alice, upgrade: true }));
	// The namespace stub answers 200 in node; the route then appends cookies.
	assert.equal(upgraded.status, 200, await upgraded.clone().text());
	const websocketCalls = presenceCalls.filter((entry) => entry.url.endsWith('/ws'));
	assert.equal(websocketCalls.length, 1);
	const call = websocketCalls[0]!;
	assert.match(call.url, /\/ws$/);
	assert.equal(call.headers['x-bnji-verified-principal'], `player:${aliceId}`);
	assert.equal(call.headers['x-bnji-handle'], 'alice');
	assert.deepEqual(JSON.parse(call.headers['x-bnji-friend-handles'] ?? '[]'), ['bob'], 'only ACCEPTED friends ride the header (§8.1) — pending/blocked never do');

	// Pending is not a friend: Alice requests Carol (not accepted) → header without carol.
	const carol = await createAccount(GUEST_C, 'Carol', '198.51.100.4');
	await claimHandle(carol, 'carol', '198.51.100.4');
	await friend(alice, 'POST', 'request', 'carol');
	await presenceApi.GET(requestContext('/api/presence', { cookie: alice, upgrade: true }));
	const refreshedWebsocketCalls = presenceCalls.filter((entry) => entry.url.endsWith('/ws'));
	assert.deepEqual(JSON.parse(refreshedWebsocketCalls[1]!.headers['x-bnji-friend-handles'] ?? '[]'), ['bob'], 'pending requests are not friends yet');

	// Kill switch and connect budget.
	const flag = FRIENDS_CONFIG as unknown as { enabled: boolean };
	flag.enabled = false;
	try {
		const disabled = await presenceApi.GET(requestContext('/api/presence', { cookie: alice, upgrade: true }));
		assert.equal(disabled.status, 403);
	} finally {
		flag.enabled = true;
	}
});

/* ------------------------------------------- §9.5 export / deletion cascade */

test('export + deletion: friend rows are account data (§9.5)', async () => {
	const { db, alice, bob, aliceId, bobId } = await pair();
	await friend(alice, 'POST', 'request', 'bob');
	await friend(bob, 'POST', 'accept', 'alice');
	await friend(bob, 'POST', 'block', 'carolless'); // 404, no row — sanity that only real rows export
	const exported = await exportRoute.GET(requestContext('/api/games/account/export', { cookie: alice }));
	assert.equal(exported.status, 200, await exported.clone().text());
	const data = await exported.json() as { friends: { friends: Array<{ handle: string }>; incoming: unknown[]; outgoing: unknown[]; blocked: unknown[] } };
	assert.deepEqual(data.friends.friends.map((row) => row.handle), ['bob'], 'accepted friendship exports with handle labels');
	assert.equal(data.friends.incoming.length, 0);

	// Cascade: Alice deletes → her rows leave; Bob's side loses the pair.
	await deletePlayerAccount(asD1(db), aliceId);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM player_friends').get() as { n: number }).n, 0, 'pair rows cascade (§9.1)');
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM player_blocks WHERE blocker = ?1 OR blocked = ?1').get(aliceId) as { n: number } | null)?.n ?? 0, 0);
	assert.equal((await listFriendState(asD1(db), bobId)).friends.length, 0, 'the other side no longer lists a deleted account');
});

test('friend store: friendAction handles handle-shape validation before any query', async () => {
	const { db, aliceId } = await pair();
	const outcome = await friendAction(asD1(db), aliceId, 'request', 'UPPER', Date.now());
	assert.deepEqual(outcome, { ok: false, error: 'invalid_handle', status: 400 });
});
