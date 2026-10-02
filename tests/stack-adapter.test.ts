/**
 * `bnji.stack` adapter contracts: the score verifier reconstructs a run from
 * the shared rules, and the HTTP score route stores only what it recomputes.
 *
 * Note: this file imports the adapter itself, which registers its verifier as
 * a side effect — so it can NOT tell you whether the score ROUTE wires the
 * adapter up (that masking is exactly how the route shipped without Stack's
 * verifier). That invariant lives in `tests/score-verifier-registry.test.ts`,
 * which imports the route alone and fails unless every standalone game's
 * verifier is registered.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import type { APIContext } from 'astro';
import { createTestD1 } from './support/d1.mjs';
import { STACK_GAME_ID, STACK_MODE_ID } from '../src/server/game-adapters/stack';

const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();

function database() {
	const db = createTestD1();
	for (const name of migrations) db.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
	globalThis.__BNJI_TEST_BINDINGS__ = { BOARD_DB: db, DM_CONVERSATIONS: null, PRESENCE: null };
	globalThis.__BNJI_TEST_SECRETS__ = {};
	return db;
}

function jsonContext(path: string, body: unknown, origin = 'http://localhost'): APIContext {
	const url = `http://localhost${path}`;
	const headers = new Headers({ 'content-type': 'application/json' });
	if (origin) headers.set('origin', origin);
	const request = new Request(url, { method: 'POST', headers, body: JSON.stringify(body) });
	return { request, url: new URL(url), params: {}, cookies: { get: () => undefined } } as unknown as APIContext;
}

test('verifier: a reconstructable run scores, everything else is rejected', async () => {
	const { getScoreVerifier } = await import('../src/server/score-verifiers');
	const verifier = getScoreVerifier(STACK_GAME_ID);
	assert.ok(verifier, 'stack verifier registered on import');

	const base = { gameId: STACK_GAME_ID, modeId: STACK_MODE_ID, score: 0, tieBreak: null, displayName: 'Stack Sam', idempotencyKey: 'stack-claim-abcdef12' };
	const session = { sessionId: 's', playerId: null };

	// 4 perfects: score 10, layers 5 → tie-break 999 − 5 = 994.
	const good = await verifier({ ...base, proof: { drops: [0, 0, 0, 0], fatal: 3000 } }, session);
	assert.deepEqual(good, { score: 10, tieBreak: 994 });

	// Offset run: 1 + 1 + 1 = 3, four layers → 995.
	const mixed = await verifier({ ...base, score: 99, proof: { drops: [0, 200, 0], fatal: -3000 } }, session);
	assert.deepEqual(mixed, { score: 3, tieBreak: 995 }, 'client-claimed score is ignored');

	assert.equal(await verifier({ ...base, proof: { drops: [0, 0, 0, 0], fatal: 0 } }, session), null, 'fatal drop must miss');
	assert.equal(await verifier({ ...base, proof: { drops: [4000], fatal: 0 } }, session), null, 'drops may not miss');
	assert.equal(await verifier({ ...base, proof: { drops: [], fatal: 0 } }, session), null, 'empty runs do not score');
	assert.equal(await verifier({ ...base, proof: { drops: [0], fatal: 1.5 } }, session), null, 'non-integer proof');
	assert.equal(await verifier({ ...base, proof: { drops: '0000', fatal: 0 } }, session), null, 'shape-checked proof');
	assert.equal(await verifier({ ...base, modeId: 'quick', proof: { drops: [0, 0], fatal: 3000 } }, session), null, 'mode must match');
});

test('score route: 201 recomputes the run, the leaderboard shows it, tampering fails closed', async () => {
	database();
	const scores = await import('../src/pages/api/games/scores');
	const leaderboard = await import('../src/pages/api/games/leaderboard');

	const body = {
		gameId: STACK_GAME_ID,
		mode: STACK_MODE_ID,
		score: 0,
		tieBreak: null,
		displayName: 'Tower Tess',
		idempotencyKey: 'stack-route-abcdef1',
		proof: { drops: [0, 0, 0, 0, 0, 0, 0], fatal: 3000 },
	};
	const created = await scores.POST(jsonContext('/api/games/scores', body));
	assert.equal(created.status, 201, await created.clone().text());
	const createdBody = await created.json() as { ok: boolean; score: number; tieBreak: number | null };
	// 7 perfects: 1+2+…+7 = 28, layers 8 → tie-break 991.
	assert.equal(createdBody.score, 28);
	assert.equal(createdBody.tieBreak, 991);

	const read = await leaderboard.GET({
		request: new Request(`http://localhost/api/games/leaderboard?gameId=${STACK_GAME_ID}&mode=default`),
		url: new URL(`http://localhost/api/games/leaderboard?gameId=${STACK_GAME_ID}&mode=default`),
		params: {}, cookies: { get: () => undefined },
	} as unknown as APIContext);
	assert.equal(read.status, 200, await read.clone().text());
	const board = await read.json() as { rows?: { displayName: string; score: number }[] };
	assert.equal(board.rows?.[0]?.score, 28);
	assert.equal(board.rows?.[0]?.displayName, 'Tower Tess');

	const tampered = await scores.POST(jsonContext('/api/games/scores', {
		...body, idempotencyKey: 'stack-route-bad-001', proof: { drops: [0, 0, 0, 0, 0, 0, 0], fatal: 0 },
	}));
	assert.equal(tampered.status, 422, await tampered.clone().text());

	const cross = await scores.POST(jsonContext('/api/games/scores', body, 'https://evil.example'));
	assert.equal(cross.status, 403);
});
