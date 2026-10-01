/**
 * Chat plan Phase E — the `Presence` Durable Object inside real workerd
 * (hibernation, socket attachments and DO plumbing behave exactly as in
 * production — the reason this runner exists beside `node:test`, plan §13).
 *
 * The DO's contract (plan §8.2): one global instance, attachments only,
 * no durable state, no heartbeat. A connect answers with a snapshot of which
 * of MY friends are already online; every connect/close announces the handle
 * ONLY to sockets whose attachment lists it; a handle goes offline when its
 * last socket closes (multiple tabs stay online, unlike DM's replace).
 * The route never lets a browser choose those headers — this spec feeds the
 * DO exactly what /api/presence mints.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SocketBox, delay, type BoxFrame } from './support';

const HEX_A = 'a'.repeat(32);
const HEX_B = 'b'.repeat(32);
const HEX_C = 'c'.repeat(32);
const HEX_D = 'd'.repeat(32);

function stub() {
	return env.PRESENCE.get(env.PRESENCE.idFromName('global'));
}

function headers(handle: string | null, friends: string[] | null, principal: string | null = `player:${HEX_A}`): Record<string, string> {
	const result: Record<string, string> = { upgrade: 'websocket' };
	if (principal !== null) result['x-bnji-verified-principal'] = principal;
	if (handle !== null) result['x-bnji-handle'] = handle;
	if (friends !== null) result['x-bnji-friend-handles'] = JSON.stringify(friends);
	return result;
}

async function connect(handle: string | null, friends: string[] | null, options: { principal?: string | null } = {}): Promise<{ socket: WebSocket | null; box: SocketBox | null; status: number }> {
	const response = await stub().fetch(new Request('https://presence.test/ws', {
		method: 'GET',
		headers: headers(handle, friends, options.principal === undefined ? `player:${HEX_A}` : options.principal),
	}));
	if (response.status !== 101) return { socket: null, box: null, status: response.status };
	const socket = response.webSocket;
	if (!socket) throw new Error('101 response carried no webSocket');
	socket.accept();
	return { socket, box: new SocketBox(socket), status: 101 };
}

const snapshotOf = (frame: BoxFrame): boolean => frame.t === 'presence_snapshot';
const onlineOf = (handle: string) => (frame: BoxFrame): boolean => frame.t === 'presence_change' && frame.handle === handle && frame.online === true;
const offlineOf = (handle: string) => (frame: BoxFrame): boolean => frame.t === 'presence_change' && frame.handle === handle && frame.online === false;

const openSockets: WebSocket[] = [];
async function track(result: { socket: WebSocket | null; box: SocketBox | null; status: number }): Promise<SocketBox> {
	expect(result.status).toBe(101);
	if (result.socket) openSockets.push(result.socket);
	if (!result.box) throw new Error('missing box');
	return result.box;
}

async function closeAll(): Promise<void> {
	for (const socket of openSockets.splice(0)) {
		try { socket.close(); } catch { /* already closed */ }
	}
	await delay(30);
}

describe('Presence — snapshots, friend-scoped announcements, multi-tab', () => {
	it('rejects connections without a valid route-minted identity', async () => {
		expect((await connect(null, [])).status).toBe(401);
		expect((await connect(null, [], { principal: 'guest:x' })).status).toBe(401);
		expect((await connect('alice', null)).status, 'missing friend-handles header').toBe(401);
		expect((await connect('ALICE', [])).status, 'handle shape re-validated by the DO').toBe(401);
		const badJson = await stub().fetch(new Request('https://presence.test/ws', {
			method: 'GET',
			headers: headers('alice', null),
		}));
		expect(badJson.status, 'x-bnji-friend-handles: not JSON').toBe(401);
		const notArray = await stub().fetch(new Request('https://presence.test/ws', {
			method: 'GET',
			headers: { ...headers('alice', null), 'x-bnji-friend-handles': '{"a":1}' },
		}));
		expect(notArray.status).toBe(401);
		await closeAll();
	});

	it('answers with a snapshot and only announces to sockets that list the handle', async () => {
		const opened: Array<Promise<SocketBox>> = [];
		const alice = await track(await connect('alice', ['bob']));
		opened.push(Promise.resolve(alice));
		// Alice's snapshot: nobody online yet.
		const first = await alice.next(snapshotOf);
		expect(first.handles).toEqual([]);

		// Bob connects (his friends = alice): alice is notified, bob's snapshot has alice.
		const bob = await track(await connect('bob', ['alice']));
		opened.push(Promise.resolve(bob));
		expect((await alice.next(onlineOf('bob'))).handle).toBe('bob');
		const bobSnapshot = await bob.next(snapshotOf);
		expect(bobSnapshot.handles).toEqual(['alice']);

		// Carol lists nobody: she sees neither the change nor anyone online.
		const carol = await track(await connect('carol', []));
		opened.push(Promise.resolve(carol));
		const carolSnapshot = await carol.next(snapshotOf);
		expect(carolSnapshot.handles).toEqual([]);
		await delay(60);
		// Visibility is friend-scoped (§8.1): carol learns nothing.
		expect(carol.frames.filter((frame) => frame.t === 'presence_change')).toHaveLength(0);

		// Dave's snapshot includes whoever is online among HIS friends (bob).
		const dave = await track(await connect('dave', ['bob']));
		opened.push(Promise.resolve(dave));
		const daveSnapshot = await dave.next(snapshotOf);
		expect(daveSnapshot.handles).toEqual(['bob']);
		// …and dave still learns nothing about alice (not his friend).
		await delay(60);
		expect(dave.frames.filter((frame) => frame.t === 'presence_change' && frame.handle === 'alice')).toHaveLength(0);
		await closeAll();
	});

	it('keeps a handle online across tabs; offline only when the last socket closes', async () => {
		const base = openSockets.length;
		const alice = await track(await connect('alice2', ['bob2']));
		await alice.next(snapshotOf);
		await track(await connect('bob2', ['alice2']));
		await track(await connect('bob2', ['alice2']));
		expect((await alice.next(onlineOf('bob2'))).handle).toBe('bob2');
		expect((await alice.next(onlineOf('bob2'))).handle).toBe('bob2');

		// First tab closes — still online because the second tab lives.
		openSockets[base + 1]!.close();
		await delay(80);
		expect(alice.frames.filter((frame) => frame.t === 'presence_change' && frame.online === false)).toHaveLength(0);

		// Last tab closes → the offline announcement finally fires.
		openSockets[base + 2]!.close();
		expect((await alice.next(offlineOf('bob2'))).handle).toBe('bob2');
		await closeAll();
	});

	it('answers ping with pong and stores nothing (attachments only)', async () => {
		const alice = await track(await connect('alice3', []));
		await alice.next(snapshotOf);
		const client = openSockets[openSockets.length - 1]!;
		client.send(JSON.stringify({ t: 'ping' }));
		const pong = await alice.next((frame) => frame.t === 'pong');
		expect(pong.t).toBe('pong');
		// Garbage is ignored, not fatal.
		client.send('not json at all');
		client.send(JSON.stringify({ t: 'weird', junk: true }));
		await delay(30);
		expect(client.readyState).toBe(1);
		await closeAll();
	});
});
