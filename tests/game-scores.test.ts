/**
 * Automatic score submission — the decision, tested against the upsert it mirrors.
 *
 * A run is only submitted when it beats the player's own server-stored best, so
 * the comparison is the feature: `beatsBest` must agree exactly with the
 * `game_scores` upsert (higher score wins; on equal scores a lower tie-break
 * wins; an absent tie-break counts as worst). The route test suite covers the
 * network; this file pins the boundary cases that would otherwise silently
 * re-submit an equal run or drop a genuine tie-break improvement.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { beatsBest, outcomeMessage, type PersonalBest } from '../src/scripts/game-scores';

test('beatsBest: first scores, higher scores, and only better tie-breaks', () => {
	// No stored best: any positive score is a personal best; zero is not.
	assert.equal(beatsBest(null, { score: 1, tieBreak: null }), true);
	assert.equal(beatsBest(null, { score: 0, tieBreak: 0 }), false);

	const best: PersonalBest = { score: 100, tieBreak: 40 };
	assert.equal(beatsBest(best, { score: 101, tieBreak: 999 }), true);
	assert.equal(beatsBest(best, { score: 99, tieBreak: 1 }), false);

	// Equal score: a strictly lower tie-break wins (seconds, moves — whichever
	// the game stores), and an equal tie-break is not an improvement.
	assert.equal(beatsBest(best, { score: 100, tieBreak: 39 }), true);
	assert.equal(beatsBest(best, { score: 100, tieBreak: 40 }), false);
	assert.equal(beatsBest(best, { score: 100, tieBreak: 41 }), false);

	// A missing tie-break is the worst possible one on both sides, so an
	// unranked stored best can be improved by any timed run and vice versa.
	const untimed: PersonalBest = { score: 50, tieBreak: null };
	assert.equal(beatsBest(untimed, { score: 50, tieBreak: 0 }), true);
	assert.equal(beatsBest(untimed, { score: 50, tieBreak: null }), false);
	const timed: PersonalBest = { score: 50, tieBreak: 10 };
	assert.equal(beatsBest(timed, { score: 50, tieBreak: null }), false);
});

test('outcomeMessage speaks only when the player needs to hear something', () => {
	// A recorded best is the expected path: no announcement would add anything.
	assert.equal(outcomeMessage({ kind: 'recorded', score: 100 }), null);
	// A run that was not a candidate for submission was never asked about.
	assert.equal(outcomeMessage({ kind: 'not-best' }), null);
	assert.match(outcomeMessage({ kind: 'duplicate' }) ?? '', /submitted before/);
	assert.match(outcomeMessage({ kind: 'unnamed' }) ?? '', /display name/i);
	assert.match(outcomeMessage({ kind: 'unverifiable' }) ?? '', /could not verify/);
	assert.match(outcomeMessage({ kind: 'rate-limited', retryAfter: 60 }) ?? '', /again in a minute/i);
	assert.match(outcomeMessage({ kind: 'unavailable' }) ?? '', /claim this run by hand/);
});
