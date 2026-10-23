/**
 * BNJI.NET — the /projects/tools/ text diff's decisions.
 *
 * No browser can be started here, so this file covers everything pure — how a
 * text becomes lines, what the comparison says about two texts, how much of it
 * the context setting shows, what the word pass marks, what the patch looks
 * like — and then drives the real controller against the DOM shim for the parts
 * only a controller can get wrong: the debounce, the auto-compare threshold that
 * must CLEAR the panel rather than leave a stale one, a refusal that must name
 * the side it came from, two files dropped at once where the loser must not
 * write over the winner, and a copy button that must never claim a patch the
 * clipboard refused.
 *
 * The invariants matter more than the examples. A diff that loses a line, that
 * renumbers one side against the other, or that renders a pasted
 * `<img src=x onerror=…>` as markup is broken in a way no single fixture shows,
 * so several tests below assert a property over many inputs instead of one
 * answer over one input.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './support/dom.mjs';
import { TOOL_DIFF_CONFIG } from '../src/config/tools.config.ts';
import {
	checkSideText,
	clampContext,
	collapseUnchanged,
	describeDiff,
	diffLines,
	diffWords,
	emptyDiff,
	keepMask,
	normaliseLineEndings,
	splitLines,
	unifiedPatch,
	visibleViews,
	withInlineWords,
	type DiffOutcome,
	type DiffResult,
	type DiffRow,
	type DiffView,
} from '../src/scripts/tools-diff.ts';

type Dom = ReturnType<typeof installTestDom>;

/* --- helpers -------------------------------------------------------------- */

/** Unwrap a comparison, failing the test with the refusal's own sentence. */
function must(outcome: DiffOutcome): DiffResult {
	if (!outcome.ok) throw new Error(`the comparison was refused: ${outcome.message}`);
	return outcome.diff;
}

const SIGN: Record<string, string> = { same: ' ', del: '-', add: '+' };

/** The edit script as one string: ' -+ ' is unchanged, removed, added, unchanged. */
function script(diff: DiffResult): string {
	return diff.rows.map((row) => SIGN[row.op] ?? '?').join('');
}

/** N lines of filler that differ on the two sides, for the budget tests. */
function distinctLines(prefix: string, count: number): string {
	const lines: string[] = [];
	for (let index = 0; index < count; index += 1) lines.push(`${prefix}${index}`);
	return lines.join('\n');
}

/** The rows that are not skips, out of a collapsed view. */
function onlyRows(views: readonly DiffView[]): DiffRow[] {
	return views.filter((view): view is DiffRow => !('skipped' in view));
}

/** The skip items, out of a collapsed view. */
function onlySkips(views: readonly DiffView[]): number[] {
	return views.flatMap((view) => ('skipped' in view ? [view.skipped] : []));
}

/* --- lines ---------------------------------------------------------------- */

test('line endings are normalised before anything is compared', () => {
	assert.equal(normaliseLineEndings('a\r\nb\r\nc'), 'a\nb\nc');
	assert.equal(normaliseLineEndings('a\rb'), 'a\nb', 'a lone CR from a classic Mac is a line break too');
	assert.equal(normaliseLineEndings('a\nb'), 'a\nb');
	assert.equal(normaliseLineEndings(''), '');
});

test('a trailing line break ends a line; it does not start an empty one', () => {
	assert.deepEqual(splitLines(''), []);
	assert.deepEqual(splitLines('a'), ['a']);
	assert.deepEqual(splitLines('a\n'), ['a']);
	assert.deepEqual(splitLines('a\r\n'), ['a'], 'the same file saved on Windows');
	assert.deepEqual(splitLines('a\n\n'), ['a', ''], 'a blank line in the middle is a line');
	assert.deepEqual(splitLines('\n'), ['']);
	assert.deepEqual(splitLines('a\nb\nc'), ['a', 'b', 'c']);
});

/* --- the comparison ------------------------------------------------------- */

test('one changed line, with the numbers each side owns', () => {
	const diff = must(diffLines('a\nb\nc', 'a\nX\nc'));
	assert.equal(script(diff), ' -+ ');
	assert.deepEqual(
		diff.rows.map((row) => [row.op, row.left, row.right, row.text]),
		[
			['same', 1, 1, 'a'],
			// A removed line has no right number and an added line has no left one:
			// inventing either would be the numbering lie this tool must not tell.
			['del', 2, null, 'b'],
			['add', null, 2, 'X'],
			['same', 3, 3, 'c'],
		],
	);
	assert.equal(diff.removed, 1);
	assert.equal(diff.added, 1);
	assert.equal(diff.unchanged, 2);
	assert.equal(diff.sections, 1);
	assert.equal(diff.leftLines, 3);
	assert.equal(diff.rightLines, 3);
	assert.equal(diff.identical, false);
});

test('a changed block puts every removal above every addition', () => {
	// The tie-break in the table walk is what decides this. Interleaved, the
	// unified view reads as three separate edits instead of one rewrite.
	const diff = must(diffLines('one\ntwo\nthree', 'ONE\nTWO\nTHREE'));
	assert.equal(script(diff), '---+++');
	assert.equal(diff.sections, 1, 'one block, not three');
});

test('two blocks are counted as two', () => {
	const left = distinctLines('line ', 10);
	const right = left.replace('line 1', 'LINE 1').replace('line 8', 'LINE 8');
	const diff = must(diffLines(left, right));
	assert.equal(diff.sections, 2);
	assert.equal(diff.removed, 2);
	assert.equal(diff.added, 2);
	assert.equal(diff.unchanged, 8);
});

test('an insertion at the top and a deletion at the end', () => {
	const inserted = must(diffLines('b\nc', 'a\nb\nc'));
	assert.equal(script(inserted), '+  ');
	assert.deepEqual(inserted.rows[0], { op: 'add', left: null, right: 1, text: 'a' });
	assert.equal(inserted.added, 1);
	assert.equal(inserted.removed, 0);

	const deleted = must(diffLines('a\nb\nc', 'a\nb'));
	assert.equal(script(deleted), '  -');
	assert.deepEqual(deleted.rows[2], { op: 'del', left: 3, right: null, text: 'c' });
});

test('every line of both sides is accounted for, over many shapes of edit', () => {
	/*
	 * The invariant a diff is judged by: the rows carrying a left number are
	 * exactly the left file's lines, in order, and the same on the right. Lose one
	 * line, duplicate one, or number one side by the other's count and this fails
	 * for whichever shape of edit broke it.
	 */
	const cases: Array<[string, string]> = [
		['', ''],
		['', 'a'],
		['a', ''],
		['a', 'a'],
		['a\nb\nc', 'a\nX\nc'],
		['a\nb\nc', 'a\nb\nc\nd'],
		['a\nb\nc\nd', 'a\nd'],
		['x\ny\nz', 'z\ny\nx'],
		['1\n2\n3\n4\n5', '1\n3\n5'],
		['a\nb\nc', 'A\nb\nC'],
		['line\nline\nline', 'line\nline'],
		['\n\n\n', '\n\n'],
	];
	for (const [left, right] of cases) {
		const diff = must(diffLines(left, right));
		const leftNumbers = diff.rows.filter((row) => row.left !== null).map((row) => row.left);
		const rightNumbers = diff.rows.filter((row) => row.right !== null).map((row) => row.right);
		const label = `${JSON.stringify(left)} vs ${JSON.stringify(right)}`;
		assert.deepEqual(
			leftNumbers,
			splitLines(left).map((_, index) => index + 1),
			`left numbering for ${label}`,
		);
		assert.deepEqual(
			rightNumbers,
			splitLines(right).map((_, index) => index + 1),
			`right numbering for ${label}`,
		);
		// And the rows' own text is the text of the line they claim to be.
		for (const row of diff.rows) {
			if (row.op === 'add') assert.equal(row.text, splitLines(right)[(row.right ?? 0) - 1], label);
			else assert.equal(row.text, splitLines(left)[(row.left ?? 0) - 1], label);
		}
		assert.equal(diff.removed + diff.unchanged, diff.leftLines, label);
		assert.equal(diff.added + diff.unchanged, diff.rightLines, label);
	}
});

test('the two texts equal, and the two texts empty', () => {
	const same = must(diffLines('a\nb\n', 'a\nb\n'));
	assert.equal(same.identical, true);
	assert.equal(script(same), '  ');
	assert.equal(same.sections, 0);
	assert.equal(describeDiff(same), 'The two texts are identical — line endings included.');

	const nothing = must(diffLines('', ''));
	assert.equal(nothing.identical, true);
	assert.deepEqual(nothing.rows, []);
	assert.equal(nothing.leftLines, 0);
});

test('CRLF against LF is named, not shown as every line changed', () => {
	const diff = must(diffLines('a\r\nb\r\nc', 'a\nb\nc'));
	assert.equal(diff.identical, false, 'the bytes are not the same');
	assert.equal(diff.lineEndingsOnly, true);
	assert.equal(diff.trailingNewlineOnly, false);
	assert.equal(diff.added + diff.removed, 0, 'no line changed');
	assert.equal(diff.unchanged, 3);
	assert.equal(describeDiff(diff), 'No line differs: the only difference is line endings (CRLF versus LF).');
});

test('a final line break is named rather than swallowed', () => {
	const diff = must(diffLines('a\nb', 'a\nb\n'));
	assert.equal(diff.identical, false);
	assert.equal(diff.lineEndingsOnly, false);
	assert.equal(diff.trailingNewlineOnly, true);
	assert.equal(diff.added + diff.removed, 0);
	assert.match(describeDiff(diff), /ends with a line break/);
});

/* --- refusing ------------------------------------------------------------- */

test('an over-long side is refused, and the refusal names the side', () => {
	const limit = TOOL_DIFF_CONFIG.maxInputCharacters;
	const long = 'a'.repeat(limit + 1);
	assert.equal(checkSideText(long, 'left').ok, false);
	assert.equal(checkSideText('short', 'right').ok, true);

	const outcome = diffLines('fine', long);
	assert.equal(outcome.ok, false);
	assert.match(outcome.ok ? '' : outcome.message, /The right text is 250,001 characters/);
	assert.match(outcome.ok ? '' : outcome.message, /250,000-character limit/, 'the limit is quoted, not implied');

	const other = diffLines(long, 'fine');
	assert.match(other.ok ? '' : other.message, /^The left text/, 'and the other side is named when it is the left one');
});

test('a comparison bigger than the cell budget is refused with both sizes', () => {
	const over = 2001;
	const outcome = diffLines(distinctLines('L', over), distinctLines('R', over));
	assert.equal(outcome.ok, false);
	const message = outcome.ok ? '' : outcome.message;
	assert.match(message, /2,001 × 2,001 comparison table/);
	assert.match(message, /4,004,001 cells/);
	assert.match(message, /4,000,000-cell budget/, 'the budget the config sets is the budget quoted');
});

test('the budget is the number of cells, not the size of the files', () => {
	/*
	 * 10,000 shared lines and one change: 10,001 × 10,001 is 100 million cells,
	 * which the tool would refuse — except that the shared head and tail are
	 * trimmed first, so the table is 1 × 1. This is the case the trim exists for,
	 * and without it the tool would refuse the most common diff there is.
	 */
	const shared = distinctLines('log line ', 5000);
	const left = `${shared}\nbefore\n${shared}`;
	const right = `${shared}\nafter\n${shared}`;
	const diff = must(diffLines(left, right));
	assert.equal(diff.removed, 1);
	assert.equal(diff.added, 1);
	assert.equal(diff.leftLines, 10001);
	assert.equal(diff.unchanged, 10000);
});

test('exactly the budget is allowed, one cell over is not', () => {
	const at = 2000;
	assert.equal(must(diffLines(distinctLines('L', at), distinctLines('R', at))).rows.length, 4000);
	assert.equal(diffLines(distinctLines('L', at + 1), distinctLines('R', at + 1)).ok, false);
});

/* --- ignoring whitespace -------------------------------------------------- */

test('ignoring whitespace compares folded lines but shows the originals', () => {
	const diff = must(diffLines('a  b\nend', 'a b\nend', { ignoreWhitespace: true }));
	assert.equal(diff.ignoreWhitespace, true);
	assert.equal(script(diff), '  ');
	assert.equal(diff.whitespaceOnly, 1);
	assert.equal(diff.trailingNewlineOnly, false, 'a spacing difference is not a line-break difference');
	// The row shows what the visitor typed, on both sides — never a rewritten line.
	assert.equal(diff.rows[0]?.text, 'a  b');
	assert.equal(diff.rows[0]?.rightText, 'a b');
	assert.match(describeDiff(diff), /1 line differs only in spacing/);
});

test('the same texts without the option are two different lines', () => {
	const diff = must(diffLines('a  b', 'a b'));
	assert.equal(script(diff), '-+');
	assert.equal(diff.whitespaceOnly, 0);
});

test('ignoring whitespace still reports a real change', () => {
	const diff = must(diffLines('a  b\nc', 'a b\nd', { ignoreWhitespace: true }));
	assert.equal(script(diff), ' -+');
	assert.equal(diff.whitespaceOnly, 1);
	assert.equal(diff.removed, 1);
	assert.equal(diff.added, 1);
});

/* --- context -------------------------------------------------------------- */

const CONTEXT_DIFF = must(
	diffLines(distinctLines('line ', 20).replace('line 10', 'LINE 10'), distinctLines('line ', 20)),
);

test('the context setting is clamped to its configured domain', () => {
	assert.equal(clampContext(undefined), TOOL_DIFF_CONFIG.context.default);
	assert.equal(clampContext(''), TOOL_DIFF_CONFIG.context.default, 'an emptied number input is the default, not zero');
	assert.equal(clampContext('abc'), TOOL_DIFF_CONFIG.context.default);
	assert.equal(clampContext('-4'), TOOL_DIFF_CONFIG.context.min);
	assert.equal(clampContext('99'), TOOL_DIFF_CONFIG.context.max);
	assert.equal(clampContext('5.6'), 6);
});

test('context 0 shows the change and nothing else', () => {
	const views = collapseUnchanged(CONTEXT_DIFF.rows, 0);
	assert.equal(onlyRows(views).length, 2, 'the removed line and the line that replaced it');
	assert.deepEqual(onlySkips(views), [10, 9]);
	assert.deepEqual(
		onlyRows(views).map((row) => row.text),
		['LINE 10', 'line 10'],
	);
});

test('three lines of context keep three lines either side', () => {
	const views = collapseUnchanged(CONTEXT_DIFF.rows, 3);
	assert.equal(onlyRows(views).length, 8);
	assert.deepEqual(onlySkips(views), [7, 6]);
	// Nothing is lost: what is shown plus what is said to be hidden is the whole diff.
	assert.equal(onlyRows(views).length + onlySkips(views).reduce((a, b) => a + b, 0), CONTEXT_DIFF.rows.length);
});

test('overlapping windows merge into one block', () => {
	// Two changes four lines apart with three lines of context touch, and a
	// hidden-run item between them would claim lines that are in fact shown.
	const diff = must(
		diffLines(
			distinctLines('l ', 10).replace('l 2', 'L2').replace('l 6', 'L6'),
			distinctLines('l ', 10),
		),
	);
	const views = collapseUnchanged(diff.rows, 3);
	assert.deepEqual(onlySkips(views), [], 'nothing hidden, so no skip items at all');
	assert.equal(onlyRows(views).length, diff.rows.length);
});

test('the keep mask marks every changed row whatever the context', () => {
	for (const context of [0, 1, 3, 12]) {
		const keep = keepMask(CONTEXT_DIFF.rows, context);
		assert.equal(keep.length, CONTEXT_DIFF.rows.length);
		CONTEXT_DIFF.rows.forEach((row, index) => {
			if (row.op !== 'same') assert.equal(keep[index], true, `context ${context} must keep row ${index}`);
		});
	}
	assert.equal(keepMask([], 3).length, 0);
});

/* --- the DOM cap ---------------------------------------------------------- */

test('the view is capped, and what is withheld is counted', () => {
	const views: DiffView[] = [{ skipped: 2 }, { skipped: 3 }];
	const capped = visibleViews(views, 1);
	assert.equal(capped.shown, 1);
	assert.equal(capped.hidden, 1);
	assert.equal(capped.views.length, 1);

	const all = visibleViews(views, 100);
	assert.equal(all.hidden, 0);
	assert.equal(all.shown, 2);

	// A nonsense cap means "no cap", not "no rows".
	assert.equal(visibleViews(views, 0).hidden, 0);
	assert.equal(visibleViews(views, Number.NaN).hidden, 0);
});

/* --- the word pass -------------------------------------------------------- */

test('a word diff marks the word that moved and nothing else', () => {
	const words = diffWords('the quick brown fox', 'the slow brown fox');
	assert.ok(words);
	assert.deepEqual(words.left, [
		{ op: 'same', text: 'the ' },
		{ op: 'del', text: 'quick' },
		{ op: 'same', text: ' brown fox' },
	]);
	assert.deepEqual(words.right, [
		{ op: 'same', text: 'the ' },
		{ op: 'add', text: 'slow' },
		{ op: 'same', text: ' brown fox' },
	]);
});

test("each side's segments join back into that side's line, whitespace included", () => {
	const cases: Array<[string, string]> = [
		['the quick brown fox', 'the slow brown fox'],
		['a\tb', 'a  b'],
		['one', 'one two'],
		['', 'something'],
		['  leading and trailing  ', 'leading and trailing'],
		['a b c d e', 'a B c D e'],
		['no change here', 'no change here'],
	];
	for (const [left, right] of cases) {
		const words = diffWords(left, right);
		assert.ok(words, `${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
		assert.equal(words.left.map((piece) => piece.text).join(''), left, 'the left line survives its own segments');
		assert.equal(words.right.map((piece) => piece.text).join(''), right, 'and the right line its own');
		// No segment is empty: an empty mark is a span that highlights nothing.
		for (const piece of [...words.left, ...words.right]) assert.notEqual(piece.text, '');
	}
});

test('a pair too big for the word budget is left whole, not guessed at', () => {
	// Five pieces a side — three words and the two spaces between them — so the
	// table is 25 cells and the budget decides at exactly that number.
	assert.equal(diffWords('alpha beta gamma', 'alpha delta gamma', 24), null);
	assert.ok(diffWords('alpha beta gamma', 'alpha delta gamma', 25));
	assert.equal(diffWords('alpha beta gamma', 'alpha delta gamma', TOOL_DIFF_CONFIG.maxWordDiffCells) !== null, true);
});

test('word detail is added to the pairs of a block, and to nothing else', () => {
	const diff = must(diffLines('the quick brown fox\nsecond\nthird', 'the slow brown fox'));
	const decorated = withInlineWords(diff);
	assert.equal(decorated.inlineWords, true);
	assert.equal(diff.inlineWords, false, 'the diff passed in is not rewritten');
	assert.equal(diff.rows[0]?.segments, undefined, 'and its rows keep no segments');

	// Three removals against one addition: the first of each is paired, the rest
	// stay whole rather than being diffed against a line they have nothing to do with.
	assert.ok(decorated.rows[0]?.segments, 'the paired removal');
	assert.equal(decorated.rows[1]?.segments, undefined);
	assert.equal(decorated.rows[2]?.segments, undefined);
	assert.ok(decorated.rows[3]?.segments, 'the paired addition');
	assert.equal(
		decorated.rows[0]?.segments?.map((piece) => piece.text).join(''),
		'the quick brown fox',
	);
});

test('word detail is switched off by passing the diff through untouched', () => {
	const diff = must(diffLines('a b', 'a c'));
	assert.equal(diff.rows.every((row) => row.segments === undefined), true);
});

/* --- the patch ------------------------------------------------------------ */

test('a patch is what git apply reads', () => {
	const diff = must(diffLines('a\nb\nc', 'a\nX\nc'));
	assert.equal(
		unifiedPatch(diff),
		['--- left', '+++ right', '@@ -1,3 +1,3 @@', ' a', '-b', '+X', ' c'].join('\n'),
	);
	assert.equal(
		unifiedPatch(diff, { context: 0, leftLabel: 'draft.txt', rightLabel: 'final.txt' }),
		['--- draft.txt', '+++ final.txt', '@@ -2 +2 @@', '-b', '+X'].join('\n'),
		'A single line drops the ,1 the way diff does',
	);
});

test('a hunk that only inserts names the line it comes after', () => {
	const middle = must(diffLines('a\nb', 'a\nNEW\nb'));
	assert.equal(
		unifiedPatch(middle, { context: 0 }),
		['--- left', '+++ right', '@@ -1,0 +2 @@', '+NEW'].join('\n'),
	);
	const top = must(diffLines('b\nc', 'a\nb\nc'));
	assert.equal(
		unifiedPatch(top, { context: 0 }),
		['--- left', '+++ right', '@@ -0,0 +1 @@', '+a'].join('\n'),
		'nothing precedes an insertion at the very top, so it is line 0',
	);
	const bottom = must(diffLines('a\nb', 'a\nb\nc'));
	assert.match(unifiedPatch(bottom, { context: 0 }), /@@ -2,0 \+3 @@/);
});

test('two changes are two hunks, each with its own header', () => {
	const diff = must(
		diffLines(distinctLines('l ', 20).replace('l 2', 'L2').replace('l 17', 'L17'), distinctLines('l ', 20)),
	);
	const patch = unifiedPatch(diff, { context: 1 });
	assert.equal(patch.match(/^@@ /gm)?.length, 2);
	assert.match(patch, /^@@ -2,3 \+2,3 @@$/m);
	assert.match(patch, /^@@ -17,3 \+17,3 @@$/m);
});

test('identical texts produce a patch with no hunks in it', () => {
	const diff = must(diffLines('a\nb', 'a\nb'));
	assert.equal(unifiedPatch(diff), '--- left\n+++ right');
});

test('a patch holds every line, even when the view is capped', () => {
	const diff = must(diffLines(distinctLines('L', 60), distinctLines('R', 60)));
	const views = visibleViews(collapseUnchanged(diff.rows, 0), 10);
	assert.ok(views.hidden > 0, 'the view is capped');
	const patch = unifiedPatch(diff, { context: 0 });
	// 60 of each, plus the two label lines that also start with - and +.
	assert.equal(patch.split('\n').filter((line) => line.startsWith('-')).length, 61);
	assert.equal(patch.split('\n').filter((line) => line.startsWith('+')).length, 61);
});

/* --- the sentence --------------------------------------------------------- */

test('the status sentence says what changed and how much is not on screen', () => {
	const diff = must(diffLines('a\nb\nc\nd', 'a\nB\nc\nd'));
	assert.equal(describeDiff(diff), '1 removed, 1 added and 3 unchanged, in 1 place.');

	const two = must(
		diffLines(distinctLines('l ', 20).replace('l 2', 'L2').replace('l 17', 'L17'), distinctLines('l ', 20)),
	);
	assert.match(describeDiff(two), /in 2 places\.$/);

	const big = must(diffLines(distinctLines('L', 40), distinctLines('R', 40)));
	assert.match(
		describeDiff(big, { shown: 12, hidden: 68 }),
		/Showing the first 12 rows of the table; 68 more are not on screen, and the copied patch has every line\./,
	);
	assert.doesNotMatch(describeDiff(big, { shown: 80, hidden: 0 }), /not on screen/);
});

test('the empty diff is all zeros, so the cleared panel has one source', () => {
	const empty = emptyDiff();
	assert.deepEqual(empty.rows, []);
	assert.equal(empty.added, 0);
	assert.equal(empty.removed, 0);
	assert.equal(empty.unchanged, 0);
	assert.equal(empty.sections, 0);
	assert.equal(empty.identical, false, 'two absent texts are not "identical" to a visitor');
	// Never shown: the panel is hidden while there is no comparison. Asserted
	// anyway, because a helper that throws on the empty case would be a trap.
	assert.equal(describeDiff(empty), 'No line differs.');
});

/* ========================================================================= *
 * The controller, against the DOM shim.
 *
 * The shim's rule is that an unsupported selector THROWS rather than matching
 * nothing, so every query below is a claim that the markup has that hook.
 * ========================================================================= */

/**
 * The shim's nodes are not typed as DOM nodes, and they are not: they are the
 * small slice of the DOM this tool touches. These aliases name that slice once,
 * so the assertions below read as assertions and not as casts.
 */
type ShimNode = {
	textContent: string;
	dataset: Record<string, string>;
	hidden: boolean;
	disabled: boolean;
	value: string;
	checked: boolean;
	files: FakeFile[];
};

type FakeFile = { name: string; type: string; size: number; text(): Promise<string> };

/** The diff's markup, mirroring src/components/tools/TextDiff.astro. */
const HOOKS: Record<string, string> = {
	'data-diff-left': 'textarea',
	'data-diff-left-meta': 'p',
	'data-diff-left-drop': 'label',
	'data-diff-left-source': 'input',
	'data-diff-right': 'textarea',
	'data-diff-right-meta': 'p',
	'data-diff-right-drop': 'label',
	'data-diff-right-source': 'input',
	'data-diff-view-mode': 'select',
	'data-diff-view-hint': 'p',
	'data-diff-context': 'input',
	'data-diff-context-value': 'span',
	'data-diff-ignore-space': 'input',
	'data-diff-inline-words': 'input',
	'data-diff-compare': 'button',
	'data-diff-copy': 'button',
	'data-diff-reset': 'button',
	'data-diff-status': 'p',
	'data-diff-error': 'p',
	'data-diff-results': 'div',
	'data-diff-added': 'dd',
	'data-diff-removed': 'dd',
	'data-diff-unchanged': 'dd',
	'data-diff-sections': 'dd',
	'data-diff-view': 'div',
};

function buildTool(dom: Dom): void {
	const { document } = dom;
	const section = document.createElement('section');
	section.setAttribute('data-text-diff', '');
	for (const [hook, tag] of Object.entries(HOOKS)) {
		const element = document.createElement(tag);
		element.setAttribute(hook, '');
		section.appendChild(element);
	}
	document.body.appendChild(section);
	// The controls the controller reads defaults from. The component renders these
	// as real attributes; a fixture without them would silently test the fallbacks.
	node(dom, '[data-diff-error]').hidden = true;
	node(dom, '[data-diff-results]').hidden = true;
	node(dom, '[data-diff-view-mode]').value = 'unified';
	node(dom, '[data-diff-context]').value = String(TOOL_DIFF_CONFIG.context.default);
	node(dom, '[data-diff-inline-words]').checked = true;
	node(dom, '[data-diff-ignore-space]').checked = false;
}

/** Install the shim, build the fixture, init the controller, and always tear down. */
async function withTool(run: (dom: Dom) => void | Promise<void>): Promise<void> {
	const dom = installTestDom();
	buildTool(dom);
	const { initTextDiff, destroyTextDiff } = await import('../src/scripts/tools-diff.ts');
	initTextDiff();
	try {
		await run(dom);
	} finally {
		destroyTextDiff();
		dom.uninstall();
	}
}

const fire = (
	element: { dispatchEvent: (event: Record<string, unknown>) => unknown },
	type: string,
	extra: Record<string, unknown> = {},
): unknown => element.dispatchEvent({ type, preventDefault: () => {}, ...extra });

function node(dom: Dom, selector: string): ShimNode {
	const found = dom.q(selector) as ShimNode | null;
	assert.ok(found, `the fixture has no ${selector}`);
	return found;
}

function nodes(dom: Dom, selector: string): ShimNode[] {
	return dom.qAll(selector) as ShimNode[];
}

/** Put text in both boxes and let the debounce elapse. */
function paste(dom: Dom, left: string, right: string, settle = true): void {
	const leftBox = node(dom, '[data-diff-left]');
	const rightBox = node(dom, '[data-diff-right]');
	leftBox.value = left;
	rightBox.value = right;
	fire(leftBox as unknown as Parameters<typeof fire>[0], 'input');
	if (settle) dom.advance(TOOL_DIFF_CONFIG.recompareDelayMs + 1);
}

const status = (dom: Dom): string => node(dom, '[data-diff-status]').textContent;
const errorOf = (dom: Dom): string => node(dom, '[data-diff-error]').textContent;
const stat = (dom: Dom, hook: string): string => node(dom, `[${hook}]`).textContent;

const drawn = (dom: Dom): ShimNode[] => nodes(dom, '[data-diff-view] .tool__diff-row');
const drawnText = (dom: Dom): string[] => drawn(dom).map((row) => row.textContent);
const drawnColumns = (dom: Dom): string[] => drawn(dom).map((row) => row.dataset.col);
const skips = (dom: Dom): string[] =>
	nodes(dom, '[data-diff-view] .tool__diff-row--skip').map((row) => row.textContent);

const textFile = (name: string, text: string, type = 'text/plain'): FakeFile => ({
	name,
	type,
	size: text.length,
	text: async () => text,
});

/** A file whose decoding the test releases by hand, to race two loads. */
function deferredFile(name: string, text: string): { file: FakeFile; release: (value: string) => void } {
	let release: (value: string) => void = () => {};
	const pending = new Promise<string>((resolve) => {
		release = resolve;
	});
	return { file: { name, type: 'text/plain', size: text.length, text: () => pending }, release };
}

/* --- the controller ------------------------------------------------------- */

test('with no tool on the page, init does nothing and destroy is safe', async () => {
	const dom = installTestDom();
	const { initTextDiff, destroyTextDiff } = await import('../src/scripts/tools-diff.ts');
	initTextDiff();
	assert.equal(dom.q('[data-diff-status]'), null, 'the fixture was never built');
	destroyTextDiff();
	dom.uninstall();
});

test('typing compares after the debounce, and not before it', async () => {
	await withTool((dom) => {
		paste(dom, 'a\nb\nc', 'a\nX\nc', false);
		assert.equal(drawn(dom).length, 0, 'nothing drawn mid-debounce');
		dom.advance(TOOL_DIFF_CONFIG.recompareDelayMs - 1);
		assert.equal(drawn(dom).length, 0, 'still nothing one tick early');
		dom.advance(2);
		assert.equal(drawn(dom).length, 4);
		assert.equal(stat(dom, 'data-diff-added'), '1');
		assert.equal(stat(dom, 'data-diff-removed'), '1');
		assert.equal(stat(dom, 'data-diff-unchanged'), '2');
		assert.equal(stat(dom, 'data-diff-sections'), '1');
		assert.equal(node(dom, '[data-diff-results]').hidden, false);
		// A keystroke does not announce itself; only Compare does.
		assert.equal(status(dom), 'Paste two texts, or drop two files. Nothing leaves this tab.');
	});
});

test('a fast typist is coalesced into one comparison', async () => {
	await withTool((dom) => {
		paste(dom, 'a', 'b', false);
		dom.advance(100);
		paste(dom, 'ab', 'b', false);
		dom.advance(100);
		paste(dom, 'abc', 'b', false);
		assert.equal(drawn(dom).length, 0, 'the two cancelled comparisons drew nothing');
		dom.advance(TOOL_DIFF_CONFIG.recompareDelayMs + 1);
		assert.equal(stat(dom, 'data-diff-removed'), '1');
		assert.equal(stat(dom, 'data-diff-added'), '1');
	});
});

test('Compare announces, and does not wait for the debounce', async () => {
	await withTool((dom) => {
		paste(dom, 'a\nb\nc', 'a\nX\nc', false);
		fire(node(dom, '[data-diff-compare]') as unknown as Parameters<typeof fire>[0], 'click');
		assert.equal(status(dom), '1 removed, 1 added and 2 unchanged, in 1 place.');
		assert.equal(drawn(dom).length, 4);
	});
});

test('past the auto-compare threshold the panel is cleared, not left stale', async () => {
	await withTool((dom) => {
		paste(dom, 'a\nb', 'a\nX');
		assert.equal(drawn(dom).length, 3, 'a small pair compares as you type');

		const limit = TOOL_DIFF_CONFIG.autoCompareMaxCharacters;
		paste(dom, 'a'.repeat(limit + 1), 'b', false);
		// Clearing is immediate: a diff left on screen would describe text that is
		// no longer in the box, which is the one thing a diff must not do.
		assert.equal(drawn(dom).length, 0);
		assert.equal(node(dom, '[data-diff-results]').hidden, true);
		assert.match(status(dom), /over 20,000 characters/);
		assert.match(status(dom), /Press Compare/);
		assert.equal(node(dom, '[data-diff-copy]').disabled, true);

		dom.advance(TOOL_DIFF_CONFIG.recompareDelayMs + 1);
		assert.equal(drawn(dom).length, 0, 'and no timer fires afterwards');

		fire(node(dom, '[data-diff-compare]') as unknown as Parameters<typeof fire>[0], 'click');
		assert.equal(stat(dom, 'data-diff-removed'), '1', 'the visitor can still ask for it explicitly');
		assert.equal(stat(dom, 'data-diff-added'), '1');
	});
});

test('a refusal clears the panel, shows the reason, and says nothing was compared', async () => {
	await withTool((dom) => {
		paste(dom, 'a\nb', 'a\nX');
		assert.equal(drawn(dom).length, 3);

		const limit = TOOL_DIFF_CONFIG.maxInputCharacters;
		paste(dom, 'a'.repeat(limit + 1), 'b', false);
		fire(node(dom, '[data-diff-compare]') as unknown as Parameters<typeof fire>[0], 'click');
		assert.equal(node(dom, '[data-diff-error]').hidden, false);
		assert.match(errorOf(dom), /The left text is 250,001 characters/);
		assert.equal(status(dom), 'Nothing compared.');
		assert.equal(drawn(dom).length, 0);
		assert.equal(stat(dom, 'data-diff-added'), '0');
		assert.equal(node(dom, '[data-diff-results]').hidden, true);

		// Typing something sane again clears the error rather than leaving it up.
		paste(dom, 'a', 'b');
		assert.equal(node(dom, '[data-diff-error]').hidden, true);
		assert.equal(errorOf(dom), '');
	});
});

test('two empty boxes are nothing to compare yet', async () => {
	await withTool((dom) => {
		fire(node(dom, '[data-diff-compare]') as unknown as Parameters<typeof fire>[0], 'click');
		assert.equal(status(dom), 'Nothing to compare yet.');
		assert.equal(node(dom, '[data-diff-results]').hidden, true);
		assert.equal(node(dom, '[data-diff-copy]').disabled, true);
	});
});

test('one box filled is a diff of everything against nothing', async () => {
	await withTool((dom) => {
		paste(dom, 'a\nb', '');
		assert.equal(stat(dom, 'data-diff-removed'), '2');
		assert.equal(stat(dom, 'data-diff-added'), '0');
		assert.equal(node(dom, '[data-diff-results]').hidden, false);
	});
});

test('the view select re-renders without re-diffing, and says what it does', async () => {
	await withTool((dom) => {
		paste(dom, 'a\nb\nc', 'a\nX\nc');
		assert.equal(node(dom, '[data-text-diff]').dataset.view, 'unified');
		assert.deepEqual(drawnColumns(dom), ['both', 'both', 'both', 'both'], 'unified is one column');

		const select = node(dom, '[data-diff-view-mode]');
		select.value = 'split';
		fire(select as unknown as Parameters<typeof fire>[0], 'change');
		assert.equal(node(dom, '[data-text-diff]').dataset.view, 'split');
		assert.deepEqual(
			drawnColumns(dom),
			['both', 'left', 'right', 'both'],
			'a removed line takes column 1 and the line that replaced it column 2',
		);
		assert.match(node(dom, '[data-diff-view-hint]').textContent, /two columns/i);

		select.value = 'unified';
		fire(select as unknown as Parameters<typeof fire>[0], 'change');
		assert.match(node(dom, '[data-diff-view-hint]').textContent, /one column/i);
	});
});

test('the context slider moves the readout and the hidden-line items', async () => {
	await withTool((dom) => {
		const left = distinctLines('line ', 20).replace('line 10', 'LINE 10');
		paste(dom, left, distinctLines('line ', 20));
		assert.equal(node(dom, '[data-diff-context-value]').textContent, '3 lines');
		assert.deepEqual(skips(dom).length, 2);
		assert.match(skips(dom)[0] as string, /7 unchanged lines not shown/);

		const slider = node(dom, '[data-diff-context]');
		slider.value = '0';
		fire(slider as unknown as Parameters<typeof fire>[0], 'input');
		assert.equal(node(dom, '[data-diff-context-value]').textContent, '0 lines');
		assert.equal(drawn(dom).length, 4, 'the two changed rows and the two items standing for the rest');
		assert.match(skips(dom)[0] as string, /10 unchanged lines/);

		slider.value = '1';
		fire(slider as unknown as Parameters<typeof fire>[0], 'input');
		assert.equal(node(dom, '[data-diff-context-value]').textContent, '1 line');
	});
});

test('the word checkbox switches the inline detail on and off', async () => {
	await withTool((dom) => {
		paste(dom, 'the quick brown fox', 'the slow brown fox');
		const removed = nodes(dom, '[data-diff-view] .tool__diff-piece--del').map((piece) => piece.textContent);
		assert.deepEqual(removed, ['quick'], 'on by default, and only the word that moved');
		assert.deepEqual(
			nodes(dom, '[data-diff-view] .tool__diff-piece--add').map((piece) => piece.textContent),
			['slow'],
		);

		const box = node(dom, '[data-diff-inline-words]');
		box.checked = false;
		fire(box as unknown as Parameters<typeof fire>[0], 'change');
		assert.equal(nodes(dom, '[data-diff-view] .tool__diff-piece').length, 0);
		assert.equal(drawn(dom).length, 2, 'the two lines are still there, whole');

		box.checked = true;
		fire(box as unknown as Parameters<typeof fire>[0], 'change');
		assert.equal(nodes(dom, '[data-diff-view] .tool__diff-piece--del').length, 1);
	});
});

test('ignoring whitespace changes the comparison, not just the drawing', async () => {
	await withTool((dom) => {
		paste(dom, 'a  b\nc', 'a b\nc');
		assert.equal(stat(dom, 'data-diff-removed'), '1');
		assert.equal(stat(dom, 'data-diff-added'), '1');

		const box = node(dom, '[data-diff-ignore-space]');
		box.checked = true;
		fire(box as unknown as Parameters<typeof fire>[0], 'change');
		assert.equal(stat(dom, 'data-diff-removed'), '0');
		assert.equal(stat(dom, 'data-diff-unchanged'), '2');
		assert.equal(nodes(dom, '[data-diff-view] .tool__diff-row--same').length, 2);
		// The row still shows what was typed on the left, not a folded version of it.
		assert.match(drawnText(dom)[0] as string, /a {2}b/);
		// And it says out loud that the match is the tool's doing, not the text's.
		assert.deepEqual(drawn(dom).map((row) => row.dataset.ws), ['true', undefined]);
		assert.deepEqual(
			nodes(dom, '[data-diff-view] .tool__diff-sign').map((sign) => sign.textContent),
			['~', ''],
		);
	});
});

test('a line too long for the word budget is drawn whole', async () => {
	await withTool((dom) => {
		const long = distinctLines('w', 400).replace(/\n/g, ' ');
		paste(dom, long, `${long} extra`);
		assert.equal(nodes(dom, '[data-diff-view] .tool__diff-piece').length, 0);
		assert.equal(drawn(dom).length, 2);
		assert.equal(stat(dom, 'data-diff-removed'), '1');
		assert.equal(stat(dom, 'data-diff-added'), '1');
	});
});

test('a pasted tag is text, never markup', async () => {
	await withTool((dom) => {
		paste(dom, '<img src=x onerror=alert(1)>', '<script>alert(2)</script>');
		assert.equal(drawn(dom).length, 2);
		assert.match(drawnText(dom)[0] as string, /<img src=x onerror=alert\(1\)>/);
		assert.equal(nodes(dom, '[data-diff-view] img').length, 0, 'no element was built out of the text');
		assert.equal(nodes(dom, '[data-diff-view] script').length, 0);
	});
});

test('the sign is text, so colour is never the only signal', async () => {
	await withTool((dom) => {
		paste(dom, 'a\nb\nc', 'a\nX\nc');
		assert.deepEqual(
			nodes(dom, '[data-diff-view] .tool__diff-sign').map((sign) => sign.textContent),
			['', '-', '+', ''],
			'unchanged rows carry no sign',
		);
		assert.match(drawnText(dom)[1] as string, /-b/, 'a removed line says so in characters');
		assert.match(drawnText(dom)[2] as string, /\+X/);
	});
});

test('the row cap keeps the DOM bounded and says what it withheld', async () => {
	await withTool((dom) => {
		paste(dom, distinctLines('L', 900), distinctLines('R', 900), false);
		fire(node(dom, '[data-diff-compare]') as unknown as Parameters<typeof fire>[0], 'click');
		assert.equal(drawn(dom).length, TOOL_DIFF_CONFIG.maxRenderedRows);
		assert.match(status(dom), /Showing the first 1,500 rows of the table; 300 more are not on screen/);
		assert.match(status(dom), /the copied patch has every line/);
	});
});

test('loading a file fills its own side, names it, and compares', async () => {
	await withTool(async (dom) => {
		const input = node(dom, '[data-diff-right-source]');
		input.files = [textFile('notes.md', 'a\nX\nc', 'text/markdown')];
		fire(input as unknown as Parameters<typeof fire>[0], 'change');
		await dom.settle();

		assert.equal(node(dom, '[data-diff-right]').value, 'a\nX\nc');
		assert.equal(node(dom, '[data-diff-left]').value, '', 'the other side is untouched');
		assert.equal(node(dom, '[data-diff-right-meta]').textContent, 'notes.md · text/markdown · 5 B');
		assert.equal(node(dom, '[data-diff-left-meta]').textContent, '');
		assert.equal(stat(dom, 'data-diff-added'), '3');
		assert.equal(status(dom), 'Loaded notes.md into the right side — 5 B, 3 lines.');

		// The file's name becomes the patch's label, which is the point of asking.
		const written: string[] = [];
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
		Object.defineProperty(globalThis, 'navigator', {
			value: {
				clipboard: {
					writeText: async (value: string) => {
						written.push(value);
					},
				},
			},
			configurable: true,
		});
		fire(node(dom, '[data-diff-compare]') as unknown as Parameters<typeof fire>[0], 'click');
		fire(node(dom, '[data-diff-copy]') as unknown as Parameters<typeof fire>[0], 'click');
		await dom.settle();
		if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);

		assert.equal(written.length, 1);
		assert.match(written[0] as string, /^\+\+\+ notes\.md$/m);
		assert.match(written[0] as string, /^--- left$/m, 'the empty side keeps the plain label');
		assert.match(status(dom), /^Patch copied — 0 removed, 3 added, 1 hunk\.$/);
	});
});

test('a file that is not text is refused before it is read', async () => {
	await withTool(async (dom) => {
		const input = node(dom, '[data-diff-left-source]');
		input.files = [{ name: 'book.pdf', type: 'application/pdf', size: 1024, text: async () => 'never read' }];
		fire(input as unknown as Parameters<typeof fire>[0], 'change');
		await dom.settle();
		assert.equal(node(dom, '[data-diff-left]').value, '');
		assert.match(errorOf(dom), /not a text file this tool reads/);
		assert.equal(node(dom, '[data-diff-left-meta]').textContent, '');
	});
});

test('a file that cannot be decoded is a failure, not a silence', async () => {
	await withTool(async (dom) => {
		const input = node(dom, '[data-diff-left-source]');
		input.files = [
			{
				name: 'broken.txt',
				type: 'text/plain',
				size: 10,
				text: async () => {
					throw new Error('nope');
				},
			},
		];
		fire(input as unknown as Parameters<typeof fire>[0], 'change');
		await dom.settle();
		assert.match(errorOf(dom), /Could not read “broken\.txt”/);
		assert.equal(node(dom, '[data-diff-left]').value, '');
	});
});

test('a file that is not UTF-8 is loaded and called mojibake', async () => {
	await withTool(async (dom) => {
		const input = node(dom, '[data-diff-right-source]');
		input.files = [textFile('utf16.txt', 'a\uFFFDb')];
		fire(input as unknown as Parameters<typeof fire>[0], 'change');
		await dom.settle();
		assert.match(status(dom), /may be mojibake/);
	});
});

test('two files dropped at once: the last one owns the pane', async () => {
	await withTool(async (dom) => {
		const slow = deferredFile('slow.txt', 'slow text');
		const zone = node(dom, '[data-diff-left-drop]');
		fire(zone as unknown as Parameters<typeof fire>[0], 'drop', { dataTransfer: { files: [slow.file] } });
		assert.equal(node(dom, '[data-diff-compare]').disabled, true, 'reading disables the buttons');
		assert.equal(status(dom), 'Reading slow.txt…');

		fire(zone as unknown as Parameters<typeof fire>[0], 'drop', {
			dataTransfer: { files: [textFile('fast.txt', 'fast text')] },
		});
		await dom.settle();
		assert.equal(node(dom, '[data-diff-left]').value, 'fast text');
		assert.match(status(dom), /Loaded fast\.txt/);

		// The first read lands after it was superseded, and must write nothing.
		slow.release('slow text');
		await dom.settle();
		assert.equal(node(dom, '[data-diff-left]').value, 'fast text', 'the loser did not overwrite the winner');
		assert.match(status(dom), /Loaded fast\.txt/);
		assert.match(node(dom, '[data-diff-left-meta]').textContent, /fast\.txt/);
		assert.equal(node(dom, '[data-diff-compare]').disabled, false);
	});
});

test('a drop is not a navigation, and the zone says when a file is over it', async () => {
	await withTool((dom) => {
		const zone = node(dom, '[data-diff-right-drop]');
		let prevented = 0;
		fire(zone as unknown as Parameters<typeof fire>[0], 'dragover', {
			preventDefault: () => {
				prevented += 1;
			},
		});
		assert.equal(prevented, 1, 'without this the browser opens the file instead of handing it over');
		assert.equal(zone.dataset.dragOver, 'true');
		fire(zone as unknown as Parameters<typeof fire>[0], 'dragleave');
		assert.equal(zone.dataset.dragOver, 'false');
	});
});

test('reset empties both sides, the controls and the panel', async () => {
	await withTool(async (dom) => {
		paste(dom, 'a\nb', 'a\nX');
		const input = node(dom, '[data-diff-left-source]');
		input.files = [textFile('left.txt', 'a\nb')];
		fire(input as unknown as Parameters<typeof fire>[0], 'change');
		await dom.settle();
		assert.match(node(dom, '[data-diff-left-meta]').textContent, /left\.txt/);

		const select = node(dom, '[data-diff-view-mode]');
		select.value = 'split';
		fire(select as unknown as Parameters<typeof fire>[0], 'change');
		const slider = node(dom, '[data-diff-context]');
		slider.value = '9';
		fire(slider as unknown as Parameters<typeof fire>[0], 'input');

		fire(node(dom, '[data-diff-reset]') as unknown as Parameters<typeof fire>[0], 'click');
		assert.equal(node(dom, '[data-diff-left]').value, '');
		assert.equal(node(dom, '[data-diff-right]').value, '');
		assert.equal(node(dom, '[data-diff-left-meta]').textContent, '');
		assert.equal(node(dom, '[data-diff-right-meta]').textContent, '');
		assert.equal(input.value, '', 'the picker is cleared, or the same file cannot be chosen twice');
		assert.equal(drawn(dom).length, 0);
		assert.equal(node(dom, '[data-diff-results]').hidden, true);
		assert.equal(stat(dom, 'data-diff-added'), '0');
		assert.equal(select.value, 'unified');
		assert.equal(slider.value, String(TOOL_DIFF_CONFIG.context.default));
		assert.equal(node(dom, '[data-diff-context-value]').textContent, '3 lines');
		assert.equal(node(dom, '[data-diff-inline-words]').checked, true);
		assert.equal(node(dom, '[data-diff-ignore-space]').checked, false);
		assert.equal(status(dom), 'Paste two texts, or drop two files. Nothing leaves this tab.');
	});
});

test('leaving the page clears both sides, the way reset does', async () => {
	await withTool((dom) => {
		paste(dom, 'a draft', 'a revision');
		assert.equal(drawn(dom).length, 2);
		dom.document.__fireWindowEvent('pagehide');
		assert.equal(node(dom, '[data-diff-left]').value, '');
		assert.equal(node(dom, '[data-diff-right]').value, '');
		assert.equal(node(dom, '[data-diff-results]').hidden, true);
	});
});

test('destroy releases every listener, including a pending debounce', async () => {
	await withTool(async (dom) => {
		const { destroyTextDiff, initTextDiff } = await import('../src/scripts/tools-diff.ts');
		const listeners = dom.listenerCount();
		assert.ok(listeners > 0, 'the tool bound listeners');
		const timers = dom.clock.pending();

		paste(dom, 'a', 'b', false);
		assert.ok(dom.clock.pending() > timers, 'a comparison is scheduled');

		destroyTextDiff();
		dom.advance(TOOL_DIFF_CONFIG.recompareDelayMs + 10);
		assert.equal(drawn(dom).length, 0, 'the scheduled comparison did not run');
		assert.equal(dom.clock.pending(), timers, 'and it left no timer behind');
		assert.ok(dom.listenerCount() < listeners, 'the listeners went with it');

		const box = node(dom, '[data-diff-left]');
		box.value = 'still nothing';
		fire(box as unknown as Parameters<typeof fire>[0], 'input');
		dom.advance(TOOL_DIFF_CONFIG.recompareDelayMs + 1);
		assert.equal(drawn(dom).length, 0, 'the boxes are dead after teardown');

		// A second init binds a fresh subtree, which is what re-running boot() does.
		initTextDiff();
		paste(dom, 'a', 'b');
		assert.equal(drawn(dom).length, 2);
		destroyTextDiff();
	});
});

test('copy is dead until there is a comparison, and honest about the clipboard', async () => {
	const written: string[] = [];
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
	const setNavigator = (value: unknown) => {
		Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
	};
	try {
		setNavigator({
			clipboard: {
				writeText: async (value: string) => {
					written.push(value);
				},
			},
		});
		await withTool(async (dom) => {
			assert.equal(node(dom, '[data-diff-copy]').disabled, true);
			fire(node(dom, '[data-diff-copy]') as unknown as Parameters<typeof fire>[0], 'click');
			await dom.settle();
			assert.equal(written.length, 0);
			assert.equal(status(dom), 'Paste two texts, or drop two files. Nothing leaves this tab.');

			paste(dom, 'a\nb\nc', 'a\nX\nc');
			assert.equal(node(dom, '[data-diff-copy]').disabled, false);
			fire(node(dom, '[data-diff-copy]') as unknown as Parameters<typeof fire>[0], 'click');
			await dom.settle();
			assert.equal(written.length, 1);
			assert.equal(
				written[0],
				['--- left', '+++ right', '@@ -1,3 +1,3 @@', ' a', '-b', '+X', ' c'].join('\n'),
			);
			assert.equal(status(dom), 'Patch copied — 1 removed, 1 added, 1 hunk.');
		});

		// A refused write is a failure said plainly, never a success.
		setNavigator({
			clipboard: {
				writeText: async () => {
					throw new Error('denied');
				},
			},
		});
		await withTool(async (dom) => {
			paste(dom, 'a', 'b');
			fire(node(dom, '[data-diff-copy]') as unknown as Parameters<typeof fire>[0], 'click');
			await dom.settle();
			assert.match(status(dom), /clipboard refused the copy/);
			assert.doesNotMatch(status(dom), /^Patch copied/);
		});

		// And no clipboard API is not a refused copy either: it is no copy.
		setNavigator({});
		await withTool(async (dom) => {
			paste(dom, 'a', 'b');
			fire(node(dom, '[data-diff-copy]') as unknown as Parameters<typeof fire>[0], 'click');
			await dom.settle();
			assert.match(status(dom), /no clipboard API/);
		});
	} finally {
		if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
	}
});
