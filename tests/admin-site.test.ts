/**
 * Admin deepening — site-wide tracking groups and the messaging-health view.
 *
 * Two surfaces, both admin-gated, both read-only over tables that already
 * exist (nothing new is collected — per the owner's instruction the usual
 * docs-register ceremony is skipped for this batch, so this file is the
 * contract instead):
 *
 *   GET /api/admin/stats       → site { topPaths, live, referrers }
 *   GET /api/admin/chat/rooms  → dmMeta { conversations, health }
 *
 * Guards, host-collapse of referrers, same-host exclusion, window
 * boundaries, the D10 metadata shape (handles + counts, never bodies or
 * player IDs), aggregate-only friend health, and the Presence DO's
 * service-authenticated count are all asserted here; the DO path itself is
 * locked by tests/workerd/presence.spec.ts.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './support/d1.mjs';
import { hashAdminToken } from '../src/server/admin';

const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();
const statsApi = await import('../src/pages/api/admin/stats.ts');
const chatRoomsApi = await import('../src/pages/api/admin/chat/rooms.ts');

const asD1 = (db: unknown): never => db as never;
const ADMIN_TOKEN = 'site-admin-token-123456';
const DAY = 86_400_000;

function database() {
	const db = createTestD1();
	for (const name of migrations) db.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
	globalThis.__BNJI_TEST_BINDINGS__ = {
		BOARD_DB: db,
		DM_CONVERSATIONS: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response('{}', { status: 200 }) }) },
		PRESENCE: {
			idFromName: (name: string) => name,
			get: () => ({
				fetch: async (request: Request) => {
					if (new URL(request.url).pathname === '/admin/stats') {
						return new Response(JSON.stringify({ sockets: 2, handles: 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
					}
					return new Response('{}', { status: 200 });
				},
			}),
		},
	};
	globalThis.__BNJI_TEST_SECRETS__ = { ACCESS_SECRET: 'admin-site-secret' };
	return { db };
}

function requestContext(path: string, options: { bearer?: string } = {}): APIContext {
	const url = `http://localhost${path}`;
	const headers = new Headers({ origin: 'http://localhost' });
	if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
	const request = new Request(url, { method: 'GET', headers });
	return { request, url: new URL(url), params: {}, cookies: { get: () => undefined } } as unknown as APIContext;
}

/** Seed everything the new groups read. */
async function seed(db: ReturnType<typeof createTestD1>): Promise<void> {
	const now = Date.now();
	const hash = await hashAdminToken(ADMIN_TOKEN);
	db.raw.prepare('UPDATE admin_credentials SET token_hash = ? WHERE id = 1').run(hash);

	// profile_views: two recent /friends/ sessions, one recent /, one 9 days
	// old (outside the 7-day window), one 40 days old (outside everything).
	const view = db.raw.prepare('INSERT INTO profile_views (profile_slug, session_key, day_key, created_at) VALUES (?, ?, ?, ?)');
	view.run('/friends/', 'sess-a', 'd1', now - 1_000);
	view.run('/friends/', 'sess-b', 'd1', now - 2_000);
	view.run('/', 'sess-a', 'd1', now - 3_000);
	view.run('/', 'sess-old', 'd0', now - 9 * DAY);
	view.run('/blog/', 'sess-ancient', 'd-40', now - 40 * DAY);

	// security_events page-view rows with referrers (the referrer source).
	const event = db.raw.prepare(
		`INSERT INTO security_events (surface, profile_slug, endpoint, ip_address, created_at, referrer)
		 VALUES ('profile', ?, 'page-view', ?, ?, ?)`,
	);
	event.run('/friends/', '203.0.113.9', now - 1_000, 'https://twitter.com/some/status/1');
	event.run('/', '203.0.113.9', now - 2_000, 'https://Sub.Example.com/page?q=1');
	event.run('/', '203.0.113.9', now - 3_000, 'http://localhost/');       // same host → excluded
	event.run('/', '203.0.113.9', now - 40 * DAY, 'https://old.example.org/'); // outside 30 days

	// Accounts + a DM conversation with two messages and one open report.
	const player = db.raw.prepare('INSERT INTO game_players (id, recovery_hash, display_name, handle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
	player.run('a'.repeat(32), '0a'.repeat(32), 'Admin Alpha', 'admin_alpha', now - DAY, now - DAY);
	player.run('b'.repeat(32), '0b'.repeat(32), 'Admin Beta', 'admin_beta', now - DAY, now - DAY);
	db.raw.prepare(
		`INSERT INTO dm_conversations (id, member_lo, member_hi, created_at, last_message_at, last_seq)
		 VALUES (?, ?, ?, ?, ?, 2)`,
	).run('c'.repeat(64), 'a'.repeat(32), 'b'.repeat(32), now - DAY, now - 1_000);
	const message = db.raw.prepare('INSERT INTO dm_messages (conv_id, n, sender, body, created_at) VALUES (?, ?, ?, ?, ?)');
	message.run('c'.repeat(64), 1, 'a'.repeat(32), 'hello there', now - 2_000);
	message.run('c'.repeat(64), 2, 'b'.repeat(32), 'hi back', now - 1_500);
	db.raw.prepare(
		`INSERT INTO dm_reports (conv_id, message_n, author_hash, reporter_hash, body, message_at, first_reported_at, reported_at, status)
		 VALUES (?, 2, ?, ?, 'hi back', ?, ?, ?, 'open')`,
	).run('c'.repeat(64), 'author-hash', 'reporter-hash', now - 1_000, now - 1_000, now - 1_000);

	// Friends: two accepted, one pending, one block (aggregate counts only).
	const friend = db.raw.prepare(
		"INSERT INTO player_friends (player_a, player_b, state, requested_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
	);
	friend.run('a'.repeat(32), 'f1'.padEnd(32, '0'), 'accepted', 'a'.repeat(32), now, now);
	friend.run('b'.repeat(32), 'f2'.padEnd(32, '0'), 'accepted', 'b'.repeat(32), now, now);
	friend.run('a'.repeat(32), 'f3'.padEnd(32, '0'), 'pending', 'a'.repeat(32), now, now);
	db.raw.prepare('INSERT INTO player_blocks (blocker, blocked, created_at) VALUES (?, ?, ?)').run('b'.repeat(32), 'f3'.padEnd(32, '0'), now);
}

test('admin stats: site group — top paths, live window, referrer hosts without our own host', async () => {
	const { db } = database();
	await seed(db);

	const denied = await statsApi.GET(requestContext('/api/admin/stats'));
	assert.equal(denied.status, 401, await denied.clone().text());

	const allowed = await statsApi.GET(requestContext('/api/admin/stats', { bearer: ADMIN_TOKEN }));
	assert.equal(allowed.status, 200, await allowed.clone().text());
	const data = await allowed.json() as {
		site: {
			topPaths: { path: string; views: number; uniques: number }[];
			live: { views: number; visitors: number; paths: { path: string; views: number }[] };
			referrers: { host: string; count: number }[];
			windows: { topPathsDays: number; liveMinutes: number; referrersDays: number };
		};
	};

	// 7-day leaderboard: /friends/ (2 recent) leads / (1 recent); 9-day-old row excluded.
	assert.equal(data.site.topPaths[0]?.path, '/friends/');
	assert.equal(data.site.topPaths[0]?.views, 2);
	assert.equal(data.site.topPaths[0]?.uniques, 2);
	assert.ok(!data.site.topPaths.some((row) => row.path === '/blog/'), 'ancient rows stay outside the window');
	assert.ok(data.site.topPaths.some((row) => row.path === '/'), 'recent / counts');

	// Live window: three fresh views, two distinct sessions, two paths.
	assert.equal(data.site.live.views, 3);
	assert.equal(data.site.live.visitors, 2);
	assert.equal(data.site.live.paths.length, 2);
	assert.equal(data.site.windows.liveMinutes, 30);

	// Referrers collapse to hosts, keep counts, drop same-host and stale rows.
	const hosts = data.site.referrers.map((row) => row.host);
	assert.ok(hosts.includes('twitter.com'));
	assert.ok(hosts.includes('sub.example.com'), 'host is lowercased');
	assert.equal(data.site.referrers.find((row) => row.host === 'sub.example.com')?.count, 1);
	assert.ok(!hosts.includes('localhost'), 'our own host is excluded');
	assert.ok(!hosts.includes('old.example.org'), 'outside the 30-day window');
});

test('admin chat: dmMeta metadata (D10) + aggregate health, never bodies or player IDs', async () => {
	const { db } = database();
	await seed(db);

	const denied = await chatRoomsApi.GET(requestContext('/api/admin/chat/rooms'));
	assert.equal(denied.status, 401, await denied.clone().text());

	const allowed = await chatRoomsApi.GET(requestContext('/api/admin/chat/rooms', { bearer: ADMIN_TOKEN }));
	assert.equal(allowed.status, 200, await allowed.clone().text());
	const raw = await allowed.text();
	const data = JSON.parse(raw) as {
		dmMeta: {
			conversations: { id: string; participants: { handle: string | null; displayName: string }[]; messages: number; reports: number }[];
			health: {
				accounts: { total: number; new7d: number };
				messages: { conversations: number; sent24h: number };
				reports: { open: number; total: number };
				friends: { accepted: number; pending: number; blocks: number };
				presence: { sockets: number; handles: number } | null;
			};
		};
	};

	// Metadata: participants as handles, counts, no bodies in the payload.
	const conversation = data.dmMeta.conversations[0];
	assert.ok(conversation, 'the seeded conversation is listed');
	assert.deepEqual(conversation.participants.map((p) => p.handle), ['admin_alpha', 'admin_beta']);
	assert.equal(conversation.messages, 2);
	assert.equal(conversation.reports, 1);
	// dmMeta itself must be body-free; the only bodies this endpoint carries
	// are the Phase-D report SNAPSHOTS in dmReports (the approved D10 path).
	const metaJson = JSON.stringify(data.dmMeta);
	assert.ok(!metaJson.includes('hello there') && !metaJson.includes('hi back'), 'conversation metadata carries no message bodies (D10)');
	assert.ok(!raw.includes('a'.repeat(32)) && !raw.includes('b'.repeat(32)), 'player IDs never reach any payload (§12.3)');

	// Health aggregates.
	const health = data.dmMeta.health;
	assert.equal(health.accounts.total, 2);
	assert.equal(health.accounts.new7d, 2);
	assert.equal(health.messages.conversations, 1);
	assert.equal(health.messages.sent24h, 2);
	assert.deepEqual(health.reports, { open: 1, total: 1 });
	assert.deepEqual(health.friends, { accepted: 2, pending: 1, blocks: 1 });
	assert.deepEqual(health.presence, { sockets: 2, handles: 1 }, 'Presence DO count rides the service token');
});
