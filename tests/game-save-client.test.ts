import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseCloudVersion, chooseLocalVersion, listLocalSaves, requestSaveWithRetry, saveLocalProgress, syncPlayerSaves } from '../src/scripts/game-saves';
import { createFakeIndexedDB } from './support/fake-indexeddb.mjs';

test('offline-first save transport retries transient failures at most three times and never retries a revision conflict', async () => {
	const originalFetch = globalThis.fetch;
	try {
		let attempts = 0;
		const options: RequestInit[] = [];
		globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			attempts += 1;
			options.push(init ?? {});
			if (attempts === 1) return new Response('', { status: 503 });
			if (attempts === 2) return new Response('', { status: 502 });
			return new Response('{}', { status: 200 });
		}) as typeof fetch;
		const response = await requestSaveWithRetry('/api/games/saves', { method: 'PUT' });
		assert.equal(response.status, 200);
		assert.equal(attempts, 3);
		assert.ok(options.every((init) => init.credentials === 'same-origin' && init.cache === 'no-store'));

		attempts = 0;
		globalThis.fetch = (async () => { attempts += 1; return new Response('{"error":"save_conflict"}', { status: 409 }); }) as typeof fetch;
		const conflict = await requestSaveWithRetry('/api/games/saves', { method: 'PUT' });
		assert.equal(conflict.status, 409);
		assert.equal(attempts, 1, 'CAS conflict is a user choice, not a transient retry');

		attempts = 0;
		globalThis.fetch = (async () => { attempts += 1; throw new TypeError('offline'); }) as typeof fetch;
		await assert.rejects(requestSaveWithRetry('/api/games/saves', { method: 'PUT' }), /offline/);
		assert.equal(attempts, 3, 'offline failure stops after the bounded retry budget');
	} finally { globalThis.fetch = originalFetch; }
});

test('save retries reconcile an already-committed write and cloud deletion offers both explicit choices', async () => {
	const originalFetch = globalThis.fetch;
	const indexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
	Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: createFakeIndexedDB() });
	let cloud: Record<string, unknown> | null = null;
	let puts = 0;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (init?.method === 'GET' || !init?.method) return new Response(JSON.stringify({ saves: cloud ? [cloud] : [] }), { status: 200 });
		if (init?.method === 'PUT') {
			const body = JSON.parse(String(init.body)) as Record<string, unknown>;
			puts += 1;
			if (puts === 1) {
				// Model a server commit followed by a lost/failed response. The retry
				// uses the old expected revision and must reconcile with current data.
				cloud = { ...body, revision: 1, updatedAt: 1234, dirty: false };
				return new Response('', { status: 503 });
			}
			if (cloud) return new Response(JSON.stringify({ error: 'save_conflict', current: cloud }), { status: 409 });
			cloud = { ...body, revision: 1, updatedAt: 2345, dirty: false };
			return new Response(JSON.stringify({ revision: 1, updatedAt: 2345 }), { status: 200 });
		}
		throw new Error(`unexpected save request ${init?.method} ${url}`);
	}) as typeof fetch;
	try {
		await saveLocalProgress('bnji.glass-minesweeper', 'default', 1, { level: 7 });
		const synced = await syncPlayerSaves();
		assert.equal(synced.uploaded, 1);
		assert.equal(puts, 2);
		let local = (await listLocalSaves())[0];
		assert.equal(local?.dirty, false);
		assert.equal(local?.revision, 1);
		assert.deepEqual(local?.data, { level: 7 });

		cloud = null;
		const deletionConflict = await syncPlayerSaves();
		assert.equal(deletionConflict.conflicts, 1);
		local = (await listLocalSaves())[0];
		assert.equal(local?.conflict?.deleted, true);
		assert.equal(await chooseLocalVersion('bnji.glass-minesweeper', 'default'), 'saved');
		local = (await listLocalSaves())[0];
		assert.equal(local?.dirty, false, 'choosing the device copy restores it as a new cloud save');
		assert.deepEqual(local?.data, { level: 7 });

		cloud = null;
		assert.equal((await syncPlayerSaves()).conflicts, 1);
		await chooseCloudVersion('bnji.glass-minesweeper', 'default');
		assert.deepEqual(await listLocalSaves(), [], 'choosing the deleted cloud state removes the local copy');
	} finally {
		globalThis.fetch = originalFetch;
		if (indexedDbDescriptor) Object.defineProperty(globalThis, 'indexedDB', indexedDbDescriptor);
		else Reflect.deleteProperty(globalThis, 'indexedDB');
	}
});
