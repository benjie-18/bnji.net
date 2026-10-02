/**
 * The score-route verifier wiring guard — the test that would have caught the
 * `bnji.isometric-stack` outage (2026-10): the route imported the Chess and
 * PvP Minesweeper adapters but not Stack's, so Stack submissions failed with
 * `503 verifier_unavailable` while the per-adapter tests stayed green (they
 * import their adapter first, which masked the missing route wiring).
 *
 * This file imports NOTHING from `src/server/game-adapters/`. Its only server
 * import is the score route itself, so the verifier registry contains exactly
 * what the route's own import graph registers — in a clean process, one file
 * per node:test child. The invariant it pins:
 *
 *   every standalone game (available, own route — `getStandaloneGames()`)
 *   MUST have a registered score verifier once the route module is loaded,
 *   and the client-side mirror `SCORE_VERIFIER_GAMES` must list exactly the
 *   registered set (that mirror decides which leaderboard pages exist, so a
 *   drift means a board nobody can write or a verifier nobody can see).
 *
 * Lab-pointer games have no server side and deliberately fail closed; one is
 * pinned below so that stays a decision rather than an accident.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import type { APIContext } from 'astro';
import { createTestD1 } from './support/d1.mjs';
import { GAMES, getStandaloneGames } from '../src/data/games';
import { SCORE_VERIFIER_GAMES } from '../src/data/game-adapters';
import { getScoreVerifier } from '../src/server/score-verifiers';
// The module under test, imported FIRST — nothing else may register verifiers
// before this file's route import, or the guard silently stops guarding.
import '../src/pages/api/games/scores';

test('the score route registers a verifier for every standalone game', () => {
	for (const game of getStandaloneGames()) {
		assert.ok(getScoreVerifier(game.id), `${game.id} is a standalone game but its score verifier is not registered by the score route's import graph — add its adapter to src/server/game-adapters/register-all.ts`);
	}
});

test('the registered verifier set matches the SCORE_VERIFIER_GAMES mirror exactly', () => {
	const registered = new Set<string>();
	for (const game of GAMES) {
		if (getScoreVerifier(game.id)) registered.add(game.id);
	}
	assert.deepEqual(
		[...registered].sort(),
		[...SCORE_VERIFIER_GAMES].sort(),
		'update SCORE_VERIFIER_GAMES (src/data/game-adapters.ts) together with game-adapters/register-all.ts — it decides which leaderboard pages are published',
	);
});

test('a Lab-pointer game has no verifier: its submissions fail closed by design', () => {
	const labGame = GAMES.find((game) => game.status === 'available' && 'labHref' in game && Boolean(game.labHref));
	assert.ok(labGame, 'the catalog expects at least one Lab-pointer game');
	assert.equal(getScoreVerifier(labGame.id), undefined, `${labGame.id} has no server side; it must stay unregistered`);
	assert.equal(getStandaloneGames().includes(labGame), false);
});

test('end to end: a Stack run submitted through the wired route is verified and stored (201, not 503)', async () => {
	const migrations = readdirSync(new URL('../migrations/', import.meta.url)).filter((name) => name.endsWith('.sql')).sort();
	const db = createTestD1();
	for (const name of migrations) db.raw.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
	globalThis.__BNJI_TEST_BINDINGS__ = { BOARD_DB: db, DM_CONVERSATIONS: null, PRESENCE: null };
	globalThis.__BNJI_TEST_SECRETS__ = {};

	const scores = await import('../src/pages/api/games/scores');
	const context = {
		request: new Request('http://localhost/api/games/scores', {
			method: 'POST',
			headers: { 'content-type': 'application/json', origin: 'http://localhost' },
			body: JSON.stringify({
				gameId: 'bnji.isometric-stack',
				mode: 'default',
				score: 0,
				tieBreak: null,
				displayName: 'Wire Check',
				idempotencyKey: 'registry-e2e-abcdef01',
				proof: { drops: [0, 0, 0, 0, 0, 0, 0], fatal: 3000 },
			}),
		}),
		url: new URL('http://localhost/api/games/scores'),
		params: {},
		cookies: { get: () => undefined },
	} as unknown as APIContext;
	const response = await scores.POST(context);
	assert.equal(response.status, 201, await response.clone().text());
	const body = await response.json() as { ok: boolean; score: number; tieBreak: number | null };
	assert.equal(body.ok, true);
	// 7 perfect drops: 1+2+…+7 = 28, layers 8 → tie-break 999 − 8 = 991.
	assert.equal(body.score, 28);
	assert.equal(body.tieBreak, 991);
	assert.equal(
		(db.raw.prepare('SELECT COUNT(*) AS n FROM game_scores WHERE validation_state = \'validated\'').get() as { n: number }).n,
		1,
		'the verified run is the one stored row',
	);
});
