/**
 * Shared PvP Minesweeper rules for `bnji.pvp-minesweeper` — one module for
 * the browser race UI, the room authority's placement/finish validation, and
 * the round-win attestation. Boards are fully opponent-designed: every mine
 * on a player's board was placed by another player within the difficulty's
 * per-author budget; racing means revealing every safe cell first.
 *
 * Wire format for minefields is a base64 bitset (one bit per cell, row-major);
 * reveal proofs are the ordered list of first-click cells (flood expansion is
 * deterministic from the minefield).
 */

export type MinesweeperDifficulty = 'quick' | 'normal' | 'hard';

export const MS_DIFFICULTY_ORDER: readonly MinesweeperDifficulty[] = ['quick', 'normal', 'hard'];
export const MS_DIFFICULTY_SPEC: Record<MinesweeperDifficulty, { size: number; mines: number }> = {
	quick: { size: 6, mines: 5 },
	normal: { size: 9, mines: 10 },
	hard: { size: 14, mines: 30 },
};
/** Placement phase cap and vote window (authority-enforced, DO clock). */
export const MS_VOTE_MS = 5_000;
export const MS_PLACE_MS = 60_000;
export const MS_RESULTS_MS = 5_000;

export function msDifficulty(value: unknown): MinesweeperDifficulty | null {
	return value === 'quick' || value === 'normal' || value === 'hard' ? value : null;
}

export function msSpec(difficulty: MinesweeperDifficulty): { size: number; mines: number } {
	return MS_DIFFICULTY_SPEC[difficulty];
}

/** Mines one author may place on one target board: an even split of the total, remainder to the first authors. */
export function msContributorBudget(total: number, authorIndex: number, authorCount: number): number {
	if (authorCount < 1 || authorIndex < 0 || authorIndex >= authorCount) return 0;
	const base = Math.floor(total / authorCount);
	return base + (authorIndex < total % authorCount ? 1 : 0);
}

// ---------------------------------------------------------------- bitsets

export function msEncodeBitset(mines: Uint8Array): string {
	let binary = '';
	for (const byte of mines) binary += String.fromCharCode(byte);
	// No padding: the decoder derives the expected length from the cell count.
	return btoa(binary).replace(/=+$/, '');
}

export function msDecodeBitset(text: string, cellCount: number): Uint8Array | null {
	if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*$/.test(text)) return null;
	const expectedBytes = Math.ceil(cellCount / 8);
	let binary: string;
	try {
		binary = atob(text);
	} catch {
		return null;
	}
	// The canonical encoding has no padding; re-encode and compare to reject
	// odd-length or non-canonical strings before touching bytes.
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	if (bytes.length !== expectedBytes) return null;
	if (bytes.length > 0) {
		const spareBits = bytes.length * 8 - cellCount;
		if (spareBits > 0 && (bytes[bytes.length - 1]! >> (8 - spareBits)) !== 0) return null;
		if (msEncodeBitset(bytes) !== text) return null;
	}
	return bytes;
}

export function msCountMines(mines: Uint8Array): number {
	let count = 0;
	for (const byte of mines) {
		let bits = byte;
		while (bits) { count += bits & 1; bits >>= 1; }
	}
	return count;
}

export function msGetMine(mines: Uint8Array, cell: number): boolean {
	return ((mines[cell >> 3] ?? 0) & (1 << (cell & 7))) !== 0;
}

export function msSetMine(mines: Uint8Array, cell: number): void {
	mines[cell >> 3] = (mines[cell >> 3] ?? 0) | (1 << (cell & 7));
}

export function msUnionBitsets(fields: readonly Uint8Array[]): Uint8Array {
	const size = Math.max(0, ...fields.map((field) => field.length));
	const union = new Uint8Array(size);
	for (const field of fields) {
		for (let i = 0; i < field.length; i += 1) union[i] = (union[i] ?? 0) | field[i]!;
	}
	return union;
}

// ----------------------------------------------------------------- board

/** Adjacency numbers; mines are −1. */
export function msNumbers(mines: Uint8Array, size: number): Int8Array {
	const numbers = new Int8Array(size * size);
	for (let cell = 0; cell < size * size; cell += 1) {
		if (msGetMine(mines, cell)) { numbers[cell] = -1; continue; }
		const row = Math.floor(cell / size);
		const col = cell % size;
		let count = 0;
		for (let dr = -1; dr <= 1; dr += 1) {
			for (let dc = -1; dc <= 1; dc += 1) {
				if (dr === 0 && dc === 0) continue;
				const r = row + dr;
				const c = col + dc;
				if (r < 0 || c < 0 || r >= size || c >= size) continue;
				if (msGetMine(mines, r * size + c)) count += 1;
			}
		}
		numbers[cell] = count;
	}
	return numbers;
}

/** One reveal click with flood expansion. Mutates `revealed`; a mine click only flags the hit. */
export function msRevealClick(numbers: Int8Array, size: number, revealed: Uint8Array, click: number): { hitMine: boolean } {
	if (click < 0 || click >= size * size || revealed[click]) return { hitMine: false };
	if (numbers[click] === -1) {
		revealed[click] = 1;
		return { hitMine: true };
	}
	const queue = [click];
	revealed[click] = 1;
	while (queue.length > 0) {
		const cell = queue.pop()!;
		if (numbers[cell] !== 0) continue;
		const row = Math.floor(cell / size);
		const col = cell % size;
		for (let dr = -1; dr <= 1; dr += 1) {
			for (let dc = -1; dc <= 1; dc += 1) {
				if (dr === 0 && dc === 0) continue;
				const r = row + dr;
				const c = col + dc;
				if (r < 0 || c < 0 || r >= size || c >= size) continue;
				const next = r * size + c;
				if (revealed[next] || numbers[next] === -1) continue;
				revealed[next] = 1;
				if (numbers[next] === 0) queue.push(next);
			}
		}
	}
	return { hitMine: false };
}

export function msAllSafeRevealed(revealed: Uint8Array, mines: Uint8Array): boolean {
	for (let cell = 0; cell < revealed.length; cell += 1) {
		if (!msGetMine(mines, cell) && !revealed[cell]) return false;
	}
	return true;
}

export type MsReplayResult = { ok: true } | { ok: false; error: 'hit_mine' | 'incomplete' | 'bad_clicks' };

/**
 * Replay a race finish: clicks must be in range, may not step on a mine, and
 * must end with every safe cell revealed (flood counts instantly).
 */
export function msReplayReveals(mines: Uint8Array, size: number, clicks: readonly number[]): MsReplayResult {
	if (!Array.isArray(clicks) || clicks.length > size * size) return { ok: false, error: 'bad_clicks' };
	for (const click of clicks) {
		if (!Number.isSafeInteger(click) || click < 0 || click >= size * size) return { ok: false, error: 'bad_clicks' };
	}
	const numbers = msNumbers(mines, size);
	const revealed = new Uint8Array(size * size);
	for (const click of clicks) {
		const outcome = msRevealClick(numbers, size, revealed, click);
		if (outcome.hitMine) return { ok: false, error: 'hit_mine' };
	}
	return msAllSafeRevealed(revealed, mines) ? { ok: true } : { ok: false, error: 'incomplete' };
}
