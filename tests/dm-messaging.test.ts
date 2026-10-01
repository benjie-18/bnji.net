/**
 * Chat plan Phase D — private messaging: identity, D1 stores, retention,
 * export/deletion, and the /api/dm/* route guards through the real handlers
 * and the real migration SQL (same harness as tests/display-names.test.ts).
 *
 * Platform behaviour (hibernation sockets, live fanout) is covered by
 * tests/workerd/dm-conversation.spec.ts; browser wiring by
 * tests/e2e/messages.spec.ts (local Playwright run required).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './support/d1.mjs';
import { DM_CONFIG } from '../src/config/dm.config';
import {
	appendMessage, appendMessageClaimingAttachment, conversationIdFor, createAttachment,
	ensureConversation, exportDmData, getAttachmentForViewer, hideMessage, listConversations,
	listMessages, markRead, purgeDmRows, DM_UNCLAIMED_ATTACHMENT_TTL_MS,
} from '../src/server/dm-store';
import { sniffImageMime, decodeImageBase64, validateImageUpload } from '../src/server/image-sniff';
import { recordDmReport, exportDmReportsOnAccount, exportDmReportsFiled } from '../src/server/dm-reports';
import { deletePlayerAccount, sha256Hex } from '../src/server/player-store';

const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();
const accountApi = await import('../src/pages/api/games/account.ts');
const exportRoute = await import('../src/pages/api/games/account/export.ts');
const conversationsApi = await import('../src/pages/api/dm/conversations.ts');
const messagesApi = await import('../src/pages/api/dm/messages.ts');
const readApi = await import('../src/pages/api/dm/read.ts');
const hideApi = await import('../src/pages/api/dm/hide.ts');
const attachmentsApi = await import('../src/pages/api/dm/attachments.ts');
const reportApi = await import('../src/pages/api/dm/report.ts');
const wsApi = await import('../src/pages/api/dm/ws.ts');
const mediaApi = await import('../src/pages/api/dm/media/[id].ts');

// Store functions take D1Database; the node harness wrapper is sync-compatible at runtime.
const asD1 = (db: unknown): never => db as never;
const GUEST_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const GUEST_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const GUEST_C = 'cccccccccccccccccccccccccccccccc';

/* ------------------------------------------------------------------ harness */

type PushedFrame = { frame: Record<string, unknown> };

function database() {
	const db = createTestD1();
	for (const name of migrations) db.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
	const pushes: PushedFrame[] = [];
	globalThis.__BNJI_TEST_BINDINGS__ = {
		BOARD_DB: db,
		DM_CONVERSATIONS: {
			idFromName: (name: string) => name,
			get: () => ({
				fetch: async (request: Request) => {
					pushes.push(await request.json() as PushedFrame);
					return new Response('{}', { status: 200 });
				},
			}),
		},
	};
	globalThis.__BNJI_TEST_SECRETS__ = { ACCESS_SECRET: 'dm-test-secret' };
	return { db, pushes };
}

function requestContext(path: string, options: { method?: string; body?: unknown; cookie?: string; origin?: string; ip?: string; query?: string; params?: Record<string, string>; upgrade?: boolean } = {}): APIContext {
	const url = `http://localhost${path}${options.query ?? ''}`;
	const headers = new Headers({ origin: options.origin ?? 'http://localhost' });
	if (options.cookie) headers.set('cookie', options.cookie);
	if (options.ip) headers.set('cf-connecting-ip', options.ip);
	if (options.upgrade) headers.set('upgrade', 'websocket');
	if (options.body !== undefined) headers.set('content-type', 'application/json');
	const body = options.body === undefined ? undefined : JSON.stringify(options.body);
	const request = new Request(url, { method: options.method ?? 'GET', headers, ...(body === undefined ? {} : { body }) });
	return { request, url: new URL(url), params: options.params ?? {}, cookies: { get: () => undefined } } as unknown as APIContext;
}

function responseCookies(response: Response): string[] {
	return typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? ''];
}

function cookieValue(response: Response, name: string): string {
	const cookie = responseCookies(response).find((item) => item.startsWith(`${name}=`));
	assert.ok(cookie, `missing ${name} Set-Cookie`);
	return cookie!.slice(name.length + 1).split(';', 1)[0];
}

async function createAccount(guest: string, name: string, ip: string) {
	const response = await accountApi.POST(requestContext('/api/games/account', { method: 'POST', cookie: `bnji_ps=${guest}`, body: { action: 'create', displayName: name }, ip }));
	assert.equal(response.status, 201, await response.clone().text());
	return { cookie: `bnji_ps=${guest}; bnji_ga=${cookieValue(response, 'bnji_ga')}` };
}

async function claimHandle(cookie: string, handle: string, ip: string): Promise<Response> {
	return accountApi.POST(requestContext('/api/games/account', { method: 'POST', cookie, body: { action: 'set-handle', handle }, ip }));
}

function playerIdByName(db: { raw: ReturnType<typeof createTestD1>['raw'] }, displayName: string): string {
	const row = db.raw.prepare('SELECT id FROM game_players WHERE display_name = ?').get(displayName) as { id: string } | undefined;
	assert.ok(row, `player ${displayName} exists`);
	return row!.id;
}

/** 1×1 PNG header + padding — magic-byte validation never decodes pixels. */
const PNG_BASE64 = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52));
const GIF_BASE64 = btoa('GIF89a-not-allowed');

/* ------------------------------------------------------------ pure helpers */

test('conversation identity: sorted-pair digest is stable, ordered and hex', async () => {
	const forward = await conversationIdFor('player-one-id', 'player-two-id');
	const backward = await conversationIdFor('player-two-id', 'player-one-id');
	assert.equal(forward, backward, 'direction never matters (§7.2)');
	assert.match(forward, /^[a-f0-9]{64}$/);
	assert.notEqual(forward, await conversationIdFor('player-one-id', 'player-three-id'));

	const { db } = database();
	const first = await ensureConversation(asD1(db), 'player-two-id', 'player-one-id', 1_000);
	const second = await ensureConversation(asD1(db), 'player-one-id', 'player-two-id', 2_000);
	assert.equal(first.id, second.id, 'one row per pair, no matter who opens it');
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM dm_conversations').get() as { n: number }).n, 1);
	assert.ok(first.memberLo < first.memberHi, 'canonical member order');
});

test('image validation: magic bytes only, size ceiling, no SVG-style surprises', () => {
	assert.equal(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
	assert.equal(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
	assert.equal(sniffImageMime(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'image/webp');
	assert.equal(sniffImageMime(new Uint8Array([0x47, 0x49, 0x46, 0x38])), null, 'GIF is not on the allowlist');
	const widePng = validateImageUpload(PNG_BASE64);
	assert.ok(widePng.ok, 'PNG header passes');
	const oversize = decodeImageBase64('A'.repeat(1_866_668));
	assert.deepEqual(oversize, { ok: false, error: 'image_too_large' }, 'decoded ceiling hits before any decode work');
	assert.deepEqual(decodeImageBase64('%%%'), { ok: false, error: 'invalid_base64' });
});

/* -------------------------------------------------------------- D1 stores */

test('messages: append sequence, per-viewer mapping, unread watermark, preview', async () => {
	const { db } = database();
	const conv = await ensureConversation(asD1(db), 'p-a', 'p-b', 1_000);
	const first = await appendMessage(asD1(db), { conv, sender: 'p-a', body: 'hello', imageId: null, now: 2_000 });
	const second = await appendMessage(asD1(db), { conv, sender: 'p-b', body: 'hi back', imageId: null, now: 3_000 });
	assert.equal(first.n, 1);
	assert.equal(second.n, 2, 'sequence is monotone per conversation');

	const forA = await listMessages(asD1(db), { conv, viewerId: 'p-a' });
	assert.deepEqual(forA.map((m) => [m.n, m.from]), [[1, 'me'], [2, 'them']]);
	const forB = await listMessages(asD1(db), { conv, viewerId: 'p-b', after: 0 });
	assert.deepEqual(forB.map((m) => [m.n, m.from]), [[1, 'them'], [2, 'me']], 'after=0 is the catch-up pull (§7.3)');

	const listForA = await listConversations(asD1(db), 'p-a');
	assert.equal(listForA.length, 1);
	assert.equal(listForA[0].unread, 1, 'only the partner message counts as unread');
	assert.equal(listForA[0].mySide, conv.memberLo === 'p-a' ? 'lo' : 'hi');
	assert.equal(listForA[0].preview?.body, 'hi back');

	await markRead(asD1(db), conv.id, listForA[0].mySide, 2);
	const afterRead = await listConversations(asD1(db), 'p-a');
	assert.equal(afterRead[0].unread, 0, 'watermark clears unread');
	assert.equal(afterRead[0].myReadSeq, 2);
});

test('hide (D12) is per-viewer: gone for me, intact for them', async () => {
	const { db } = database();
	const conv = await ensureConversation(asD1(db), 'p-a', 'p-b', 1_000);
	await appendMessage(asD1(db), { conv, sender: 'p-b', body: 'delete me', imageId: null, now: 2_000 });
	const sideA = conv.memberLo === 'p-a' ? 'lo' : 'hi';
	const sideB: 'lo' | 'hi' = sideA === 'lo' ? 'hi' : 'lo';
	assert.equal(await hideMessage(asD1(db), conv.id, 1, sideA), true);
	assert.deepEqual(await listMessages(asD1(db), { conv, viewerId: 'p-a' }), [], 'hidden for the requester');
	assert.equal((await listMessages(asD1(db), { conv, viewerId: 'p-b' })).length, 1, 'still there for the sender');
	assert.equal(await hideMessage(asD1(db), conv.id, 99, sideB), false, 'unknown message numbers change nothing');
});

test('attachment claim: single use, correct uploader, claim+insert atomic', async () => {
	const { db } = database();
	const conv = await ensureConversation(asD1(db), 'p-a', 'p-b', 1_000);
	await createAttachment(asD1(db), { id: 'a'.repeat(32), convId: conv.id, uploader: 'p-a', mime: 'image/png', data: PNG_BASE64, now: 1_500 });
	const claimed = await appendMessageClaimingAttachment(asD1(db), { conv, sender: 'p-a', body: '', imageId: 'a'.repeat(32), now: 2_000 });
	assert.ok(claimed, 'first claim wins');
	assert.equal(claimed!.n, 1);
	const claimedRow = db.raw.prepare('SELECT claimed_n FROM dm_attachments WHERE id = ?').get('a'.repeat(32)) as { claimed_n: number };
	assert.equal(claimedRow.claimed_n, 1);
	const second = await appendMessageClaimingAttachment(asD1(db), { conv, sender: 'p-b', body: '', imageId: 'a'.repeat(32), now: 3_000 });
	assert.equal(second, null, 'second claim refuses — no message rows were added');
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM dm_messages').get() as { n: number }).n, 1);

	await createAttachment(asD1(db), { id: 'b'.repeat(32), convId: conv.id, uploader: 'p-b', mime: 'image/png', data: PNG_BASE64, now: 1_500 });
	const wrongUploader = await appendMessageClaimingAttachment(asD1(db), { conv, sender: 'p-a', body: '', imageId: 'b'.repeat(32), now: 4_000 });
	assert.equal(wrongUploader, null, 'only the uploader may claim');
	const attachment = await getAttachmentForViewer(asD1(db), 'a'.repeat(32), 'p-b');
	assert.equal(attachment?.mime, 'image/png', 'members can fetch media');
	assert.equal(await getAttachmentForViewer(asD1(db), 'a'.repeat(32), 'p-stranger'), null, 'strangers cannot');

	// Double-submit by the SAME uploader (the common 409 path): consumes no
	// sequence number and never advances the sender's watermark.
	const own = await appendMessageClaimingAttachment(asD1(db), { conv, sender: 'p-b', body: '', imageId: 'b'.repeat(32), now: 5_000 });
	assert.ok(own, 'the rightful uploader claims');
	assert.equal(own!.n, 2);
	const duplicate = await appendMessageClaimingAttachment(asD1(db), { conv, sender: 'p-b', body: '', imageId: 'b'.repeat(32), now: 6_000 });
	assert.equal(duplicate, null, 'the same attachment cannot be sent twice');
	const state = db.raw.prepare('SELECT last_seq, read_seq_hi FROM dm_conversations WHERE id = ?').get(conv.id) as { last_seq: number; read_seq_hi: number };
	assert.equal(state.last_seq, 2, 'the refused send burned no sequence number');
	assert.equal(state.read_seq_hi, 0, 'sending never moves your own read watermark (only explicit reads do — §7.1)');
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM dm_messages').get() as { n: number }).n, 2);
});

test('retention sweep: messages, unclaimed uploads, claimed orphans, report windows', async () => {
	const { db } = database();
	const now = 10_000_000_000;
	const day = 86_400_000;
	const conv = await ensureConversation(asD1(db), 'p-a', 'p-b', now - 100 * day);
	await appendMessage(asD1(db), { conv, sender: 'p-a', body: 'old', imageId: null, now: now - 61 * day });
	await appendMessage(asD1(db), { conv, sender: 'p-b', body: 'fresh', imageId: null, now: now - 1 * day });
	await createAttachment(asD1(db), { id: 'c'.repeat(32), convId: conv.id, uploader: 'p-a', mime: 'image/png', data: PNG_BASE64, now: now - 2 * DM_UNCLAIMED_ATTACHMENT_TTL_MS });
	await createAttachment(asD1(db), { id: 'd'.repeat(32), convId: conv.id, uploader: 'p-a', mime: 'image/png', data: PNG_BASE64, now: now - 5_000 });
	await createAttachment(asD1(db), { id: 'e'.repeat(32), convId: conv.id, uploader: 'p-a', mime: 'image/png', data: PNG_BASE64, now: now - 2 * day });
	const claimedFresh = await appendMessageClaimingAttachment(asD1(db), { conv, sender: 'p-a', body: '', imageId: 'e'.repeat(32), now: now - 2 * day });
	assert.ok(claimedFresh, 'a fresh image message claims its upload');
	await recordDmReport(asD1(db), { convId: conv.id, messageN: 1, snapshot: { sender: 'p-a', body: 'old', imageId: null, messageAt: now - 61 * day }, reporterId: 'p-b', now: now - 61 * day });
	await recordDmReport(asD1(db), { convId: conv.id, messageN: 2, snapshot: { sender: 'p-b', body: 'fresh', imageId: null, messageAt: now - day }, reporterId: 'p-a', now: now - 5_000 });

	const purged = await purgeDmRows(asD1(db), { now, messageCutoff: now - 60 * day, reportCutoff: now - 30 * day });
	assert.equal(purged.messages, 1, 'the 61-day-old message dies at the DM window');
	assert.equal(purged.unclaimed, 1, 'stale unclaimed uploads die after the TTL');
	assert.equal(purged.reports, 1, 'report snapshots follow the shared window');
	assert.equal(purged.reporters, 1);
	assert.equal((db.raw.prepare('SELECT body FROM dm_messages').get() as { body: string }).body, 'fresh');
	const survivors = (db.raw.prepare('SELECT id FROM dm_attachments').all() as { id: string }[]).map((row) => row.id).sort();
	assert.deepEqual(survivors, ['d'.repeat(32), 'e'.repeat(32)].sort(), 'fresh unclaimed + claimed-with-message survive');

	// Once its message ages out (or is deleted), the claimed attachment goes too.
	const aged = await purgeDmRows(asD1(db), { now: now + 100 * day, messageCutoff: now + 40 * day, reportCutoff: now + 40 * day });
	assert.ok(aged.messages >= 1);
	assert.ok((db.raw.prepare('SELECT COUNT(*) AS n FROM dm_attachments WHERE claimed_n IS NOT NULL').get() as { n: number }).n === 0, 'claimed orphans are swept');
});

/* -------------------------------------------------- export / deletion §9.5 */

test('export: conversations + history as me/them, hidden flag, bounded image bytes', async () => {
	const { db, pushes } = database();
	const alice = await createAccount(GUEST_A, 'Alice Export', '203.0.113.10');
	const bob = await createAccount(GUEST_B, 'Bob Export', '203.0.113.11');
	void pushes;
	await claimHandle(bob.cookie, 'bob_export', '203.0.113.11');
	const open = await conversationsApi.POST(requestContext('/api/dm/conversations', { method: 'POST', cookie: alice.cookie, body: { handle: 'bob_export' } }));
	assert.equal(open.status, 200, await open.clone().text());
	const conversationId = ((await open.json()) as { conversation: { id: string } }).conversation.id;

	await attachmentsApi.POST(requestContext('/api/dm/attachments', { method: 'POST', cookie: alice.cookie, body: { conversation: conversationId, data: PNG_BASE64 } }));
	const sent = await messagesApi.POST(requestContext('/api/dm/messages', { method: 'POST', cookie: alice.cookie, body: { conversation: conversationId, body: 'export me' } }));
	assert.equal(sent.status, 200, await sent.clone().text());
	const sentBody = await sent.json() as { message: { n: number } };
	await messagesApi.POST(requestContext('/api/dm/messages', { method: 'POST', cookie: bob.cookie, body: { conversation: conversationId, body: 'and me' } }));
	await hideApi.POST(requestContext('/api/dm/hide', { method: 'POST', cookie: alice.cookie, body: { conversation: conversationId, n: sentBody.message.n } }));

	const exported = await exportRoute.GET(requestContext('/api/games/account/export', { cookie: alice.cookie }));
	assert.equal(exported.status, 200, await exported.clone().text());
	const data = await exported.json() as {
		directMessages: { included: boolean; conversations: unknown[]; messages: Array<{ from: string; body: string; hiddenForMe: boolean }>; reportsOnYourMessages: unknown[]; reportsYouFiled: unknown[] };
	};
	assert.equal(data.directMessages.included, true);
	assert.equal(data.directMessages.conversations.length, 1);
	assert.equal(data.directMessages.messages.length, 2, 'both sides export to the participant');
	const mine = data.directMessages.messages.find((m) => m.body === 'export me');
	const theirs = data.directMessages.messages.find((m) => m.body === 'and me');
	assert.equal(mine?.from, 'me');
	assert.equal(theirs?.from, 'them');
	assert.equal(mine?.hiddenForMe, true, 'delete-for-me is recorded honestly');
	assert.equal(theirs?.hiddenForMe, false);

	// A report ABOUT Bob's message (n 2), filed by Alice — each hash exports on its own side.
	const aliceId = playerIdByName(db, 'Alice Export');
	const bobId = playerIdByName(db, 'Bob Export');
	await recordDmReport(asD1(db), { convId: conversationId, messageN: 2, snapshot: { sender: bobId, body: 'and me', imageId: null, messageAt: 1 }, reporterId: aliceId, now: 5 });
	assert.equal((await exportDmReportsOnAccount(asD1(db), await sha256Hex(`player:${bobId}`))).length, 1, 'reports ON your messages export');
	assert.equal((await exportDmReportsFiled(asD1(db), await sha256Hex(`player:${aliceId}`))).length, 1, 'reports YOU filed export');
});

test('account deletion cascades conversations, messages, attachments and keyed reports', async () => {
	const { db, pushes } = database();
	void pushes;
	const alice = await createAccount(GUEST_A, 'Alice Delete', '203.0.113.20');
	const bob = await createAccount(GUEST_B, 'Bob Delete', '203.0.113.21');
	await claimHandle(bob.cookie, 'bob_delete', '203.0.113.21');
	const open = await conversationsApi.POST(requestContext('/api/dm/conversations', { method: 'POST', cookie: alice.cookie, body: { handle: 'bob_delete' } }));
	const conversationId = ((await open.json()) as { conversation: { id: string } }).conversation.id;
	await messagesApi.POST(requestContext('/api/dm/messages', { method: 'POST', cookie: alice.cookie, body: { conversation: conversationId, body: 'soon gone' } }));
	await messagesApi.POST(requestContext('/api/dm/messages', { method: 'POST', cookie: bob.cookie, body: { conversation: conversationId, body: 'gone too — plan §9.3 cascade' } }));

	// Bob reports Alice's message before she deletes her account.
	await reportApi.POST(requestContext('/api/dm/report', { method: 'POST', cookie: bob.cookie, body: { conversation: conversationId, n: 1 } }));
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM dm_reports').get() as { n: number }).n, 1);

	await deletePlayerAccount(asD1(db), playerIdByName(db, 'Alice Delete'));
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM dm_conversations').get() as { n: number }).n, 0, 'conversations leave whole (§9.3)');
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM dm_messages').get() as { n: number }).n, 0);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM dm_attachments').get() as { n: number }).n, 0);
	assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM dm_reports').get() as { n: number }).n, 0, 'the report about her message is keyed to her principal');
});

/* ------------------------------------------------------------- route guards */

test('DM routes: membership, auth gates, vocabulary, kill switches', async () => {
	const { db, pushes } = database();
	const alice = await createAccount(GUEST_A, 'Alice', '203.0.113.30');
	const bob = await createAccount(GUEST_B, 'Bob', '203.0.113.31');
	const carol = await createAccount(GUEST_C, 'Carol', '203.0.113.32');
	await claimHandle(bob.cookie, 'bob_dm', '203.0.113.31');

	// Guest: no account → 401 on every surface.
	const guestList = await conversationsApi.GET(requestContext('/api/dm/conversations', { cookie: 'bnji_ps=99999999999999999999999999999999' }));
	assert.equal(guestList.status, 401, await guestList.clone().text());

	// Open by handle, then send.
	const open = await conversationsApi.POST(requestContext('/api/dm/conversations', { method: 'POST', cookie: alice.cookie, body: { handle: 'bob_dm' } }));
	assert.equal(open.status, 200, await open.clone().text());
	const opened = await open.json() as { conversation: { id: string; mySide: string; partner: { handle: string } } };
	assert.equal(opened.conversation.partner.handle, 'bob_dm');
	assert.equal(opened.conversation.mySide === 'lo' || opened.conversation.mySide === 'hi', true);

	const selfOpen = await conversationsApi.POST(requestContext('/api/dm/conversations', { method: 'POST', cookie: bob.cookie, body: { handle: 'bob_dm' } }));
	assert.equal(selfOpen.status, 403);
	assert.equal(((await selfOpen.json()) as { error: string }).error, 'self_conversation');
	const missingHandle = await conversationsApi.POST(requestContext('/api/dm/conversations', { method: 'POST', cookie: alice.cookie, body: { handle: 'nobody_home' } }));
	assert.equal(missingHandle.status, 404);

	const sent = await messagesApi.POST(requestContext('/api/dm/messages', { method: 'POST', cookie: alice.cookie, body: { conversation: opened.conversation.id, body: '  hello \u202E there  ' } }));
	assert.equal(sent.status, 200, await sent.clone().text());
	const sentBody = await sent.json() as { message: { n: number; body: string; from: string } };
	assert.equal(sentBody.message.body, 'hello there', 'shared sanitizer runs (bidi stripped, whitespace collapsed)');
	assert.equal(sentBody.message.from, 'me');

	const push = pushes.at(-1) as unknown as { frame: { t: string; m: { senderSide: string } } };
	assert.equal(push.frame.t, 'dm_new', 'the DO gets the live frame AFTER the D1 write (§7.3)');
	assert.equal(push.frame.m.senderSide, opened.conversation.mySide);

	// Membership: Carol is not in the conversation.
	const carolRead = await messagesApi.GET(requestContext('/api/dm/messages', { cookie: carol.cookie, query: `?conversation=${opened.conversation.id}` }));
	assert.equal(carolRead.status, 403, await carolRead.clone().text());
	assert.equal(((await carolRead.json()) as { error: string }).error, 'not_a_member');
	const bobRead = await messagesApi.GET(requestContext('/api/dm/messages', { cookie: bob.cookie, query: `?conversation=${opened.conversation.id}` }));
	assert.equal(bobRead.status, 200);
	const bobMessages = (await bobRead.json()) as { messages: Array<{ from: string }>; partnerReadSeq: number };
	assert.equal(bobMessages.messages[0].from, 'them');

	// Read watermark + read frame.
	const read = await readApi.POST(requestContext('/api/dm/read', { method: 'POST', cookie: bob.cookie, body: { conversation: opened.conversation.id } }));
	assert.equal(read.status, 200, await read.clone().text());
	assert.equal((pushes.at(-1) as { frame: { t: string } }).frame.t, 'dm_read');

	// Report: author can't self-report; distinct reporters count once; membership before content.
	const ownReport = await reportApi.POST(requestContext('/api/dm/report', { method: 'POST', cookie: alice.cookie, body: { conversation: opened.conversation.id, n: 1 } }));
	assert.equal(ownReport.status, 403);
	assert.equal(((await ownReport.json()) as { error: string }).error, 'report_own_message');
	const carolReport = await reportApi.POST(requestContext('/api/dm/report', { method: 'POST', cookie: carol.cookie, body: { conversation: opened.conversation.id, n: 1 } }));
	assert.equal(carolReport.status, 403);
	const firstReport = await reportApi.POST(requestContext('/api/dm/report', { method: 'POST', cookie: bob.cookie, body: { conversation: opened.conversation.id, n: 1 } }));
	assert.equal(firstReport.status, 200, await firstReport.clone().text());
	assert.equal(((await firstReport.json()) as { reportCount: number }).reportCount, 1);
	const repeatReport = await reportApi.POST(requestContext('/api/dm/report', { method: 'POST', cookie: bob.cookie, body: { conversation: opened.conversation.id, n: 1 } }));
	assert.equal(((await repeatReport.json()) as { reportCount: number }).reportCount, 1, 'distinct-report counting (same as Phase C)');

	// Rate budget: the 11th report in the window is refused (1 used above ×2… 10 allowed).
	let throttled = false;
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const next = await reportApi.POST(requestContext('/api/dm/report', { method: 'POST', cookie: bob.cookie, body: { conversation: opened.conversation.id, n: 1 } }));
		if (next.status === 429) { throttled = true; break; }
	}
	assert.ok(throttled, 'DM reports are budgeted per account (never KV)');

	// Images: upload, serve, refuse the wrong bytes, refuse when switched off.
	const upload = await attachmentsApi.POST(requestContext('/api/dm/attachments', { method: 'POST', cookie: alice.cookie, body: { conversation: opened.conversation.id, data: PNG_BASE64 } }));
	assert.equal(upload.status, 200, await upload.clone().text());
	const attachmentId = ((await upload.json()) as { attachment: { id: string } }).attachment.id;
	const media = await mediaApi.GET(requestContext('/api/dm/media/x', { cookie: alice.cookie, params: { id: attachmentId } }));
	assert.equal(media.status, 200, await media.clone().text());
	assert.equal(media.headers.get('content-type'), 'image/png', 'sniffed type, not a declared one');
	assert.equal(media.headers.get('x-content-type-options'), 'nosniff');
	assert.equal(media.headers.get('cache-control'), 'no-store');
	const mediaStranger = await mediaApi.GET(requestContext('/api/dm/media/x', { cookie: carol.cookie, params: { id: attachmentId } }));
	assert.equal(mediaStranger.status, 404, 'a stranger cannot even fetch bytes by id');

	const badUpload = await attachmentsApi.POST(requestContext('/api/dm/attachments', { method: 'POST', cookie: alice.cookie, body: { conversation: opened.conversation.id, data: GIF_BASE64 } }));
	assert.equal(badUpload.status, 422);
	assert.equal(((await badUpload.json()) as { error: string }).error, 'unsupported_image_type');
	const oversized = await attachmentsApi.POST(requestContext('/api/dm/attachments', { method: 'POST', cookie: alice.cookie, body: { conversation: opened.conversation.id, data: 'A'.repeat(1_866_668) } }));
	assert.equal(oversized.status, 413);
	assert.equal(((await oversized.json()) as { error: string }).error, 'image_too_large');

	const imageSend = await messagesApi.POST(requestContext('/api/dm/messages', { method: 'POST', cookie: alice.cookie, body: { conversation: opened.conversation.id, imageId: attachmentId } }));
	const imageSendDetail = await imageSend.clone().text();
	assert.equal(imageSend.status, 200, imageSendDetail);
	const doubleSend = await messagesApi.POST(requestContext('/api/dm/messages', { method: 'POST', cookie: alice.cookie, body: { conversation: opened.conversation.id, imageId: attachmentId } }));
	assert.equal(doubleSend.status, 409, 'a claimed attachment cannot be reused');
	assert.equal(((await doubleSend.json()) as { error: string }).error, 'attachment_not_available');

	// WebSocket upgrade boundary: origin + upgrade + membership.
	const noUpgrade = await wsApi.GET(requestContext('/api/dm/ws', { cookie: alice.cookie, query: `?conversation=${opened.conversation.id}` }));
	assert.equal(noUpgrade.status, 426);
	const badOrigin = await wsApi.GET(requestContext('/api/dm/ws', { cookie: alice.cookie, query: `?conversation=${opened.conversation.id}`, origin: 'https://attacker.test', upgrade: true }));
	assert.equal(badOrigin.status, 403);

	// Kill switch: enabled=false refuses everything DM.
	const previous = DM_CONFIG.enabled;
	try {
		DM_CONFIG.enabled = false;
		const disabled = await messagesApi.GET(requestContext('/api/dm/messages', { cookie: alice.cookie, query: `?conversation=${opened.conversation.id}` }));
		assert.equal(disabled.status, 403);
		assert.equal(((await disabled.json()) as { error: string }).error, 'dm_disabled');
	} finally {
		DM_CONFIG.enabled = previous;
	}
	const previousImages = DM_CONFIG.images.enabled;
	try {
		DM_CONFIG.images.enabled = false;
		const disabledImages = await attachmentsApi.POST(requestContext('/api/dm/attachments', { method: 'POST', cookie: alice.cookie, body: { conversation: opened.conversation.id, data: PNG_BASE64 } }));
		assert.equal(disabledImages.status, 403);
		assert.equal(((await disabledImages.json()) as { error: string }).error, 'images_disabled');
	} finally {
		DM_CONFIG.images.enabled = previousImages;
	}
	void db;
});

test('DM routes: conversation not found is a 404, and the invalid id shape never queries', async () => {
	database();
	const alice = await createAccount(GUEST_A, 'Alice Edge', '203.0.113.40');
	const missing = await messagesApi.GET(requestContext('/api/dm/messages', { cookie: alice.cookie, query: `?conversation=${'f'.repeat(64)}` }));
	assert.equal(missing.status, 404, await missing.clone().text());
	const malformed = await messagesApi.GET(requestContext('/api/dm/messages', { cookie: alice.cookie, query: '?conversation=nope' }));
	assert.equal(malformed.status, 400);
});
