/**
 * BNJI.NET — /tools/ markup matches its controllers.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * A controller binds by `[data-*]` attribute, and the component renders those
 * attributes — but nothing in the type system connects the two. The first
 * version of these tools shipped its action buttons through the GlassButton
 * component, which forwards only the props it declares: the buttons rendered
 * perfectly and carried no data attribute at all, so every action was dead in
 * the built page while every other check passed. tsc cannot see it, the DOM
 * shim tests build their own markup, and the build succeeds silently.
 *
 * So the two halves are compared here, from source, on every test run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Controller -> the component whose markup it binds. */
const PAIRS = [
	['src/scripts/tools-image.ts', 'src/components/tools/ImageConverter.astro'],
	['src/scripts/tools-words.ts', 'src/components/tools/WordCounter.astro'],
	['src/scripts/tools-diff.ts', 'src/components/tools/TextDiff.astro'],
	['src/scripts/tools-color.ts', 'src/components/tools/ColorPicker.astro'],
	['src/scripts/tools-metadata.ts', 'src/components/tools/ImageMetadata.astro'],
	['src/scripts/tools-units.ts', 'src/components/tools/UnitConverter.astro'],
	['src/scripts/tools-percentage.ts', 'src/components/tools/PercentageCalculator.astro'],
	['src/scripts/tools-date-difference.ts', 'src/components/tools/DateDifferenceCalculator.astro'],
	['src/scripts/tools-cooking.ts', 'src/components/tools/CookingConverter.astro'],
	['src/scripts/tools-screen-dpi.ts', 'src/components/tools/ScreenDpiCalculator.astro'],
	['src/scripts/tools-timezone.ts', 'src/components/tools/TimeZoneConverter.astro'],
	['src/scripts/tools-random.ts', 'src/components/tools/RandomPicker.astro'],
	['src/scripts/tools-list.ts', 'src/components/tools/ListRandomizer.astro'],
	['src/scripts/tools-countdown.ts', 'src/components/tools/CountdownStopwatch.astro'],
] as const;

/**
 * Every attribute selector a controller looks up. Matches
 * `querySelector('[data-x]')`, `querySelector<HTMLElement>('[data-x]')` and
 * the querySelectorAll form alike.
 */
function selectorsIn(source: string): string[] {
	const pattern = /querySelector(?:All)?(?:<[^>]*>)?\(\s*'\[([\w-]+)\]'/g;
	const found = new Set<string>();
	for (const match of source.matchAll(pattern)) found.add(match[1]);
	return [...found].sort();
}

test('every selector a tools controller queries exists in its component', () => {
	for (const [script, component] of PAIRS) {
		const markup = readFileSync(new URL(`../${component}`, import.meta.url), 'utf8');
		const selectors = selectorsIn(readFileSync(new URL(`../${script}`, import.meta.url), 'utf8'));
		assert.ok(selectors.length > 0, `${script} queries nothing`);

		for (const selector of selectors) {
			// The attribute must appear as a real attribute, not inside a
			// comment or a string: it is followed by `>` or `=` or whitespace.
			const present = new RegExp(`\\s${selector}(=|\\s|>)`).test(markup);
			assert.ok(present, `${component} is missing ${selector}, which ${script} binds`);
		}
	}
});

test('no tools action button is routed through GlassButton', () => {
	// GlassButton drops undeclared props, so a data hook given to one of them
	// disappears. This is the regression guard for that, in the one place the
	// failure is visible.
	for (const [, component] of PAIRS) {
		const markup = readFileSync(new URL(`../${component}`, import.meta.url), 'utf8');
		const actions = /<div class="tool__actions">([\s\S]*?)<\/div>/.exec(markup);
		assert.ok(actions, `${component} has no tool__actions block`);
		assert.doesNotMatch(actions[1], /<GlassButton/, `${component} must not route actions through GlassButton`);
		assert.match(actions[1], /<button[^>]*class="glass-button/, 'actions must use the glass-button classes');
	}
});
