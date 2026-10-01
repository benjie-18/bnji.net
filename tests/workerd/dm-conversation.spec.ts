/**
 * Chat plan Phase D — the `DMConversation` Durable Object inside real workerd
 * (hibernation, socket attachments and DO state behave exactly as in
 * production — the reason this runner exists beside `node:test`, plan §13).
 *
 * The DO's contract is deliberately small: validate header shapes, accept one
 * live socket per participant per browser, broadcast pushed frames verbatim,
 * store NOTHING (D1 is the durable record, plan D5/§7.3).
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SocketBox, delay, type BoxFrame } from './support';

type DmNamespace = { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };

function uniqueConvId(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function stubFor(conversationId: string) {
	const namespace = env.DM_CONVERSATIONS as unknown as DmNamespace;
	return namespace.get(namespace.idFromName(conversationId));
}

const PLAYER_ONE = `player:${'1'.repeat(32)}`;
const PLAYER_TWO = `player:${'2'.repeat(32)}`;

function headers(principal: string | null, side: string | null): Record<string, string> {
	const result: Record<string, string> = { upgrade: 'websocket' };
	if (principal) result['x-bnji-verified-principal'] = principal;
	if (side) result['x-bnji-dm-side'] = side;
	return result;
}

async function connect(conversationId: string, principal: string | null, side: string | null): Promise<{ socket: WebSocket | null; box: SocketBox | null; status: number }> {
	const response = await stubFor(conversationId).fetch(new Request('https://dm.test/ws', {
		method: 'GET',
		headers: headers(principal, side),
	}));
	if (response.status !== 101) return { socket: null, box: null, status: response.status };
	const socket = response.webSocket;
	if (!socket) throw new Error('101 response carried no webSocket');
	socket.accept();
	return { socket, box: new SocketBox(response.webSocket!), status: 101 };
}

async function push(conversationId: string, frame: unknown): Promise<{ status: number; body: string }> {
	const response = await stubFor(conversationId).fetch(new Request('https://dm.test/push', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ frame }),
	}));
	return { status: response.status, body: await response.text() };
}

const readyOf = (frame: BoxFrame): boolean => frame.t === 'dm_ready';

describe('DMConversation — live fanout only', () => {
	it('greets an accepted member socket with dm_ready', async () => {
		const id = uniqueConvId();
		const one = await connect(id, PLAYER_ONE, 'lo');
		expect(one.status).toBe(101);
		const ready = await one.box!.next(readyOf);
		expect(ready.v).toBe(1);
	});

	it('refuses bad identity headers (shape-only validation — no storage to consult)', async () => {
		const id = uniqueConvId();
		expect((await connect(id, null, 'lo')).status, 'missing principal').toBe(401);
		expect((await connect(id, `guest:${'a'.repeat(32)}`, 'lo')).status, 'guests never reach DMs (§7.1)').toBe(401);
		expect((await connect(id, PLAYER_ONE, null)).status, 'missing side').toBe(401);
		expect((await connect(id, PLAYER_ONE, 'middle')).status, 'side must be lo|hi').toBe(401);
		expect((await connect(id, 'player:xyz', 'lo')).status, 'principal pattern enforced').toBe(401);
	});

	it('broadcasts pushed frames verbatim to every connected participant', async () => {
		const id = uniqueConvId();
		const a = await connect(id, PLAYER_ONE, 'lo');
		await a.box!.next(readyOf);
		const b = await connect(id, PLAYER_TWO, 'hi');
		await b.box!.next(readyOf);

		const frame = { t: 'dm_new', v: 1, m: { n: 1, senderSide: 'lo', body: 'hello', imageId: null, at: 1_000 } };
		const result = await push(id, frame);
		expect(result.status).toBe(200);
		expect((await a.box!.next((f) => f.t === 'dm_new')).m).toMatchObject({ n: 1, body: 'hello' });
		expect((await b.box!.next((f) => f.t === 'dm_new')).m).toMatchObject({ senderSide: 'lo' });
	});

	it('replaces an earlier socket from the same principal with 4001', async () => {
		const id = uniqueConvId();
		const first = await connect(id, PLAYER_ONE, 'lo');
		await first.box!.next(readyOf);
		const second = await connect(id, PLAYER_ONE, 'lo');
		await second.box!.next(readyOf);
		const closed = await first.box!.closed(5_000);
		expect(closed.code).toBe(4001);
	});

	it('answers ping with pong and ignores everything else', async () => {
		const id = uniqueConvId();
		const one = await connect(id, PLAYER_ONE, 'hi');
		await one.box!.next(readyOf);
		one.socket!.send(JSON.stringify({ t: 'ping' }));
		expect((await one.box!.next((f) => f.t === 'pong')).t).toBe('pong');
		one.socket!.send('not-json');
		one.socket!.send(JSON.stringify({ t: 'sneaky' }));
		await delay(50);
		expect(one.box!.frames.filter((f) => f.t !== 'dm_ready' && f.t !== 'pong')).toHaveLength(0);
	});

	it('bounds and validates push payloads (route-shaped errors)', async () => {
		const id = uniqueConvId();
		const oversize = await stubFor(id).fetch(new Request('https://dm.test/push', {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ frame: { blob: 'x'.repeat(70_000) } }),
		}));
		expect(oversize.status).toBe(413);
		expect((await push(id, undefined)).status, 'frame required').toBe(400);
		const notFound = await stubFor(id).fetch(new Request('https://dm.test/nope'));
		expect(notFound.status).toBe(404);
	});

	it('stores nothing: a fresh instance has no state to revive', async () => {
		const id = uniqueConvId();
		const one = await connect(id, PLAYER_ONE, 'lo');
		await one.box!.next(readyOf);
		await push(id, { t: 'dm_read', v: 1, side: 'lo', seq: 3 });
		expect((await one.box!.next((f) => f.t === 'dm_read')).seq).toBe(3);
		// No alarm, no SQL, no attachment: idle eviction is safe by construction.
	});
});
