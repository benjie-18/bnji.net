/**
 * BNJI.NET — Text diff (/tools/#text-diff).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The third browser tool, on the same terms as the other two: the interface is
 * markup and CSS in src/components/tools/TextDiff.astro, every decision is here,
 * and `initTextDiff()` is the one thing boot.ts calls. Limits, view labels and
 * the sentences that explain a trade-off come from src/config/tools.config.ts, so
 * nothing in this file hard-codes a number a visitor is ever shown.
 *
 * With JavaScript blocked, late or broken, the page still says what the tool
 * compares, what it refuses and how to read a row; the two boxes are real
 * textareas in the document either way.
 *
 * THE ALGORITHM, AND WHY IT IS NOT MYERS
 * --------------------------------------
 * A longest-common-subsequence dynamic-programming table over LINES, held in one
 * flat Int32Array — (n+1)×(m+1) cells of four bytes — walked forwards to produce
 * the edit script. Myers' O(ND) algorithm is what `git diff` runs and is much
 * faster when two files are nearly identical, but it snapshots the V array once
 * per step of D, which for two unlike files is the same O(n×m) memory with a
 * worse constant and no bound this tool could quote to a visitor. This table is
 * boring, exact, and its cost is one number the tool can refuse on: cells.
 *
 * Two things keep that number small in practice:
 *
 *  - the common head and tail are trimmed before the table is built, so a
 *    200,000-line log with one changed line costs a 1×1 table and not 4×10^10;
 *  - lines are interned to integers first, so the inner loop compares ints.
 *
 * Measured in this sandbox: 4,000,000 cells (2,000 × 2,000 differing lines) is
 * roughly 20–40 ms and 16 MB, which is where TOOL_DIFF_CONFIG.maxDiffCells sits.
 * Past it the tool refuses and says why — one pathological pair of files must not
 * be able to wedge a phone.
 *
 * PRIVACY: both texts are read in this tab. There is no request in this file to
 * intercept, nothing is uploaded, and nothing survives a reload.
 */
import {
	DIFF_VIEW_HINT,
	DIFF_VIEWS,
	TOOL_DIFF_CONFIG,
	type ToolDiffView,
} from '../config/tools.config';
import {
	checkTextFile,
	codePointLength,
	formatBytes,
	formatCount,
	looksLikeMojibake,
	type TextFile,
	type ToolCheck,
} from './tools-shared';

/* ------------------------------------------------------------------------- *
 * Types
 * ------------------------------------------------------------------------- */

/** What happened to a line: it is on both sides, only the left, or only the right. */
export type DiffOp = 'same' | 'del' | 'add';

/** One piece of a line — a word or a run of whitespace — with its own fate. */
export type DiffSegment = { op: DiffOp; text: string };

export type DiffRow = {
	op: DiffOp;
	/** 1-based line number on that side, or null where the side has no such line. */
	left: number | null;
	right: number | null;
	/** The row's own text: the left line for `same` and `del`, the right line for `add`. */
	text: string;
	/**
	 * Present only on a `same` row that matched with whitespace differences
	 * ignored, holding the right side's own text. The tool never quietly rewrites
	 * an input: with "ignore whitespace" on, two lines can be equal for comparing
	 * and different for displaying, and this is where the difference is kept.
	 */
	rightText?: string;
	/** Word-level detail, when `withInlineWords()` could pair this row. */
	segments?: DiffSegment[];
};

/** A row to draw, or the run of unchanged rows the context setting hid. */
export type DiffView = DiffRow | { skipped: number };

export type DiffResult = {
	rows: DiffRow[];
	added: number;
	removed: number;
	unchanged: number;
	/** Change blocks — the runs of added/removed lines a hunk header would start. */
	sections: number;
	/** `same` rows that matched only because whitespace differences were ignored. */
	whitespaceOnly: number;
	leftLines: number;
	rightLines: number;
	/** True when the two texts are byte-for-byte equal, line endings included. */
	identical: boolean;
	/** True when the only difference is CRLF versus LF. */
	lineEndingsOnly: boolean;
	/** True when the only difference is a line break at the very end. */
	trailingNewlineOnly: boolean;
	ignoreWhitespace: boolean;
	inlineWords: boolean;
};

export type DiffOptions = { ignoreWhitespace?: boolean };

/**
 * A diff either happened or it was refused with a sentence. Same shape as the
 * image tool's and the word counter's guards: the copy explaining a limit lives
 * beside the limit that was checked.
 */
export type DiffOutcome = { ok: true; diff: DiffResult } | { ok: false; message: string };

/** Which side of the tool something belongs to. */
export type DiffSide = 'left' | 'right';

/* ------------------------------------------------------------------------- *
 * Lines
 * ------------------------------------------------------------------------- */

/**
 * CRLF and lone CR both become LF, so a file saved on Windows and the same file
 * saved on a Mac compare equal. Line endings are a property of how a file was
 * saved, not of what it says, and a diff that painted every line changed because
 * of them would be telling the visitor nothing.
 */
export function normaliseLineEndings(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

/**
 * The lines of a text. A trailing line break ends the last line rather than
 * starting an empty one — the convention every editor and every diff tool uses —
 * which is why `"a"` and `"a\n"` produce no changed rows. That is not hidden:
 * `diffLines` reports it as `trailingNewlineOnly` and the status line says so.
 */
export function splitLines(text: string): string[] {
	if (text === '') return [];
	const lines = normaliseLineEndings(text).split('\n');
	if (lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/**
 * The string two lines are compared by. With whitespace differences ignored, a
 * run of whitespace becomes one space and the line is trimmed — but the ORIGINAL
 * text is what gets displayed, because a tool that shows a line the visitor did
 * not write has stopped being a diff.
 */
function compareKey(line: string, ignoreWhitespace: boolean): string {
	return ignoreWhitespace ? line.replace(/\s+/g, ' ').trim() : line;
}

/**
 * One row of the answer. `rightText` is carried only when it differs, so the
 * ordinary case (the overwhelming majority of rows) stays a small object.
 */
function sameRow(leftText: string, rightText: string, left: number, right: number): DiffRow {
	const row: DiffRow = { op: 'same', left, right, text: leftText };
	if (rightText !== leftText) row.rightText = rightText;
	return row;
}

/* ------------------------------------------------------------------------- *
 * The comparison
 * ------------------------------------------------------------------------- */

/**
 * Replace equal strings with equal small integers, from one map shared by both
 * sides. The inner loop of the table below then compares numbers instead of
 * walking characters, which is most of the difference between a diff that takes
 * 40 ms and one that takes 400.
 */
function intern(left: readonly string[], right: readonly string[]): { left: number[]; right: number[] } {
	const ids = new Map<string, number>();
	const idOf = (token: string): number => {
		const found = ids.get(token);
		if (found !== undefined) return found;
		const id = ids.size;
		ids.set(token, id);
		return id;
	};
	return { left: left.map(idOf), right: right.map(idOf) };
}

/**
 * The edit script for two interned sequences, or null when the table would be
 * bigger than `maxCells` — the one refusal the line pass and the word pass share.
 *
 * `table[i * stride + j]` is the length of the longest common subsequence of
 * `left[i..]` and `right[j..]`. The last row and column stay zero, which the
 * Int32Array allocation gives for free and which is what lets the recurrence
 * below run with no bounds checks at all.
 *
 * The walk goes FORWARDS from (0,0) rather than backwards from (n,m) so the
 * tie-break lands the way a reader expects: where removing and inserting are
 * equally good, remove first. That is what puts a removed line above the line
 * that replaced it, as `diff -u` does, instead of interleaveing the two.
 */
function lcsOps(
	left: readonly number[],
	right: readonly number[],
	maxCells: number,
): DiffOp[] | null {
	const n = left.length;
	const m = right.length;
	if (n * m > maxCells) return null;

	const ops: DiffOp[] = [];
	if (n === 0 || m === 0) {
		for (let i = 0; i < n; i += 1) ops.push('del');
		for (let j = 0; j < m; j += 1) ops.push('add');
		return ops;
	}

	const stride = m + 1;
	const table = new Int32Array((n + 1) * stride);
	for (let i = n - 1; i >= 0; i -= 1) {
		const row = i * stride;
		const next = row + stride;
		const token = left[i] as number;
		for (let j = m - 1; j >= 0; j -= 1) {
			table[row + j] =
				token === right[j]
					? (table[next + j + 1] as number) + 1
					: Math.max(table[next + j] as number, table[row + j + 1] as number);
		}
	}

	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (left[i] === right[j]) {
			ops.push('same');
			i += 1;
			j += 1;
		} else if ((table[(i + 1) * stride + j] as number) >= (table[i * stride + j + 1] as number)) {
			ops.push('del');
			i += 1;
		} else {
			ops.push('add');
			j += 1;
		}
	}
	while (i < n) {
		ops.push('del');
		i += 1;
	}
	while (j < m) {
		ops.push('add');
		j += 1;
	}
	return ops;
}

/** The all-zero diff the cleared panel renders, so empty and compared share one code path. */
export function emptyDiff(): DiffResult {
	return {
		rows: [],
		added: 0,
		removed: 0,
		unchanged: 0,
		sections: 0,
		whitespaceOnly: 0,
		leftLines: 0,
		rightLines: 0,
		identical: false,
		lineEndingsOnly: false,
		trailingNewlineOnly: false,
		ignoreWhitespace: false,
		inlineWords: false,
	};
}

/**
 * Refuse one side before anything is compared, naming the side: "the text is too
 * long" is not an answer when there are two boxes.
 */
export function checkSideText(text: string, side: DiffSide): ToolCheck {
	const characters = codePointLength(text);
	const limit = TOOL_DIFF_CONFIG.maxInputCharacters;
	if (characters > limit) {
		return {
			ok: false,
			message: `The ${side} text is ${formatCount(characters)} characters, over this tool's ${formatCount(limit)}-character limit, so nothing was compared — the table a diff needs grows with both sides at once.`,
		};
	}
	return { ok: true };
}

/**
 * Compare two texts, line by line.
 *
 * Returns every row, not just the ones that will be drawn: the counts, the patch
 * on the clipboard and the status sentence all have to describe the whole
 * comparison, and only the DOM is capped (see `visibleViews`).
 */
export function diffLines(
	leftText: string,
	rightText: string,
	options: DiffOptions = {},
): DiffOutcome {
	const leftCheck = checkSideText(leftText, 'left');
	if (!leftCheck.ok) return { ok: false, message: leftCheck.message };
	const rightCheck = checkSideText(rightText, 'right');
	if (!rightCheck.ok) return { ok: false, message: rightCheck.message };

	const ignoreWhitespace = options.ignoreWhitespace === true;
	const leftNormalised = normaliseLineEndings(leftText);
	const rightNormalised = normaliseLineEndings(rightText);
	const left = splitLines(leftText);
	const right = splitLines(rightText);

	const keysLeft = left.map((line) => compareKey(line, ignoreWhitespace));
	const keysRight = right.map((line) => compareKey(line, ignoreWhitespace));

	/*
	 * Trim the shared head and tail before building anything. Two large files that
	 * differ in one paragraph are the normal case here, and without the trim they
	 * would pay for a table over every line they already agree on.
	 */
	let head = 0;
	while (head < keysLeft.length && head < keysRight.length && keysLeft[head] === keysRight[head]) {
		head += 1;
	}
	let tail = 0;
	while (
		tail < keysLeft.length - head &&
		tail < keysRight.length - head &&
		keysLeft[keysLeft.length - 1 - tail] === keysRight[keysRight.length - 1 - tail]
	) {
		tail += 1;
	}

	const middleLeft = keysLeft.slice(head, keysLeft.length - tail);
	const middleRight = keysRight.slice(head, keysRight.length - tail);
	const cells = middleLeft.length * middleRight.length;
	if (cells > TOOL_DIFF_CONFIG.maxDiffCells) {
		return {
			ok: false,
			message: `These two texts need a ${formatCount(middleLeft.length)} × ${formatCount(middleRight.length)} comparison table — ${formatCount(cells)} cells, over this tool's ${formatCount(TOOL_DIFF_CONFIG.maxDiffCells)}-cell budget, so nothing was compared. Lines the two sides share at the top and bottom are already excluded from that count; trim either side and try again.`,
		};
	}

	const interned = intern(middleLeft, middleRight);
	const ops = lcsOps(interned.left, interned.right, TOOL_DIFF_CONFIG.maxDiffCells);
	if (ops === null) {
		// Unreachable: the budget above is the same one lcsOps checks. It is
		// handled rather than asserted away because a silent empty diff would be
		// the worst possible answer to a real comparison.
		return { ok: false, message: 'The comparison was too large to run, so nothing was compared.' };
	}

	const rows: DiffRow[] = [];
	let leftNumber = 1;
	let rightNumber = 1;

	for (let index = 0; index < head; index += 1) {
		rows.push(sameRow(left[index] as string, right[index] as string, leftNumber, rightNumber));
		leftNumber += 1;
		rightNumber += 1;
	}

	let leftIndex = head;
	let rightIndex = head;
	for (const op of ops) {
		if (op === 'same') {
			rows.push(
				sameRow(left[leftIndex] as string, right[rightIndex] as string, leftNumber, rightNumber),
			);
			leftIndex += 1;
			rightIndex += 1;
			leftNumber += 1;
			rightNumber += 1;
		} else if (op === 'del') {
			rows.push({ op, left: leftNumber, right: null, text: left[leftIndex] as string });
			leftIndex += 1;
			leftNumber += 1;
		} else {
			rows.push({ op, left: null, right: rightNumber, text: right[rightIndex] as string });
			rightIndex += 1;
			rightNumber += 1;
		}
	}

	// The tail is counted back from each side's own end: the two files agree on
	// those lines but need not agree on where they start.
	for (let index = 0; index < tail; index += 1) {
		rows.push(
			sameRow(
				left[left.length - tail + index] as string,
				right[right.length - tail + index] as string,
				leftNumber,
				rightNumber,
			),
		);
		leftNumber += 1;
		rightNumber += 1;
	}

	let added = 0;
	let removed = 0;
	let unchanged = 0;
	let whitespaceOnly = 0;
	let sections = 0;
	let inSection = false;
	for (const row of rows) {
		if (row.op === 'add') added += 1;
		else if (row.op === 'del') removed += 1;
		else {
			unchanged += 1;
			if (row.rightText !== undefined) whitespaceOnly += 1;
		}
		const changed = row.op !== 'same';
		if (changed && !inSection) sections += 1;
		inSection = changed;
	}

	const identical = leftText === rightText;
	const lineEndingsOnly = !identical && leftNormalised === rightNormalised;
	return {
		ok: true,
		diff: {
			rows,
			added,
			removed,
			unchanged,
			sections,
			whitespaceOnly,
			leftLines: left.length,
			rightLines: right.length,
			identical,
			lineEndingsOnly,
			/*
			 * With no row changed and the texts not equal, what is left is the one
			 * difference `splitLines` treats as no difference: a line break at the
			 * very end. It is named rather than swallowed, because "these two files
			 * are the same" is exactly the answer a trailing newline makes
			 * interesting — POSIX says a text file ends with one, and git says so
			 * too when it prints "\ No newline at end of file".
			 */
			trailingNewlineOnly:
				!identical &&
				!lineEndingsOnly &&
				added === 0 &&
				removed === 0 &&
				leftNormalised.endsWith('\n') !== rightNormalised.endsWith('\n'),
			ignoreWhitespace,
			inlineWords: false,
		},
	};
}

/* ------------------------------------------------------------------------- *
 * Context, and the cap on what reaches the DOM
 * ------------------------------------------------------------------------- */

/** The context control is clamped to its configured domain, whatever the DOM says. */
export function clampContext(raw: string | number | undefined): number {
	const domain = TOOL_DIFF_CONFIG.context;
	/*
	 * An emptied control is "whatever the default is", not zero: `Number('')` is
	 * 0, which would silently switch context off — the same trap the word
	 * counter's keyword field has, and the same answer.
	 */
	const text = typeof raw === 'string' ? raw.trim() : raw;
	if (text === undefined || text === null || text === '') return domain.default;
	const value = Number(text);
	if (!Number.isFinite(value)) return domain.default;
	return Math.min(domain.max, Math.max(domain.min, Math.round(value)));
}

/**
 * Which rows a context setting shows: every changed row plus `context` unchanged
 * rows either side of one. Windows are merged as they are marked, so a file
 * changed every fourth line comes out as one block rather than as hundreds of
 * one-line hunks — and so the marking costs one pass, not rows × context.
 */
export function keepMask(rows: readonly DiffRow[], context: number): boolean[] {
	const keep = rows.map(() => false);
	const window = clampContext(context);
	let marked = -1;
	for (let index = 0; index < rows.length; index += 1) {
		if (rows[index]?.op === 'same') continue;
		const from = Math.max(0, index - window, marked + 1);
		const to = Math.min(rows.length - 1, index + window);
		for (let at = from; at <= to; at += 1) keep[at] = true;
		marked = Math.max(marked, to);
	}
	return keep;
}

/**
 * The rows to draw, with each hidden run replaced by one item that says how many
 * lines it stands for. Collapsing is a view decision, not a diff decision: the
 * counts and the copied patch are built from every row either way.
 */
export function collapseUnchanged(rows: readonly DiffRow[], context: number): DiffView[] {
	/*
	 * Nothing changed, so there is nothing for the context to be context FOR.
	 * Collapsing anyway would hide the whole text behind one "N unchanged lines
	 * not shown" item and leave the visitor staring at an empty table for the one
	 * answer they most want to check with their own eyes. The row cap still bounds
	 * the DOM. The patch does not do this: `unifiedPatch` asks keepMask directly,
	 * because a patch for two identical files has no hunks and that is the
	 * convention `git apply` expects.
	 */
	if (rows.every((row) => row.op === 'same')) return [...rows];
	const keep = keepMask(rows, context);
	const views: DiffView[] = [];
	let skipped = 0;
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index];
		if (!row) continue;
		if (keep[index]) {
			if (skipped > 0) {
				views.push({ skipped });
				skipped = 0;
			}
			views.push(row);
		} else {
			skipped += 1;
		}
	}
	if (skipped > 0) views.push({ skipped });
	return views;
}

export type VisibleViews = { views: DiffView[]; shown: number; hidden: number };

/**
 * Cap what reaches the DOM, and count what was withheld so the status line can
 * say so. Without this, a pair of files that differs on all 200,000 lines would
 * build 200,000 nodes — and the browser, not the tool, would be the thing that
 * stopped answering.
 */
export function visibleViews(views: readonly DiffView[], maxRows: number): VisibleViews {
	const limit = Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : views.length;
	if (views.length <= limit) return { views: [...views], shown: views.length, hidden: 0 };
	return { views: views.slice(0, limit), shown: limit, hidden: views.length - limit };
}

/* ------------------------------------------------------------------------- *
 * Word-level detail
 * ------------------------------------------------------------------------- */

export type WordDiff = { left: DiffSegment[]; right: DiffSegment[] };

/** A line as the pieces a word diff marks: runs of whitespace and runs of not. */
function piecesOf(line: string): string[] {
	return line.match(/\s+|\S+/g) ?? [];
}

function pushSegment(segments: DiffSegment[], op: DiffOp, text: string): void {
	const last = segments[segments.length - 1];
	/*
	 * Adjacent pieces with the same fate become one mark. "the quick" changing is
	 * one highlight rather than two, and it keeps the invariant a test can check:
	 * joining a side's segments reproduces that side's line exactly.
	 */
	if (last && last.op === op) last.text += text;
	else segments.push({ op, text });
}

/**
 * Which words changed inside one pair of lines — the same LCS as above, over the
 * line's pieces instead of over whole lines, so the visitor sees the word that
 * moved rather than two lines painted red and green.
 *
 * Returns null when the pair is over the word budget: a 4,000-character line is a
 * paragraph, the line-level answer is already the right one there, and the caller
 * leaves the row whole rather than guessing at part of it.
 */
export function diffWords(
	left: string,
	right: string,
	maxCells: number = TOOL_DIFF_CONFIG.maxWordDiffCells,
): WordDiff | null {
	const leftPieces = piecesOf(left);
	const rightPieces = piecesOf(right);
	const interned = intern(leftPieces, rightPieces);
	const ops = lcsOps(interned.left, interned.right, maxCells);
	if (ops === null) return null;

	const leftSegments: DiffSegment[] = [];
	const rightSegments: DiffSegment[] = [];
	let leftIndex = 0;
	let rightIndex = 0;
	for (const op of ops) {
		if (op === 'same') {
			const text = leftPieces[leftIndex] as string;
			leftIndex += 1;
			rightIndex += 1;
			pushSegment(leftSegments, op, text);
			pushSegment(rightSegments, op, text);
		} else if (op === 'del') {
			pushSegment(leftSegments, op, leftPieces[leftIndex] as string);
			leftIndex += 1;
		} else {
			pushSegment(rightSegments, op, rightPieces[rightIndex] as string);
			rightIndex += 1;
		}
	}
	return { left: leftSegments, right: rightSegments };
}

/**
 * Add word-level detail to every changed line pair the budget allows.
 *
 * The k-th removed line of a block is paired with the k-th added line of the same
 * block. That is a heuristic — three removed lines against one added line pairs
 * the first of each and leaves the other two whole — but it is the one
 * `git diff --word-diff` makes, and the alternative (diffing every combination)
 * is quadratic in the block size for no better answer.
 *
 * Rows are copied, never mutated: the diff a caller passed in is still the diff
 * it holds afterwards, whatever this returns.
 */
export function withInlineWords(
	diff: DiffResult,
	maxCells: number = TOOL_DIFF_CONFIG.maxWordDiffCells,
): DiffResult {
	const rows = diff.rows.slice();
	for (let index = 0; index < rows.length; index += 1) {
		if (rows[index]?.op !== 'del') continue;
		let endOfDels = index;
		while (endOfDels < rows.length && rows[endOfDels]?.op === 'del') endOfDels += 1;
		let endOfAdds = endOfDels;
		while (endOfAdds < rows.length && rows[endOfAdds]?.op === 'add') endOfAdds += 1;

		const pairs = Math.min(endOfDels - index, endOfAdds - endOfDels);
		for (let pair = 0; pair < pairs; pair += 1) {
			const leftRow = rows[index + pair];
			const rightRow = rows[endOfDels + pair];
			if (!leftRow || !rightRow) continue;
			const words = diffWords(leftRow.text, rightRow.text, maxCells);
			if (!words) continue;
			rows[index + pair] = { ...leftRow, segments: words.left };
			rows[endOfDels + pair] = { ...rightRow, segments: words.right };
		}
		index = endOfAdds - 1;
	}
	return { ...diff, rows, inlineWords: true };
}

/* ------------------------------------------------------------------------- *
 * The patch, and the sentence about it
 * ------------------------------------------------------------------------- */

export type PatchOptions = { context?: number; leftLabel?: string; rightLabel?: string };

const PATCH_PREFIX: Record<DiffOp, string> = { same: ' ', del: '-', add: '+' };

function rangeText(start: number, count: number): string {
	// `,1` is dropped the way diff drops it: one line is the default, not a range.
	return count === 1 ? String(start) : `${start},${count}`;
}

/**
 * The line number a hunk starts from on one side, when the hunk holds no line of
 * that side at all. The convention is to name the line the insertion comes AFTER
 * — 0 at the very top of the file — because naming a line the hunk does not
 * contain is what makes `git apply` refuse a patch.
 */
function precedingNumber(rows: readonly DiffRow[], from: number, side: 'left' | 'right'): number {
	for (let at = from - 1; at >= 0; at -= 1) {
		const number = rows[at]?.[side];
		if (number !== null && number !== undefined) return number;
	}
	return 0;
}

function hunkHeader(rows: readonly DiffRow[], from: number, to: number): string {
	let leftStart = 0;
	let rightStart = 0;
	let leftCount = 0;
	let rightCount = 0;
	for (let at = from; at < to; at += 1) {
		const row = rows[at];
		if (!row) continue;
		if (row.left !== null) {
			if (leftCount === 0) leftStart = row.left;
			leftCount += 1;
		}
		if (row.right !== null) {
			if (rightCount === 0) rightStart = row.right;
			rightCount += 1;
		}
	}
	if (leftCount === 0) leftStart = precedingNumber(rows, from, 'left');
	if (rightCount === 0) rightStart = precedingNumber(rows, from, 'right');
	return `@@ -${rangeText(leftStart, leftCount)} +${rangeText(rightStart, rightCount)} @@`;
}

/**
 * The comparison as a unified patch: the text `git apply` reads, and the thing
 * worth putting on the clipboard, because a screenshot of a coloured table is not
 * something a colleague can apply.
 *
 * Built from every row, not from the rows on screen — a view that is capped for
 * the DOM must not quietly produce a patch that is capped too.
 */
export function unifiedPatch(diff: DiffResult, options: PatchOptions = {}): string {
	const keep = keepMask(diff.rows, clampContext(options.context));
	const lines: string[] = [`--- ${options.leftLabel ?? 'left'}`, `+++ ${options.rightLabel ?? 'right'}`];
	let index = 0;
	while (index < diff.rows.length) {
		if (!keep[index]) {
			index += 1;
			continue;
		}
		let end = index;
		while (end < diff.rows.length && keep[end]) end += 1;
		lines.push(hunkHeader(diff.rows, index, end));
		for (let at = index; at < end; at += 1) {
			const row = diff.rows[at];
			if (!row) continue;
			lines.push(`${PATCH_PREFIX[row.op]}${row.text}`);
		}
		index = end;
	}
	return lines.join('\n');
}

export type DiffViewSummary = { shown: number; hidden: number };

/** The status line's sentence about a comparison that happened. */
export function describeDiff(diff: DiffResult, view?: DiffViewSummary): string {
	if (diff.identical) return 'The two texts are identical — line endings included.';
	if (diff.added === 0 && diff.removed === 0) {
		/*
		 * Four different "nothing changed", and each needs its own words: the same
		 * file twice, the same file saved on another operating system, the same
		 * file with or without a final line break, and the same file with the
		 * spacing squeezed. A single "no differences" would hide the only thing
		 * the visitor is actually asking about.
		 */
		if (diff.lineEndingsOnly) return 'No line differs: the only difference is line endings (CRLF versus LF).';
		if (diff.trailingNewlineOnly)
			return 'No line differs: one text ends with a line break and the other does not.';
		if (diff.whitespaceOnly > 0) {
			return (
				`No line differs once whitespace is ignored: ${formatCount(diff.whitespaceOnly)} ` +
				`${diff.whitespaceOnly === 1 ? 'line differs' : 'lines differ'} only in spacing.`
			);
		}
		return 'No line differs.';
	}
	let message =
		`${formatCount(diff.removed)} removed, ${formatCount(diff.added)} added and ` +
		`${formatCount(diff.unchanged)} unchanged, in ${formatCount(diff.sections)} ` +
		`${diff.sections === 1 ? 'place' : 'places'}.`;
	if (diff.whitespaceOnly > 0) {
		message +=
			` ${formatCount(diff.whitespaceOnly)} line` +
			`${diff.whitespaceOnly === 1 ? '' : 's'} matched only because whitespace differences were ignored.`;
	}
	if (view && view.hidden > 0) {
		message +=
			` Showing the first ${formatCount(view.shown)} rows of the table; ${formatCount(view.hidden)} ` +
			'more are not on screen, and the copied patch has every line.';
	}
	return message;
}

/* ------------------------------------------------------------------------- *
 * The tool
 * ------------------------------------------------------------------------- */

/** The sign a row carries. Real text: colour is never the only signal. */
const ROW_SIGN: Record<DiffOp, string> = { same: '', del: '-', add: '+' };

/**
 * The sign for a line that matched only because whitespace differences were
 * being ignored. It gets one of its own rather than sharing the blank of an
 * ordinary unchanged line: the fold is the tool's doing, not the text's, and a
 * visitor who switched it on should be able to see which lines it touched.
 */
const WHITESPACE_SIGN = '~';

let started = false;
/** Set by init, cleared by destroy — the one place the tool is released. */
let teardown: (() => void) | null = null;

/**
 * Bind the text diff. Idempotent, and a no-op on any page without the markup, so
 * boot.ts can call it for every tool on every page.
 */
export function initTextDiff(): void {
	if (started) return;
	const root = document.querySelector<HTMLElement>('[data-text-diff]');
	if (!root) return;
	started = true;

	// One signal for every listener, as the other two tools do: teardown is then a
	// single abort() instead of a list of removeEventListener calls that can drift
	// out of sync with the bindings.
	const controller = new AbortController();
	const { signal } = controller;

	const leftInput = root.querySelector<HTMLTextAreaElement>('[data-diff-left]');
	const leftMeta = root.querySelector<HTMLElement>('[data-diff-left-meta]');
	const leftDrop = root.querySelector<HTMLElement>('[data-diff-left-drop]');
	const leftFile = root.querySelector<HTMLInputElement>('[data-diff-left-source]');
	const rightInput = root.querySelector<HTMLTextAreaElement>('[data-diff-right]');
	const rightMeta = root.querySelector<HTMLElement>('[data-diff-right-meta]');
	const rightDrop = root.querySelector<HTMLElement>('[data-diff-right-drop]');
	const rightFile = root.querySelector<HTMLInputElement>('[data-diff-right-source]');
	/*
	 * The view select is typed through a structural alias on purpose: this DOM lib
	 * declares HTMLSelectElement#remove() as returning void, which makes
	 * HTMLSelectElement structurally incompatible with Element, so
	 * querySelector<HTMLSelectElement> does not typecheck. The same workaround the
	 * other two tools use for their selects.
	 */
	const viewSelect = root.querySelector('[data-diff-view-mode]') as
		| (HTMLElement & { value: string })
		| null;
	const viewHint = root.querySelector<HTMLElement>('[data-diff-view-hint]');
	const contextInput = root.querySelector<HTMLInputElement>('[data-diff-context]');
	const contextValue = root.querySelector<HTMLElement>('[data-diff-context-value]');
	const ignoreSpaceInput = root.querySelector<HTMLInputElement>('[data-diff-ignore-space]');
	const inlineWordsInput = root.querySelector<HTMLInputElement>('[data-diff-inline-words]');
	const compareButton = root.querySelector<HTMLButtonElement>('[data-diff-compare]');
	const copyButton = root.querySelector<HTMLButtonElement>('[data-diff-copy]');
	const resetButton = root.querySelector<HTMLButtonElement>('[data-diff-reset]');
	const statusLine = root.querySelector<HTMLElement>('[data-diff-status]');
	const errorLine = root.querySelector<HTMLElement>('[data-diff-error]');
	const results = root.querySelector<HTMLElement>('[data-diff-results]');
	const statAdded = root.querySelector<HTMLElement>('[data-diff-added]');
	const statRemoved = root.querySelector<HTMLElement>('[data-diff-removed]');
	const statUnchanged = root.querySelector<HTMLElement>('[data-diff-unchanged]');
	const statSections = root.querySelector<HTMLElement>('[data-diff-sections]');
	const viewContainer = root.querySelector<HTMLElement>('[data-diff-view]');

	const panes: Record<DiffSide, {
		input: HTMLTextAreaElement | null;
		meta: HTMLElement | null;
		drop: HTMLElement | null;
		file: HTMLInputElement | null;
	}> = {
		left: { input: leftInput, meta: leftMeta, drop: leftDrop, file: leftFile },
		right: { input: rightInput, meta: rightMeta, drop: rightDrop, file: rightFile },
	};

	/* --- state ----------------------------------------------------------- */

	/** The line comparison, before word detail and before collapsing. */
	let lineDiff: DiffResult | null = null;
	/** The line comparison plus word detail: what is on screen and what gets copied. */
	let decorated: DiffResult | null = null;
	let shown = 0;
	let hidden = 0;
	let panelVisible = false;
	/** The file each side currently holds, if it came from one — used as patch labels. */
	const names: Record<DiffSide, string | null> = { left: null, right: null };
	let busy = false;
	/**
	 * Bumped by every load and reset. Reading a file is asynchronous, so a second
	 * drop — or a Reset — can land while one is still being decoded; whichever
	 * arrives last owns the tool, and the loser must not write its text over the
	 * winner's.
	 */
	let generation = 0;
	let compareTimer: number | undefined;

	/* --- small view helpers --------------------------------------------- */

	const setStatus = (message: string) => {
		if (statusLine) statusLine.textContent = message;
	};

	const showError = (message: string) => {
		if (errorLine) {
			errorLine.textContent = message;
			errorLine.hidden = false;
		}
	};

	const clearError = () => {
		if (errorLine) {
			errorLine.textContent = '';
			errorLine.hidden = true;
		}
	};

	const setBusy = (value: boolean) => {
		busy = value;
		if (compareButton) compareButton.disabled = value;
		if (resetButton) resetButton.disabled = value;
		if (copyButton) copyButton.disabled = value || decorated === null;
		if (statusLine) statusLine.dataset.busy = value ? 'true' : 'false';
	};

	/** The select's value is not trusted on its own: anything unknown is unified. */
	const viewMode = (): ToolDiffView => (viewSelect?.value === 'split' ? 'split' : 'unified');
	const contextLines = (): number => clampContext(contextInput?.value);
	const ignoreSpaceEnabled = (): boolean => ignoreSpaceInput?.checked ?? false;
	const inlineWordsEnabled = (): boolean => inlineWordsInput?.checked ?? true;

	/** The two readouts that mirror a control's own value, and the mode attribute. */
	const syncControls = () => {
		const mode = viewMode();
		root.dataset.view = mode;
		if (viewHint) viewHint.textContent = DIFF_VIEW_HINT[mode];
		if (contextValue) {
			const lines = contextLines();
			contextValue.textContent = `${formatCount(lines)} ${lines === 1 ? 'line' : 'lines'}`;
		}
	};

	/* --- rendering ------------------------------------------------------- */

	const write = (cell: HTMLElement | null, value: string) => {
		if (cell) cell.textContent = value;
	};

	/**
	 * One row of the table. The same four cells serve both views — left number,
	 * right number, sign, text — and `data-col` is the whole of the split view's
	 * alignment: CSS puts a removed line in column 1, an added line in column 2
	 * and an unchanged line across both, and `grid-auto-flow: dense` packs a block
	 * of removals beside the block of additions that replaced them. No inline
	 * styles and no row numbers, so one narrow-screen rule can stack the columns.
	 */
	const buildRow = (row: DiffRow, mode: ToolDiffView): HTMLElement => {
		const element = document.createElement('div');
		element.className = `tool__diff-row tool__diff-row--${row.op}`;
		element.dataset.op = row.op;
		element.dataset.col =
			mode === 'split' && row.op !== 'same' ? (row.op === 'del' ? 'left' : 'right') : 'both';

		const leftNumber = document.createElement('span');
		leftNumber.className = 'tool__diff-num mono';
		leftNumber.textContent = row.left === null ? '' : String(row.left);

		const rightNumber = document.createElement('span');
		rightNumber.className = 'tool__diff-num mono';
		rightNumber.textContent = row.right === null ? '' : String(row.right);

		const whitespaceOnly = row.rightText !== undefined;
		if (whitespaceOnly) element.dataset.ws = 'true';

		const sign = document.createElement('span');
		sign.className = 'tool__diff-sign mono';
		/*
		 * Not aria-hidden. A green or red row means nothing without colour, so the
		 * sign is text a screen reader reads and forced colours keep: this is the
		 * difference the colour is redundant to.
		 */
		sign.textContent = whitespaceOnly ? WHITESPACE_SIGN : ROW_SIGN[row.op];

		const text = document.createElement('span');
		text.className = 'tool__diff-text mono';
		const segments = row.segments;
		if (segments && segments.length > 0) {
			for (const segment of segments) {
				const piece = document.createElement('span');
				piece.className =
					segment.op === 'same'
						? 'tool__diff-piece'
						: `tool__diff-piece tool__diff-piece--${segment.op}`;
				/*
				 * textContent, never innerHTML: a diff renders whatever was pasted,
				 * including `<img src=x onerror=…>`, and the tool has no opinion about
				 * whose text that is.
				 */
				piece.textContent = segment.text;
				text.appendChild(piece);
			}
		} else {
			text.textContent = row.text;
		}

		element.appendChild(leftNumber);
		element.appendChild(rightNumber);
		element.appendChild(sign);
		element.appendChild(text);
		return element;
	};

	const buildSkipRow = (skipped: number): HTMLElement => {
		const element = document.createElement('div');
		element.className = 'tool__diff-row tool__diff-row--skip';
		element.dataset.col = 'both';
		const label = document.createElement('span');
		label.className = 'tool__diff-skip';
		label.textContent = `⋯ ${formatCount(skipped)} unchanged ${skipped === 1 ? 'line' : 'lines'} not shown`;
		element.appendChild(label);
		return element;
	};

	/** The only writer of the four tiles. */
	const renderStats = (next: DiffResult) => {
		write(statAdded, formatCount(next.added));
		write(statRemoved, formatCount(next.removed));
		write(statUnchanged, formatCount(next.unchanged));
		write(statSections, formatCount(next.sections));
	};

	/**
	 * Put a comparison on screen: word detail if it is switched on, then the
	 * context collapse, then the DOM cap. Everything cheaper is reused — the line
	 * comparison itself is only re-run when the texts or the whitespace setting
	 * change, so moving the context slider over a large diff costs a re-render and
	 * not a re-diff.
	 */
	const present = (announce: boolean) => {
		const next = decorated;
		if (!next) return;
		syncControls();
		const views = visibleViews(
			collapseUnchanged(next.rows, contextLines()),
			TOOL_DIFF_CONFIG.maxRenderedRows,
		);
		shown = views.shown;
		hidden = views.hidden;
		if (viewContainer) {
			/*
			 * One replaceChildren rather than one appendChild per row: a single
			 * mutation for the whole table. Spreading the built rows is safe
			 * because the row cap above keeps the count near a thousand, far under
			 * any engine's argument limit.
			 */
			const built = views.views.map((item) =>
				'skipped' in item ? buildSkipRow(item.skipped) : buildRow(item, viewMode()),
			);
			viewContainer.replaceChildren(...built);
		}
		renderStats(next);
		if (results) results.hidden = !panelVisible;
		if (copyButton) copyButton.disabled = busy || !panelVisible;
		if (!panelVisible) {
			setStatus('Nothing to compare yet.');
			return;
		}
		if (announce) setStatus(describeDiff(next, { shown, hidden }));
	};

	/** Back to the empty panel. Rendered, not cleared cell by cell, so the empty state and a compared state cannot drift. */
	const clearDiff = () => {
		lineDiff = null;
		decorated = null;
		shown = 0;
		hidden = 0;
		panelVisible = false;
		// The empty panel is rendered through the same writer as a compared one,
		// so the two cannot drift apart.
		renderStats(emptyDiff());
		if (viewContainer) viewContainer.replaceChildren();
		if (results) results.hidden = true;
		if (copyButton) copyButton.disabled = true;
	};

	/* --- the pipeline ---------------------------------------------------- */

	/** Returns whether a comparison happened — a refusal says why itself. */
	const recompare = (announce: boolean): boolean => {
		if (busy) return false;
		const leftText = leftInput?.value ?? '';
		const rightText = rightInput?.value ?? '';
		const outcome = diffLines(leftText, rightText, { ignoreWhitespace: ignoreSpaceEnabled() });
		if (!outcome.ok) {
			/*
			 * The panel is cleared rather than left up: the refused text IS what the
			 * visitor is looking at, so a surviving diff would describe texts that
			 * are no longer in the boxes.
			 */
			clearDiff();
			showError(outcome.message);
			setStatus('Nothing compared.');
			return false;
		}
		clearError();
		lineDiff = outcome.diff;
		decorated = inlineWordsEnabled() ? withInlineWords(outcome.diff) : outcome.diff;
		panelVisible = leftText.trim().length > 0 || rightText.trim().length > 0;
		present(announce);
		return true;
	};

	/** The word pass alone, for the checkbox that switches it. */
	const rebuildWords = () => {
		if (!lineDiff) return;
		decorated = inlineWordsEnabled() ? withInlineWords(lineDiff) : lineDiff;
		present(false);
	};

	const cancelCompare = () => {
		if (compareTimer !== undefined) window.clearTimeout(compareTimer);
		compareTimer = undefined;
	};

	const scheduleCompare = () => {
		cancelCompare();
		compareTimer = window.setTimeout(() => {
			compareTimer = undefined;
			recompare(false);
		}, TOOL_DIFF_CONFIG.recompareDelayMs);
	};

	/**
	 * Typing re-runs the comparison, but only while both sides are small. A diff
	 * is O(n×m) where a word count is O(n), so this threshold sits far below the
	 * limit; past it the visitor presses Compare. `.length` is the measure here
	 * rather than code points: it is a property read instead of a walk over every
	 * character on every keystroke, and a threshold this approximate does not need
	 * to be exact.
	 */
	const onInput = () => {
		const limit = TOOL_DIFF_CONFIG.autoCompareMaxCharacters;
		const leftLength = leftInput?.value.length ?? 0;
		const rightLength = rightInput?.value.length ?? 0;
		if (leftLength > limit || rightLength > limit) {
			cancelCompare();
			clearDiff();
			clearError();
			setStatus(
				`One side is over ${formatCount(limit)} characters, so the comparison no longer runs as you type. Press Compare when both sides are ready.`,
			);
			return;
		}
		scheduleCompare();
	};

	const load = async (file: TextFile, side: DiffSide) => {
		clearError();
		const check = checkTextFile(file);
		if (!check.ok) {
			showError(check.message);
			return;
		}
		const pane = panes[side];
		if (!pane.input) return;
		if (typeof file.text !== 'function') {
			showError(
				'This browser cannot read a file as text (File.text is unavailable), so the file was not loaded.',
			);
			return;
		}

		// Claim the slot BEFORE the first await (see `generation` above).
		const token = (generation += 1);
		setBusy(true);
		setStatus(`Reading ${file.name}…`);

		let text: string;
		try {
			text = await file.text();
		} catch {
			if (token !== generation) return;
			setBusy(false);
			showError(`Could not read “${file.name}”. The browser refused to decode it as text.`);
			return;
		}
		// Superseded mid-read: this text belongs to nobody, and the pane is left
		// holding whatever the winner put there.
		if (token !== generation) return;

		pane.input.value = text;
		names[side] = file.name;
		if (pane.meta) pane.meta.textContent = `${file.name} · ${file.type || 'text'} · ${formatBytes(file.size)}`;
		setBusy(false);
		/*
		 * A loaded file is compared straight away, over the auto-compare threshold
		 * or not: dropping two files IS the request, and waiting for a keypress
		 * that will not come would look like a dropped file. A refusal, if the file
		 * is over the character limit, has already been shown by recompare.
		 */
		if (!recompare(false)) return;
		if (token !== generation) return;

		const mojibake = looksLikeMojibake(text)
			? ' It does not look like UTF-8 text, so those characters may be mojibake.'
			: '';
		setStatus(
			`Loaded ${file.name} into the ${side} side — ${formatBytes(file.size)}, ${formatCount(splitLines(text).length)} lines.${mojibake}`,
		);
	};

	const copy = async () => {
		const next = decorated;
		if (!next) return;
		const patch = unifiedPatch(next, {
			context: contextLines(),
			leftLabel: names.left ?? 'left',
			rightLabel: names.right ?? 'right',
		});
		const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
		if (!clipboard?.writeText) {
			// No clipboard API is not a failed copy, it is no copy: say so, and
			// point at the table instead of pretending.
			setStatus(
				'This browser has no clipboard API (it needs a secure context), so nothing was copied. The table above is the comparison.',
			);
			return;
		}
		try {
			await clipboard.writeText(patch);
			setStatus(
				`Patch copied — ${formatCount(next.removed)} removed, ${formatCount(next.added)} added, ${formatCount(next.sections)} ${next.sections === 1 ? 'hunk' : 'hunks'}.`,
			);
		} catch {
			setStatus('The clipboard refused the copy, so nothing was copied.');
		}
	};

	const reset = () => {
		generation += 1;
		cancelCompare();
		for (const side of ['left', 'right'] as const) {
			const pane = panes[side];
			if (pane.input) pane.input.value = '';
			if (pane.file) pane.file.value = '';
			if (pane.meta) pane.meta.textContent = '';
			names[side] = null;
		}
		// The controls are only reset where they are the visitor's to move.
		if (viewSelect) viewSelect.value = DIFF_VIEWS[0] as ToolDiffView;
		if (contextInput) contextInput.value = String(TOOL_DIFF_CONFIG.context.default);
		if (ignoreSpaceInput) ignoreSpaceInput.checked = false;
		if (inlineWordsInput) inlineWordsInput.checked = true;
		clearError();
		clearDiff();
		syncControls();
		setBusy(false);
		setStatus('Paste two texts, or drop two files. Nothing leaves this tab.');
	};

	/* --- events ---------------------------------------------------------- */

	leftInput?.addEventListener('input', onInput, { signal });
	rightInput?.addEventListener('input', onInput, { signal });

	leftFile?.addEventListener(
		'change',
		() => {
			const file = leftFile.files?.[0];
			if (file) void load(file, 'left');
		},
		{ signal },
	);
	rightFile?.addEventListener(
		'change',
		() => {
			const file = rightFile.files?.[0];
			if (file) void load(file, 'right');
		},
		{ signal },
	);

	// A view change moves pixels, not text: re-render, never re-diff.
	viewSelect?.addEventListener(
		'change',
		() => {
			syncControls();
			present(false);
		},
		{ signal },
	);
	contextInput?.addEventListener(
		'input',
		() => {
			syncControls();
			present(false);
		},
		{ signal },
	);
	inlineWordsInput?.addEventListener('change', rebuildWords, { signal });
	// Ignoring whitespace changes what "equal" means, so it changes the diff.
	ignoreSpaceInput?.addEventListener(
		'change',
		() => {
			recompare(false);
		},
		{ signal },
	);

	compareButton?.addEventListener(
		'click',
		() => {
			recompare(true);
		},
		{ signal },
	);
	copyButton?.addEventListener('click', () => void copy(), { signal });
	resetButton?.addEventListener('click', reset, { signal });

	/*
	 * Drag and drop is the other way in, once per side. dragover must be
	 * cancelled or the browser navigates to the dropped file instead of handing
	 * it over.
	 */
	for (const side of ['left', 'right'] as const) {
		const zone = panes[side].drop;
		if (!zone) continue;
		zone.addEventListener(
			'dragover',
			(event) => {
				event.preventDefault();
				zone.dataset.dragOver = 'true';
			},
			{ signal },
		);
		zone.addEventListener(
			'dragleave',
			() => {
				zone.dataset.dragOver = 'false';
			},
			{ signal },
		);
		zone.addEventListener(
			'drop',
			(event) => {
				event.preventDefault();
				zone.dataset.dragOver = 'false';
				const file = event.dataTransfer?.files?.[0];
				if (file) void load(file, side);
			},
			{ signal },
		);
	}

	// Leaving the page is the last release path: two half-pasted files should not
	// survive in textareas that are about to be thrown away, with a debounce timer
	// pointing at them.
	window.addEventListener('pagehide', reset, { signal });

	teardown = () => {
		controller.abort();
		cancelCompare();
		reset();
	};

	syncControls();
	clearDiff();
	setBusy(false);
	setStatus('Paste two texts, or drop two files. Nothing leaves this tab.');
}

/**
 * Release every listener this tool owns, empty both textareas and re-arm the
 * init, so a second call binds a fresh subtree. Used by the tests and by anything
 * that ever swaps the page's content without a reload.
 */
export function destroyTextDiff(): void {
	const release = teardown;
	teardown = null;
	started = false;
	release?.();
}
