/**
 * /tools/ color picker: the REAL markup from ColorPicker.astro driven by the REAL
 * controller in a REAL DOM.
 *
 * WHY THIS FILE EXISTS BESIDE tests/tools-color.test.ts
 * -----------------------------------------------------
 * That file covers the decisions (how a colour is converted, what the wheel maps
 * a pointer to, what is refused and in which words) and drives the controller
 * against the small DOM shim. Three things a shim cannot show, because a shim's
 * `style` stores raw strings and its canvas is a recorder:
 *
 *   1. that the component's markup — as Astro actually renders it, expressions and
 *      all — carries the hooks, labels and ARIA targets the controller and a screen
 *      reader depend on. The shim builds its own fixture, so it can only prove the
 *      controller agrees with a copy of the markup, not with the markup;
 *   2. that colours really land in the page as CSS. `swatch.style.backgroundColor`
 *      here is parsed and serialised by a CSS engine, so `rgb(224, 122, 63)` on the
 *      screen is the browser's own reading of what the controller wrote;
 *   3. what the tool does when the browser cannot give it what it assumes. jsdom
 *      ships no canvas and no `createImageBitmap`, so this file is the honest
 *      test of the no-canvas path: the wheel hides itself and says why, the image
 *      half refuses without pretending, and everything else keeps working.
 *
 * tests/tools-markup.test.ts compares the two halves as text; this file loads them
 * into jsdom and runs them. The markup is extracted from the .astro source the way
 * the diff tool's DOM test does it, and every Astro expression is substituted from
 * the same config the component imports — so nothing here re-states a value that
 * could drift, and the "no expression survived" assertion fails loudly the day the
 * component grows one this file does not know about.
 *
 * ONE LIMITATION, STATED WHERE IT MATTERS: jsdom's CSSOM does not serialise named
 * colours (`seagreen` stays `"seagreen"`) and has no canvas `fillStyle` to fall back
 * on, so a colour name is refused here while a browser accepts it. The tests below
 * assert the refusal and say so, because the interesting behaviour is that the
 * refusal is honest rather than a wrong colour: nothing is set, nothing is guessed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM, VirtualConsole } from 'jsdom';

import {
	COLOR_FORMATS,
	COLOR_FORMAT_HINT,
	COLOR_FORMAT_LABEL,
	COLOR_SCHEMES,
	COLOR_SCHEME_HINT,
	COLOR_SCHEME_LABEL,
	IMAGE_FILE_CONFIG,
	IMAGE_INPUT_ACCEPT,
	IMAGE_INPUT_LABELS,
	TOOL_COLOR_CONFIG,
} from '../src/config/tools.config';
import { COPY_UNAVAILABLE } from '../src/scripts/tools-shared';
import {
	type Rgb,
	contrastRatio,
	describeColor,
	formatContrast,
	parseHexColor,
	rgbToHsv,
	schemeColors,
	destroyColorPicker,
	initColorPicker,
} from '../src/scripts/tools-color';

const { defaultColor, defaultBackground, maxPaletteEntries, wheel, sample, contrast } =
	TOOL_COLOR_CONFIG;
const { maxBytes: maxImageBytes, maxSourcePixels } = IMAGE_FILE_CONFIG;
const megabytes = (maxImageBytes / (1024 * 1024)).toLocaleString('en-US');

/** Every hook the controller queries, so the two files cannot drift apart. */
const HOOKS = [
	'picker',
	'wheel',
	'wheel-hint',
	'hue',
	'saturation',
	'value',
	'hue-value',
	'saturation-value',
	'value-value',
	'hex',
	'red',
	'green',
	'blue',
	'css',
	'swatch',
	'name',
	'scheme',
	'scheme-hint',
	'scheme-list',
	'palette-list',
	'palette-empty',
	'palette-count',
	'palette-add',
	'palette-copy',
	'palette-clear',
	'formats',
	'formats-copy',
	'contrast-bg',
	'contrast-ratio',
	'contrast-sentence',
	'contrast-verdicts',
	'contrast-sample',
	'contrast-swap',
	'image-drop',
	'image-input',
	'image-preview',
	'image-meta',
	'image-hint',
	'image-clear',
	'common-list',
	'copy',
	'reset',
	'status',
	'error',
] as const;

/** The component's markup, with every Astro expression filled from config. */
function colorMarkup(): string {
	const source = readFileSync(
		new URL('../src/components/tools/ColorPicker.astro', import.meta.url),
		'utf8',
	);
	const parts = source.split('---');
	assert.ok(parts.length >= 3, 'ColorPicker.astro lost its frontmatter delimiters');
	let markup = parts[2]!;
	assert.ok(!markup.includes('<style>'), 'the tool is styled by styles/tools.css, not inline');

	// JSX comments are not markup.
	markup = markup.replace(/{\/\*[\s\S]*?\*\/}/g, '');
	/*
	 * One expression produces an attribute rather than text: the large-text sample
	 * is sized from the same config number the WCAG large-text threshold uses, so
	 * the sample is large by definition rather than by guess. Substituted before
	 * the text pass, because its braces are not text braces.
	 */
	markup = markup.replace(
		'style={`font-size: ${contrast.largeTextPx}px`}',
		`style="font-size: ${contrast.largeTextPx}px"`,
	);
	// And one that produces elements rather than text.
	markup = markup.replace(
		'{COLOR_SCHEMES.map((name) => <option value={name}>{COLOR_SCHEME_LABEL[name]}</option>)}',
		COLOR_SCHEMES.map((name) => `<option value="${name}">${COLOR_SCHEME_LABEL[name]}</option>`).join(''),
	);
	const text: Record<string, string> = {
		'{defaultColor}': defaultColor,
		'{defaultBackground}': defaultBackground,
		'{COLOR_FORMAT_HINT.hex}': COLOR_FORMAT_HINT.hex,
		'{COLOR_FORMAT_HINT.rgb}': COLOR_FORMAT_HINT.rgb,
		'{IMAGE_INPUT_ACCEPT}': IMAGE_INPUT_ACCEPT,
		'{IMAGE_INPUT_LABELS}': IMAGE_INPUT_LABELS,
		'{contrast.largeTextPx}': String(contrast.largeTextPx),
		'{maxPaletteEntries}': String(maxPaletteEntries),
		'{megabytes}': megabytes,
		'{sample.scanMaxEdge}': String(sample.scanMaxEdge),
		'{wheel.maxBacking}': String(wheel.maxBacking),
		"{' '}": ' ',
		"{maxSourcePixels.toLocaleString('en-US')}": maxSourcePixels.toLocaleString('en-US'),
	};
	for (const [expression, value] of Object.entries(text)) markup = markup.replaceAll(expression, value);

	/*
	 * The guard that keeps this fixture honest: a leftover expression would be
	 * handed to jsdom as literal text, the hook it belonged to would be missing,
	 * and every assertion below would still pass against a page nobody ships.
	 */
	assert.doesNotMatch(markup, /{[^}]*}/, 'an Astro expression survived into the jsdom fixture');
	return markup;
}

function colorDom(): JSDOM {
	const virtualConsole = new VirtualConsole();
	/*
	 * jsdom has no canvas and announces that as an error every time the controller
	 * asks one for a 2D context. That is the exact condition this file exists to
	 * test, so it is swallowed here — and only here: any other jsdom error is a
	 * real failure and still lands on stderr.
	 */
	virtualConsole.on('jsdomError', (error: Error) => {
		if (!/getContext|Not implemented: HTMLCanvasElement/.test(error.message)) {
			console.error(error);
		}
	});
	const dom = new JSDOM(`<!doctype html><html><body>${colorMarkup()}</body></html>`, {
		url: 'http://localhost:4321/tools/',
		virtualConsole,
	});
	const g = globalThis as Record<string, unknown>;
	g.window = dom.window;
	g.document = dom.window.document;
	g.location = dom.window.location;
	// Node 22 defines `navigator` with a getter only, so it has to be replaced
	// rather than assigned — and the controller reads it for the clipboard.
	Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
	/*
	 * One realm, as in a browser. jsdom's addEventListener rejects an AbortSignal
	 * from Node's realm, and the controller tears its listeners down with exactly
	 * that — so without this the init throws before it binds anything.
	 */
	g.AbortController = dom.window.AbortController;
	return dom;
}

/** Init the real controller and guarantee it is torn down before the window closes. */
function mount(t: { after(fn: () => void): void }, dom: JSDOM): void {
	initColorPicker();
	t.after(() => {
		destroyColorPicker();
		dom.window.close();
	});
}

const q = (dom: JSDOM, selector: string): HTMLElement => {
	const node = dom.window.document.querySelector(selector);
	assert.ok(node, `ColorPicker.astro is missing ${selector}`);
	return node as unknown as HTMLElement;
};
const qs = (dom: JSDOM, selector: string): HTMLElement[] =>
	Array.from(dom.window.document.querySelectorAll(selector)) as unknown as HTMLElement[];
const text = (dom: JSDOM, selector: string): string => (q(dom, selector).textContent ?? '').trim();
const input = <T>(dom: JSDOM, selector: string): T => q(dom, selector) as unknown as T;
const value = (dom: JSDOM, selector: string): string =>
	(q(dom, selector) as unknown as HTMLInputElement).value;
/** What a CSS engine serialises a six-digit hex to, so the assertions compare CSS. */
const rgbCss = (hex: string): string => {
	const clean = hex.replace('#', '');
	const channel = (at: number): number => Number.parseInt(clean.slice(at, at + 2), 16);
	return `rgb(${channel(0)}, ${channel(2)}, ${channel(4)})`;
};
/** Write a field the way a visitor does, then let the browser fire what it fires. */
const type = (dom: JSDOM, selector: string, next: string, event = 'input'): void => {
	const node = input<HTMLInputElement>(dom, selector);
	node.value = next;
	node.dispatchEvent(new dom.window.Event(event, { bubbles: true }));
};
const click = (dom: JSDOM, selector: string): void => {
	q(dom, selector).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
};
const tick = (ms = 8): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The colour maths takes an Rgb, never a hex string, so every hex this file
 * compares against goes through the tool's own parser — a typo in a hex here
 * fails loudly instead of quietly becoming NaN in an assertion.
 */
const rgb = (hex: string): Rgb => {
	const parsed = parseHexColor(hex);
	assert.ok(parsed, `${hex} should parse`);
	return parsed.rgb;
};

/** A format row's value, by format: the rows are built by the controller. */
const formatValue = (dom: JSDOM, format: string): string =>
	(qs(dom, `.tool__color-format[data-format="${format}"] .tool__color-format-value`)[0]?.textContent ??
		'').trim();

test('the rendered markup carries every hook the controller queries, exactly once each', (t) => {
	const dom = colorDom();
	mount(t, dom);
	for (const hook of HOOKS) {
		const name = `data-color-${hook}`;
		assert.equal(
			qs(dom, `[${name}]`).length,
			1,
			`${name} must appear exactly once: missing means the controller silently loses a surface, twice means it writes to the wrong one`,
		);
	}
});

test('the markup is styled by classes, not by a value the CSS cannot see', (t) => {
	const dom = colorDom();
	mount(t, dom);
	const body = dom.window.document.body.innerHTML;
	assert.doesNotMatch(body, /{[^}]*}/, 'an Astro expression reached the page as text');
	assert.doesNotMatch(body, /toLocaleString/, 'an expression name reached the page as text');
	assert.ok(q(dom, '[data-color-picker]').className.includes('tool'), 'the tool is on the tools stylesheet');
});

test('every control has a name a screen reader can read, and the drop zone is a labelled input', (t) => {
	const dom = colorDom();
	mount(t, dom);
	const document = dom.window.document;

	const nameOf = (node: Element): string => {
		const labelledby = node.getAttribute('aria-labelledby');
		if (labelledby) {
			return labelledby
				.split(/\s+/)
				.map((id) => (document.getElementById(id)?.textContent ?? '').trim())
				.join(' ');
		}
		const label = node.getAttribute('aria-label');
		if (label) return label;
		const id = node.getAttribute('id');
		if (id) {
			const byFor = document.querySelector(`label[for="${id}"]`);
			if (byFor) return (byFor.textContent ?? '').trim();
		}
		const wrapping = node.closest('label');
		if (wrapping) return (wrapping.textContent ?? '').trim();
		return (node.textContent ?? '').trim();
	};

	const controls = qs(dom, 'input, select, button, textarea');
	assert.ok(controls.length >= 20, `the tool has controls, found ${controls.length}`);
	for (const control of controls) {
		// The file input's name is the sr-only span inside its label: a visible
		// "Choose / drop an image" prompt is not a substitute for a real name.
		assert.ok(
			nameOf(control).length > 0,
			`${control.tagName.toLowerCase()}[data-color-${
				Array.from(control.attributes)
					.find((attribute) => attribute.name.startsWith('data-color'))
					?.name.slice('data-color-'.length) ?? '?'
			}] has no accessible name`,
		);
	}

	const drop = q(dom, '[data-color-image-drop]');
	assert.equal(drop.tagName, 'LABEL', 'the drop target is the label, so a click opens the picker natively');
	assert.equal(drop.querySelector('.sr-only')?.textContent?.trim(), 'Choose an image to take colors from');
	const file = input<HTMLInputElement>(dom, '[data-color-image-input]');
	assert.equal(file.type, 'file');
	assert.equal(file.getAttribute('accept'), IMAGE_INPUT_ACCEPT, 'the accept list comes from config');
	assert.ok(drop.querySelector('input[type="file"]'), 'and the input is inside the drop target');
});

test('each labelled section has exactly one heading, and each group one sub-heading', (t) => {
	const dom = colorDom();
	mount(t, dom);
	const document = dom.window.document;

	assert.equal(document.querySelectorAll('h1').length, 0, 'the page owns the h1, not the tool');
	const sections = qs(dom, 'section[aria-labelledby]');
	assert.equal(sections.length, 1, 'the color picker is one section of the tools page');
	for (const section of sections) {
		const label = section.getAttribute('aria-labelledby') as string;
		const heading = document.getElementById(label);
		assert.ok(heading, `${label} points at nothing`);
		/*
		 * An h3, not an h2: the page owns the h1 and the category the tool sits in
		 * owns the h2. What must hold is that the section has exactly one heading
		 * naming it.
		 */
		assert.equal(heading?.tagName, 'H3', 'the section is introduced by its tool heading');
		assert.equal(
			section.querySelectorAll(':scope > * h3.tool__title, :scope > h3.tool__title').length,
			1,
			'one tool heading in the section, so the landmark has one name',
		);
	}

	const groups = qs(dom, '[role="group"][aria-labelledby]');
	assert.ok(groups.length >= 4, `the tool groups its swatch lists, found ${groups.length}`);
	for (const group of groups) {
		const label = group.getAttribute('aria-labelledby') as string;
		const heading = document.getElementById(label);
		assert.ok(heading?.textContent?.trim().length, `${label} names the group`);
		assert.match(
			heading?.tagName ?? '',
			/^H4$|^P$/,
			'the group is named by a sub-heading or a sub-label, both of which are real text',
		);
	}
});

test('the two canvases are decoration: aria-hidden, unfocusable, and covered by sliders', (t) => {
	const dom = colorDom();
	mount(t, dom);
	const canvases = qs(dom, 'canvas');
	assert.equal(canvases.length, 2, 'a wheel and an image preview');
	for (const canvas of canvases) {
		assert.equal(canvas.getAttribute('aria-hidden'), 'true', 'a picture of a colour space is not readable');
		assert.equal(canvas.getAttribute('tabindex'), null, 'and it is not in the tab order');
		assert.equal(canvas.getAttribute('role'), null, 'it does not claim to be an image or a slider');
	}

	/*
	 * The trade that makes the above acceptable: every value the pointer can reach
	 * on the wheel, a labelled slider reaches too. Asserted here rather than in the
	 * markup test because it is a claim about the rendered page, not about a string.
	 */
	for (const slider of ['hue', 'saturation', 'value']) {
		const node = input<HTMLInputElement>(dom, `[data-color-${slider}]`);
		assert.equal(node.type, 'range', `${slider} is a slider`);
		assert.ok(node.getAttribute('aria-describedby'), `${slider} points at a hint`);
		assert.ok(
			node.getAttribute('max') !== null && node.getAttribute('min') !== null,
			`${slider} announces its range`,
		);
	}
});

test('the verdict badges say pass or fail in words, so colour is never the only signal', (t) => {
	const dom = colorDom();
	mount(t, dom);
	const badges = qs(dom, '.tool__color-badge[data-verdict]');
	assert.equal(badges.length, 4, 'AA and AAA, at normal and large text');
	for (const badge of badges) {
		const verdict = badge.getAttribute('data-verdict') as string;
		const pass = badge.getAttribute('data-pass') as string;
		const words = (badge.textContent ?? '').trim();
		assert.ok(
			['aaNormal', 'aaLarge', 'aaaNormal', 'aaaLarge'].includes(verdict),
			`${verdict} is one of the four WCAG verdicts`,
		);
		assert.match(
			words,
			pass === 'true' ? /— pass at / : /— fail at /,
			'the badge reads as a sentence, not only as a background colour',
		);
		assert.match(words, /:1$/, 'and it quotes the threshold it was measured against');
	}
	assert.equal(
		text(dom, '[data-color-contrast-sentence]'),
		'2.99:1 — below every WCAG threshold, for any text size.',
		'the opening pair clears nothing, and the tool says so before the visitor has touched it',
	);
	assert.equal(
		text(dom, '[data-color-contrast-ratio]'),
		formatContrast(contrastRatio(rgb(defaultColor), rgb(defaultBackground))),
		'the ratio is computed, not written into the markup',
	);
});

test('first paint: the tool opens on the config color, in real CSS, in every format', (t) => {
	const dom = colorDom();
	mount(t, dom);
	const hsv = rgbToHsv(rgb(defaultColor));

	assert.equal(value(dom, '[data-color-hex]'), defaultColor);
	/*
	 * jsdom's CSSOM parses the shorthand and re-serialises it, so this compares
	 * the CSS a browser would actually apply — the one thing a shim that stores
	 * raw strings can never show.
	 */
	assert.equal(q(dom, '[data-color-swatch]').style.backgroundColor, rgbCss(defaultColor));
	assert.equal(text(dom, '[data-color-name]'), describeColor(hsv));

	const rows = qs(dom, '.tool__color-format[data-format]');
	assert.equal(rows.length, COLOR_FORMATS.length, 'one row per format in config');
	assert.deepEqual(
		rows.map((row) => row.getAttribute('data-format')),
		[...COLOR_FORMATS],
		'in the order config lists them',
	);
	assert.deepEqual(
		rows.map((row) => (row.querySelector('.tool__color-format-label')?.textContent ?? '').trim()),
		COLOR_FORMATS.map((format) => COLOR_FORMAT_LABEL[format]),
	);
	for (const row of rows) {
		assert.ok(
			(row.querySelector('.tool__color-format-value')?.textContent ?? '').trim().length > 0,
			'every row is filled on first paint: a visitor who turns JS on is never shown an empty list',
		);
		assert.ok(row.querySelector('button[data-format]'), 'and every row carries its own Copy button');
	}
	assert.equal(formatValue(dom, 'hex'), defaultColor, 'the hex row agrees with the hex field');
	assert.equal(formatValue(dom, 'rgb'), 'rgb(224 122 63)', 'in the modern space-separated CSS syntax');

	assert.equal(
		text(dom, '[data-color-hue-value]'),
		`${Math.round(hsv.h)}°`,
		'the read-outs beside the sliders announce what the sliders hold, in the units a person uses',
	);
	assert.equal(text(dom, '[data-color-saturation-value]'), `${Math.round(hsv.s * 100)}%`);
	assert.equal(text(dom, '[data-color-value-value]'), `${Math.round(hsv.v * 100)}%`);
	assert.deepEqual(
		['hue', 'saturation', 'value'].map((slider) => value(dom, `[data-color-${slider}]`)),
		[String(Math.round(hsv.h)), String(Math.round(hsv.s * 100)), String(Math.round(hsv.v * 100))],
		'and the sliders themselves are set to the colour, not left at zero',
	);

	assert.equal(
		q(dom, '[data-color-palette-list]').getAttribute('data-empty'),
		'true',
		'the palette starts empty and says so',
	);
	assert.equal(q(dom, '[data-color-palette-empty]').hidden, false);
	assert.equal(text(dom, '[data-color-palette-count]'), `0 of ${maxPaletteEntries}`);
	assert.match(
		text(dom, '[data-color-status]'),
		new RegExp(
			`^Pick a color: .* Starting on ${defaultColor}, ${describeColor(hsv)}\. Nothing leaves this tab\.$`,
		),
		'the status names the colour it started on, so the first line is not a guess',
	);
	assert.equal(q(dom, '[data-color-error]').hidden, true, 'and nothing is wrong yet');
});

test('no canvas: the wheel hides itself and says why, and the image half refuses honestly', (t) => {
	const dom = colorDom();
	mount(t, dom);
	// jsdom has no canvas package, so this is the real no-canvas browser.
	assert.equal(dom.window.document.createElement('canvas').getContext('2d'), null);

	const wheelCanvas = q(dom, '[data-color-wheel]');
	assert.equal(wheelCanvas.hidden, true, 'an empty square is worse than no square');
	assert.equal(wheelCanvas.getAttribute('aria-hidden'), 'true');
	assert.match(
		text(dom, '[data-color-wheel-hint]'),
		/^This browser has no canvas, so the wheel is not drawn\. The hue, saturation and brightness sliders below set exactly the same values\.$/,
		'and the hint says which way to go instead',
	);
	assert.equal(q(dom, '[data-color-wheel-hint]').hidden, false, 'the hint is visible, not tucked away');

	assert.match(
		text(dom, '[data-color-image-hint]'),
		/cannot draw an image into a canvas/,
		'the image half admits what it cannot do before the visitor tries it',
	);
	assert.equal(q(dom, '[data-color-image-preview]').hidden, true, 'the preview stays hidden');
});

test('no canvas: everything else still works, because the wheel was never the only way in', (t) => {
	const dom = colorDom();
	mount(t, dom);

	type(dom, '[data-color-hue]', '0');
	type(dom, '[data-color-saturation]', '100');
	type(dom, '[data-color-value]', '100');
	assert.equal(value(dom, '[data-color-hex]'), '#ff0000');
	assert.equal(q(dom, '[data-color-swatch]').style.backgroundColor, 'rgb(255, 0, 0)');
	assert.equal(text(dom, '[data-color-name]'), describeColor(rgbToHsv(rgb('#ff0000'))));
	assert.equal(text(dom, '[data-color-hue-value]'), '0°');
	assert.equal(text(dom, '[data-color-saturation-value]'), '100%');
	assert.equal(formatValue(dom, 'hex'), '#ff0000');
	assert.equal(formatValue(dom, 'hsl'), 'hsl(0.0 100.0% 50.0%)', 'the formats follow the sliders');
	assert.equal(
		text(dom, '[data-color-contrast-ratio]'),
		formatContrast(contrastRatio(rgb('#ff0000'), rgb(defaultBackground))),
		'and so does the contrast checker',
	);
	assert.equal(
		q(dom, '[data-color-status]').getAttribute('data-busy'),
		'false',
		'nothing is left spinning by a tool that could not draw',
	);
});

test('the CSS field is read by a CSS engine: hsl(), rgb() with either syntax, and a 3-digit hex', (t) => {
	const dom = colorDom();
	mount(t, dom);
	const css = '[data-color-css]';

	type(dom, css, 'hsl(120 50% 50%)', 'change');
	assert.equal(
		value(dom, '[data-color-hex]'),
		'#40bf40',
		'jsdom converts hsl() to rgb(), and the tool reads the conversion rather than re-implementing it',
	);
	assert.equal(q(dom, '[data-color-swatch]').style.backgroundColor, 'rgb(64, 191, 64)');
	assert.match(text(dom, '[data-color-status]'), /^Color set from the CSS color field: #40bf40, a green\./);
	assert.equal(
		value(dom, css),
		'hsl(120 50% 50%)',
		'the field being typed in is never rewritten mid-edit, whatever the tool made of it',
	);

	type(dom, css, 'rgb(1 2 3)', 'change');
	assert.equal(value(dom, '[data-color-hex]'), '#010203', 'the space syntax parses too');

	type(dom, css, '#abc', 'change');
	assert.equal(value(dom, '[data-color-hex]'), '#aabbcc', 'and a 3-digit hex is expanded, not refused');
});

test('the CSS field drops an alpha channel and says so, rather than pretending the colour is opaque', (t) => {
	const dom = colorDom();
	mount(t, dom);

	type(dom, '[data-color-css]', 'rgba(0, 0, 0, 0.5)', 'change');
	assert.equal(value(dom, '[data-color-hex]'), '#000000');
	assert.match(
		text(dom, '[data-color-status]'),
		/The alpha channel \(50%\) was dropped — this picker works in opaque sRGB\.$/,
		'the trade-off is stated in the same breath as the result',
	);
});

test('the CSS field refuses what this browser cannot read, and leaves the colour alone', (t) => {
	const dom = colorDom();
	mount(t, dom);
	const before = value(dom, '[data-color-hex]');

	/*
	 * In a browser, `style.color = 'seagreen'` comes back as `rgb(46, 139, 87)` and
	 * an oklch() comes back through the canvas fallback. jsdom has neither, so both
	 * are refused here. What is being tested is the shape of the refusal: the colour
	 * does not move, the reason is on screen, and the message names the syntaxes
	 * that do work — no silent fallback to black, no guess.
	 */
	for (const refused of ['seagreen', 'oklch(70% 0.1 200)', 'banana', '']) {
		type(dom, '[data-color-css]', refused, 'change');
		assert.equal(value(dom, '[data-color-hex]'), before, `“${refused}” changed nothing`);
		assert.equal(q(dom, '[data-color-swatch]').style.backgroundColor, rgbCss(before));
		if (refused.length === 0) {
			// An empty field is not a colour and not a mistake: nothing to report.
			continue;
		}
		assert.equal(q(dom, '[data-color-error]').hidden, false);
		assert.match(
			text(dom, '[data-color-error]'),
			new RegExp(`^“${refused.replace(/[()]/g, '\\$&')}” is not a color this browser can read\\. Try a hex, rgb\\(\\), hsl\\(\\), oklch\\(\\), or a CSS color name\\.$`),
		);
	}

	// A colour this CSSOM can read clears the refusal.
	type(dom, '[data-color-css]', 'rgb(10, 20, 30)', 'change');
	assert.equal(value(dom, '[data-color-hex]'), '#0a141e');
	assert.equal(q(dom, '[data-color-error]').hidden, true, 'the error goes away on its own, once it is wrong');
});

test('the hex field parses what it says it parses and refuses the rest, in a real DOM', (t) => {
	const dom = colorDom();
	mount(t, dom);

	type(dom, '[data-color-hex]', 'ff8800');
	assert.equal(value(dom, '[data-color-hex]'), 'ff8800', 'the visitor’s own text is left alone…');
	assert.equal(
		q(dom, '[data-color-swatch]').style.backgroundColor,
		'rgb(255, 136, 0)',
		'…and the colour follows it, with no leading # demanded',
	);

	type(dom, '[data-color-hex]', '#12345678');
	assert.match(
		text(dom, '[data-color-status]'),
		/The alpha channel \(47%\) was dropped — this picker works in opaque sRGB\.$/,
		'eight digits are accepted and the dropped alpha is reported as a percentage',
	);
	assert.equal(formatValue(dom, 'hex'), '#123456', 'the colour that was taken is the opaque one');
	assert.equal(q(dom, '[data-color-swatch]').style.backgroundColor, 'rgb(18, 52, 86)');
	assert.equal(
		value(dom, '[data-color-hex]'),
		'#12345678',
		'the field still holds what was typed: rewriting the field a visitor is typing in is the one thing a picker must not do',
	);

	type(dom, '[data-color-hex]', '#xyz');
	assert.equal(q(dom, '[data-color-error]').hidden, false);
	assert.match(
		text(dom, '[data-color-error]'),
		/^“#xyz” is not a hex color\. It takes 3, 4, 6 or 8 hex digits, with or without the leading #\.$/,
	);
	assert.equal(
		q(dom, '[data-color-swatch]').style.backgroundColor,
		'rgb(18, 52, 86)',
		'the last good colour stays on screen while the refusal is up',
	);
});

test('the harmony scheme recolours its buttons from config, and names the trade-off', (t) => {
	const dom = colorDom();
	mount(t, dom);
	type(dom, '[data-color-hex]', '#00ff00');

	const select = input<HTMLSelectElement>(dom, '[data-color-scheme]');
	assert.deepEqual(
		Array.from(select.options).map((option) => option.value),
		[...COLOR_SCHEMES],
		'every scheme in config is offered, in order',
	);

	select.value = 'triadic';
	select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));

	const expected = schemeColors(rgbToHsv(rgb('#00ff00')), 'triadic');
	const buttons = qs(dom, '[data-color-scheme-list] .tool__color-swatch');
	assert.equal(buttons.length, expected.length, 'one swatch per colour in the scheme');
	assert.deepEqual(
		buttons.map((button) => button.getAttribute('data-hex')),
		expected.map((entry) => entry.hex),
	);
	assert.deepEqual(
		buttons.map((button) => button.getAttribute('data-role')),
		expected.map((entry) => entry.role),
		'each swatch says which part of the scheme it is',
	);
	assert.deepEqual(
		buttons.map(
			(button) => (button.querySelector('.tool__color-swatch-chip') as HTMLElement).style.backgroundColor,
		),
		expected.map((entry) => rgbCss(entry.hex)),
		'the chip is painted with the colour itself, which is what the page shows',
	);
	for (const [index, button] of buttons.entries()) {
		const label = button.getAttribute('aria-label') ?? '';
		assert.match(label, /Triadic/, 'the scheme is named in the button, not only in the select');
		assert.ok(
			label.includes(expected[index]?.hex as string),
			`and so is the colour: ${label}`,
		);
		assert.equal(
			button.querySelector('.tool__color-swatch-chip')?.getAttribute('aria-hidden'),
			'true',
			'the paint is decoration; the name carries the meaning',
		);
	}
	assert.equal(
		text(dom, '[data-color-status]'),
		`${COLOR_SCHEME_LABEL.triadic}: ${COLOR_SCHEME_HINT.triadic}`,
		'the announcement carries the hint, which is the part a row of squares cannot say',
	);
	assert.equal(text(dom, '[data-color-scheme-hint]'), COLOR_SCHEME_HINT.triadic, 'and so does the hint under the select');

	// Choosing a swatch takes its colour, through the same path as typing a hex.
	click(dom, '[data-color-scheme-list] .tool__color-swatch');
	assert.equal(value(dom, '[data-color-hex]'), expected[0]?.hex);
	assert.equal(q(dom, '[data-color-swatch]').style.backgroundColor, rgbCss(expected[0]?.hex as string));
});

test('the palette fills, counts, copies and clears — and says so without a clipboard', async (t) => {
	const dom = colorDom();
	mount(t, dom);
	assert.equal(typeof dom.window.navigator.clipboard, 'undefined', 'jsdom has no clipboard API');

	type(dom, '[data-color-hex]', '#112233');
	click(dom, '[data-color-palette-add]');
	type(dom, '[data-color-hex]', '#445566');
	click(dom, '[data-color-palette-add]');

	const entries = qs(dom, '[data-color-palette-list] .tool__color-palette-entry');
	assert.equal(entries.length, 2, 'an entry each, in the order they were added');
	assert.deepEqual(
		entries.map((entry) => entry.querySelector('.tool__color-swatch')?.getAttribute('data-hex')),
		['#112233', '#445566'],
	);
	for (const entry of entries) {
		assert.ok(
			entry.querySelectorAll('button').length >= 2,
			'each entry can be chosen and removed, so a full palette is never a dead end',
		);
	}
	assert.equal(q(dom, '[data-color-palette-empty]').hidden, true, 'the empty message steps aside');
	assert.equal(q(dom, '[data-color-palette-list]').getAttribute('data-empty'), 'false');
	assert.match(text(dom, '[data-color-palette-count]'), /2 of 24/, 'the count is against the limit in config');

	/*
	 * No clipboard API is not a failure to hide: the tool reports it in the alert
	 * region, with the reason and the workaround, which is the one thing a visitor
	 * can act on. The copy is async, as it has to be — writeText is a promise.
	 */
	click(dom, '[data-color-palette-copy]');
	await tick();
	assert.equal(q(dom, '[data-color-error]').hidden, false);
	assert.equal(
		text(dom, '[data-color-error]'),
		`${COPY_UNAVAILABLE} Each swatch's name carries its hex value.`,
		'the shared no-clipboard sentence, plus what to do instead',
	);
	assert.match(text(dom, '[data-color-status]'), /^Added #445566 to the palette — 2 colors\./, 'and the last real news stays put');

	click(dom, '[data-color-palette-clear]');
	assert.equal(qs(dom, '[data-color-palette-list] .tool__color-palette-entry').length, 0);
	assert.equal(q(dom, '[data-color-palette-empty]').hidden, false);
	click(dom, '[data-color-palette-copy]');
	await tick();
	assert.match(
		text(dom, '[data-color-error]'),
		/^The palette is empty, so there was nothing to copy\. Add the current color with the button above\.$/,
		'an empty palette is reported before the clipboard is even asked',
	);

	// The limit is enforced, and the refusal names the colour that was not added.
	for (let index = 0; index < maxPaletteEntries; index += 1) {
		type(dom, '[data-color-hex]', `#${(index * 111111).toString(16).padStart(6, '0').slice(0, 6)}`);
		click(dom, '[data-color-palette-add]');
	}
	assert.equal(
		qs(dom, '[data-color-palette-list] .tool__color-palette-entry').length,
		maxPaletteEntries,
		'the palette holds exactly its limit',
	);
	click(dom, '[data-color-palette-add]');
	assert.match(
		text(dom, '[data-color-error]'),
		new RegExp(
			`^The palette holds ${maxPaletteEntries} colors and is full, so #[0-9a-f]{6} was not added\\. Remove one first\\.$`,
		),
		'the refusal names the color that was turned away',
	);
	assert.equal(
		qs(dom, '[data-color-palette-list] .tool__color-palette-entry').length,
		maxPaletteEntries,
		'and nothing was added',
	);
	/*
	 * The button stays live on purpose: a disabled button beside "24 of 24" asks the
	 * visitor to work out why, and a screen reader meets a disabled control with no
	 * reason attached. The refusal in the alert region gives them one.
	 */
	const addButton = input<HTMLButtonElement>(dom, '[data-color-palette-add]');
	assert.equal(addButton.disabled, false);
	assert.equal(addButton.getAttribute('aria-disabled'), null);
});

test('an image is refused before it is read, because this browser cannot decode one', async (t) => {
	const dom = colorDom();
	mount(t, dom);
	assert.equal(typeof dom.window.createImageBitmap, 'undefined');

	const fileInput = input<HTMLInputElement>(dom, '[data-color-image-input]');
	const file = new dom.window.File([new Uint8Array([137, 80, 78, 71])], 'photo.png', { type: 'image/png' });
	Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
	fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
	await tick();

	assert.match(
		text(dom, '[data-color-error]'),
		/^This browser cannot decode images \(createImageBitmap is unavailable\), so a color cannot be taken from a file\. The wheel, the sliders and the hex field all still work\.$/,
	);
	assert.equal(q(dom, '[data-color-image-preview]').hidden, true, 'nothing is shown for a file that was never read');
	assert.equal(text(dom, '[data-color-image-meta]'), '', 'and no dimensions are invented');
	assert.equal(
		q(dom, '[data-color-status]').getAttribute('data-busy'),
		'false',
		'the busy flag is not left on by a refusal',
	);

	// A file that is not an image at all gets the shared image policy's answer.
	const bad = new dom.window.File(['hello'], 'notes.txt', { type: 'text/plain' });
	Object.defineProperty(fileInput, 'files', { value: [bad], configurable: true });
	fileInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
	await tick();
	assert.match(
		text(dom, '[data-color-error]'),
		/notes\.txt/,
		'the refusal names the file, so it is clear which one was turned away',
	);
	assert.equal(fileInput.value, '', 'the input is cleared, so choosing the same file twice still fires change');
});

test('a drop is a drop: dragover marks the zone, and the drop is refused the same way', async (t) => {
	const dom = colorDom();
	mount(t, dom);
	const drop = q(dom, '[data-color-image-drop]');

	const dragover = new dom.window.Event('dragover', { bubbles: true, cancelable: true });
	drop.dispatchEvent(dragover);
	assert.equal(dragover.defaultPrevented, true, 'cancelled, or the browser navigates to the dropped file');
	assert.equal(drop.getAttribute('data-drag-over'), 'true', 'the zone shows it is armed');

	drop.dispatchEvent(new dom.window.Event('dragleave', { bubbles: true }));
	assert.equal(drop.getAttribute('data-drag-over'), 'false');

	const event = new dom.window.Event('drop', { bubbles: true, cancelable: true });
	const file = new dom.window.File([new Uint8Array([137, 80, 78, 71])], 'dropped.png', { type: 'image/png' });
	Object.defineProperty(event, 'dataTransfer', { value: { files: [file] }, configurable: true });
	drop.dispatchEvent(event);
	await tick();
	assert.equal(event.defaultPrevented, true, 'the drop is taken, not handed to the browser');
	assert.equal(drop.getAttribute('data-drag-over'), 'false', 'and the zone is disarmed either way');
	assert.match(text(dom, '[data-color-error]'), /cannot decode images/, 'the honest refusal, from a drop too');

	// A drop with no file in it is nothing at all.
	const empty = new dom.window.Event('drop', { bubbles: true, cancelable: true });
	Object.defineProperty(empty, 'dataTransfer', { value: { files: [] }, configurable: true });
	drop.dispatchEvent(empty);
	await tick();
	assert.match(text(dom, '[data-color-error]'), /cannot decode images/, 'the previous message is left alone');
});

test('the contrast pair takes a background, swaps, and paints the sample in real CSS', (t) => {
	const dom = colorDom();
	mount(t, dom);
	type(dom, '[data-color-hex]', '#767676');

	type(dom, '[data-color-contrast-bg]', '#000000', 'change');
	assert.equal(
		text(dom, '[data-color-contrast-ratio]'),
		formatContrast(contrastRatio(rgb('#767676'), rgb('#000000'))),
	);
	assert.equal(q(dom, '[data-color-contrast-sample]').style.backgroundColor, 'rgb(0, 0, 0)');
	assert.equal(q(dom, '[data-color-contrast-sample]').style.color, 'rgb(118, 118, 118)');
	assert.equal(
		text(dom, '[data-color-contrast-sentence]'),
		'4.62:1 — AA passes at every text size.',
		'the sentence is the ladder the ratio falls on, not a verdict picked by hand',
	);
	assert.deepEqual(
		qs(dom, '.tool__color-badge[data-verdict]').map((badge) => [
			badge.getAttribute('data-verdict'),
			badge.getAttribute('data-pass'),
		]),
		[
			['aaNormal', 'true'],
			['aaLarge', 'true'],
			['aaaNormal', 'false'],
			['aaaLarge', 'true'],
		],
		'three of the four clear at 4.62:1, and the one that does not says so',
	);

	click(dom, '[data-color-contrast-swap]');
	assert.equal(value(dom, '[data-color-hex]'), '#000000', 'the swap really swaps, it does not just relabel');
	assert.equal(value(dom, '[data-color-contrast-bg]'), '#767676');
	assert.match(text(dom, '[data-color-status]'), /^Swapped the pair: #000000 on #767676 — /);

	type(dom, '[data-color-contrast-bg]', 'not-a-color', 'change');
	assert.match(
		text(dom, '[data-color-error]'),
		/not a color this browser can read/,
		'the background field is checked like any other colour, and a bad one is refused',
	);
	assert.equal(
		value(dom, '[data-color-hex]'),
		'#000000',
		'a refused background does not take the foreground with it',
	);
});

test('window events are honoured: a theme change repaints, a resize is settled, pagehide releases', async (t) => {
	const dom = colorDom();
	mount(t, dom);

	// None of these can be seen without a canvas; what matters is that they run
	// clean, because a throw inside a listener is invisible to a visitor and fatal
	// to the rest of the page's scripts.
	dom.window.dispatchEvent(new dom.window.Event('bnji:themechange'));
	dom.window.dispatchEvent(new dom.window.Event('resize'));
	dom.window.dispatchEvent(new dom.window.Event('resize'));
	await tick(TOOL_COLOR_CONFIG.wheel.resizeDebounceMs + 20);
	dom.window.dispatchEvent(new dom.window.Event('pagehide'));
	await tick();

	assert.equal(value(dom, '[data-color-hex]'), defaultColor, 'no listener moved the colour');
	assert.equal(q(dom, '[data-color-image-preview]').hidden, true);
	assert.equal(q(dom, '[data-color-status]').getAttribute('data-busy'), 'false');

	// And the tool still answers after all of it.
	type(dom, '[data-color-hue]', '120');
	assert.notEqual(value(dom, '[data-color-hex]'), defaultColor);
});

test('teardown stops everything, and a second init binds a fresh subtree', (t) => {
	const dom = colorDom();
	initColorPicker();

	type(dom, '[data-color-hex]', '#123456');
	assert.equal(text(dom, '[data-color-name]'), describeColor(rgbToHsv(rgb('#123456'))));

	destroyColorPicker();
	type(dom, '[data-color-hex]', '#00ff00');
	assert.equal(
		text(dom, '[data-color-name]'),
		describeColor(rgbToHsv(rgb('#123456'))),
		'nothing is written after teardown: the field holds text, the tool holds no listeners',
	);
	assert.equal(q(dom, '[data-color-swatch]').style.backgroundColor, 'rgb(18, 52, 86)');
	assert.equal(formatValue(dom, 'hex'), '#123456');

	initColorPicker();
	assert.equal(value(dom, '[data-color-hex]'), defaultColor, 'a second init starts from config again');
	type(dom, '[data-color-hex]', '#00ff00');
	assert.equal(
		text(dom, '[data-color-name]'),
		describeColor(rgbToHsv(rgb('#00ff00'))),
		'and the fresh subtree answers',
	);
	assert.equal(
		qs(dom, '.tool__color-format[data-format]').length,
		COLOR_FORMATS.length,
		'exactly one set of format rows: a second init does not double the list',
	);

	destroyColorPicker();
	dom.window.close();
});

test('the one note left under the tool states the limits from config and what it will not pretend to', (t) => {
	const dom = colorDom();
	mount(t, dom);
	const notes = qs(dom, '.tool__note');
	assert.equal(notes.length, 1, 'one note, at the end of the tool');
	const note = (notes[0]?.textContent ?? '').replace(/\s+/g, ' ').trim();
	/*
	 * The page was deliberately stripped of prose, so the note is a line rather
	 * than a paragraph — but it is still the one place the trade-offs are stated,
	 * and it still quotes the numbers the code enforces (they are substituted
	 * from config in the fixture above, so a limit changed in tools.config.ts and
	 * not in this sentence fails here).
	 */
	assert.ok(note.length < 400, `the note stays short, and this one is ${note.length} characters`);
	for (const expected of [
		megabytes,
		maxSourcePixels.toLocaleString('en-US'),
		IMAGE_INPUT_LABELS,
		String(sample.scanMaxEdge),
		String(wheel.maxBacking),
	]) {
		assert.ok(note.includes(expected), `the note should state ${expected}`);
	}
	for (const honest of [
		/No alpha channel/,
		/CMYK is derived from RGB/,
		/WCAG 2\.x relative luminance, not APCA/,
		/read as sRGB/,
	]) {
		assert.match(note, honest, 'the trade-off is stated rather than left for the visitor to find');
	}
});
