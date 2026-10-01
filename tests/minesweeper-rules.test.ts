/** `bnji.pvp-minesweeper` shared rules: budgets, bitsets, flood reveals, replay. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	MS_DIFFICULTY_SPEC,
	msAllSafeRevealed,
	msContributorBudget,
	msCountMines,
	msDecodeBitset,
	msDifficulty,
	msEncodeBitset,
	msGetMine,
	msNumbers,
	msReplayReveals,
	msRevealClick,
	msSetMine,
	msSpec,
	msUnionBitsets,
} from '../src/game/minesweeper-rules';

function field(size: number, cells: number[]): Uint8Array {
	const mines = new Uint8Array(Math.ceil(size * size / 8));
	for (const cell of cells) msSetMine(mines, cell);
	return mines;
}

describe('minesweeper-rules', () => {
	test('difficulty specs grow in board and mines', () => {
		assert.deepEqual(msSpec('quick'), { size: 6, mines: 5 });
		assert.deepEqual(msSpec('normal'), { size: 9, mines: 10 });
		assert.deepEqual(msSpec('hard'), { size: 14, mines: 30 });
		assert.ok(MS_DIFFICULTY_SPEC.hard.size > MS_DIFFICULTY_SPEC.normal.size);
		assert.ok(MS_DIFFICULTY_SPEC.hard.mines > MS_DIFFICULTY_SPEC.normal.mines);
		assert.equal(msDifficulty('quick'), 'quick');
		assert.equal(msDifficulty('medium'), null);
		assert.equal(msDifficulty(3), null);
	});

	test('contributor budgets split the board total with the remainder to the first authors', () => {
		assert.equal(msContributorBudget(5, 0, 1), 5, 'solo author takes the whole budget');
		assert.deepEqual([0, 1, 2].map((index) => msContributorBudget(5, index, 3)), [2, 2, 1]);
		assert.deepEqual([0, 1, 2].map((index) => msContributorBudget(10, index, 3)), [4, 3, 3]);
		assert.equal(msContributorBudget(5, 5, 3), 0, 'out of range takes nothing');
		const sum = [0, 1, 2, 3, 4, 5, 6].reduce((total, index) => total + msContributorBudget(5, index, 7), 0);
		assert.equal(sum, 5, 'budgets always sum to the difficulty total');
	});

	test('bitsets round-trip and reject non-canonical or out-of-range encodings', () => {
		const mines = field(6, [0, 5, 12, 30, 35]);
		const encoded = msEncodeBitset(mines);
		assert.equal(msCountMines(mines), 5);
		const decoded = msDecodeBitset(encoded, 36);
		assert.ok(decoded);
		assert.deepEqual([...decoded!], [...mines]);
		assert.equal(msDecodeBitset(encoded + 'A', 36), null, 'garbage suffix');
		assert.equal(msDecodeBitset('AAAA', 36), null, 'wrong byte length');
		assert.equal(msDecodeBitset('', 36), null, 'empty is not a 36-cell field');
		assert.equal(msDecodeBitset('!!!!', 36), null, 'bad alphabet');
		const padded = `${encoded.slice(0, -1)}=`;
		assert.equal(msDecodeBitset(padded, 36), null, 'padding is not canonical');
		assert.equal(msGetMine(mines, 12), true);
		assert.equal(msGetMine(mines, 13), false);
	});

	test('union merges author fields without touching other bits', () => {
		const a = field(6, [1, 2]);
		const b = field(6, [30]);
		const union = msUnionBitsets([a, b]);
		assert.equal(msCountMines(union), 3);
		assert.ok(msGetMine(union, 1) && msGetMine(union, 2) && msGetMine(union, 30));
		assert.equal(msGetMine(union, 3), false);
	});

	test('numbers count orthogonal and diagonal neighbours; mines read −1', () => {
		const mines = field(3, [0]);
		const numbers = msNumbers(mines, 3);
		assert.equal(numbers[0], -1);
		assert.equal(numbers[1], 1);
		assert.equal(numbers[3], 1);
		assert.equal(numbers[4], 1, 'diagonal');
		assert.equal(numbers[8], 0);
	});

	test('flood reveal opens zero regions, stops at numbers, and flags mine clicks', () => {
		// 4×4: single mine at 0; clicking 15 (a zero corner) floods everything safe.
		const mines = field(4, [0]);
		const numbers = msNumbers(mines, 4);
		const revealed = new Uint8Array(16);
		const outcome = msRevealClick(numbers, 4, revealed, 15);
		assert.equal(outcome.hitMine, false);
		assert.equal(msAllSafeRevealed(revealed, mines), true, 'flood reaches every safe cell');
		assert.equal(revealed[0], 0, 'the mine itself is never revealed by flood');

		const second = new Uint8Array(16);
		const hit = msRevealClick(numbers, 4, second, 0);
		assert.equal(hit.hitMine, true, 'clicking a mine loses');
		// Clicking an already-revealed cell is a tolerated no-op.
		const noop = msRevealClick(numbers, 4, revealed, 15);
		assert.equal(noop.hitMine, false);
	});

	test('replay accepts a complete clean reveal and rejects everything else', () => {
		const size = 6;
		const mines = field(size, [0, 5, 12, 30, 35]);
		const safe = Array.from({ length: size * size }, (_, cell) => cell).filter((cell) => !msGetMine(mines, cell));
		assert.deepEqual(msReplayReveals(mines, size, safe), { ok: true });
		assert.deepEqual(msReplayReveals(mines, size, [...safe, 0]), { ok: false, error: 'hit_mine' }, 'mine clicks are rejected even late');
		// Cells 1 and 4 are numbered borders (adjacent to mines) — clicking only
		// them never floods, so the board stays incomplete.
		assert.deepEqual(msReplayReveals(mines, size, [1, 4]), { ok: false, error: 'incomplete' });
		assert.deepEqual(msReplayReveals(mines, size, [0]), { ok: false, error: 'hit_mine' });
		assert.deepEqual(msReplayReveals(mines, size, [-1, 0]), { ok: false, error: 'bad_clicks' });
		assert.deepEqual(msReplayReveals(mines, size, [1.5]), { ok: false, error: 'bad_clicks' });
		assert.deepEqual(msReplayReveals(mines, size, [36]), { ok: false, error: 'bad_clicks' });
		assert.deepEqual(msReplayReveals(mines, size, new Array(37).fill(1)), { ok: false, error: 'bad_clicks' });
	});

	test('an empty minefield only needs every cell opened', () => {
		const mines = new Uint8Array(2);
		const numbers = msNumbers(mines, 4);
		const revealed = new Uint8Array(16);
		msRevealClick(numbers, 4, revealed, 0);
		assert.equal(msAllSafeRevealed(revealed, mines), true, 'zero board floods completely from one click');
	});
});
