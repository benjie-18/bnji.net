/**
 * /tools/ color picker: the arithmetic, and the controller's decisions.
 *
 * WHY THE NUMBERS IN HERE LOOK BORING
 * -----------------------------------
 * Almost every expected value is one that can be written down by hand or read off
 * a specification, and never one that was printed by the code under test and pasted
 * back in. That is the only way a colour module can be tested honestly: white on
 * black is 21:1, #767676 on white is 4.54:1 (the grey W3C uses to show where AA
 * starts), sRGB red is oklch(0.628 0.2577 29.23) in Ottosson's published example,
 * pure red is hsv(0, 100%, 100%) and cmyk(0, 1, 1, 0). A wrong coefficient in any
 * of those conversions fails one of these tests rather than shipping a colour that
 * is almost right.
 *
 * The second half drives initColorPicker() against the DOM shim: what it refuses,
 * what it says, which controls it writes back to, and what it does with an image.
 * The canvas half of that is a recording fake (tests/support/dom.mjs) — it can
 * show sizes, order and the pixels a test put there, and it cannot show what the
 * wheel looks like. Nothing in this sandbox can; there is no browser here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
	COLOR_FORMATS,
	COLOR_FORMAT_LABEL,
	COLOR_SCHEMES,
	COLOR_SCHEME_HINT,
	IMAGE_FILE_CONFIG,
	TOOL_COLOR_CONFIG,
} from '../src/config/tools.config.ts';
import {
	applyWheelValue,
	channelDistance,
	clampChannel,
	clampToDisc,
	clampUnit,
	commonColors,
	contrastRatio,
	contrastSentence,
	contrastVerdicts,
	describeColor,
	fitInside,
	formatBlock,
	formatCmykText,
	formatContrast,
	formatHslCss,
	formatHsvText,
	formatHwbCss,
	formatOklchCss,
	formatRgbCss,
	formatValues,
	hsToWheelPoint,
	hsvToRgb,
	hueFamily,
	parseCssColorString,
	parseHexColor,
	paintWheelBase,
	relativeLuminance,
	rgbToCmyk,
	rgbToHex,
	rgbToHsl,
	rgbToHsv,
	rgbToHwb,
	rgbToOklch,
	schemeColors,
	shade,
	srgbToLinear,
	tint,
	wheelBackingSize,
	wheelToHs,
	wrapHue,
	type Rgb,
} from '../src/scripts/tools-color.ts';

const rgb = (hex: string): Rgb => {
	const parsed = parseHexColor(hex);
	assert.ok(parsed, `${hex} should parse`);
	return parsed.rgb;
};

const near = (actual: number, expected: number, tolerance = 1e-9, message = ''): void => {
	assert.ok(
		Math.abs(actual - expected) <= tolerance,
		`${message} expected ${expected}, got ${actual} (±${tolerance})`,
	);
};

const hsvOf = (hex: string) => rgbToHsv(rgb(hex));

/* --- domains -------------------------------------------------------------- */

test('a channel is an integer in 0–255, and anything else is clamped not refused', () => {
	assert.equal(clampChannel(0), 0);
	assert.equal(clampChannel(255), 255);
	assert.equal(clampChannel(12.4), 12);
	assert.equal(clampChannel(12.6), 13);
	assert.equal(clampChannel(300), 255, 'a typed 300 means 255');
	assert.equal(clampChannel(-4), 0);
	assert.equal(clampChannel(Number.NaN), 0, 'a NaN must not reach a hex string');
	assert.equal(clampChannel(Number.POSITIVE_INFINITY), 0, 'and neither must an Infinity: there is nothing to clamp');
});

test('saturation and value live in 0–1', () => {
	assert.equal(clampUnit(0.5), 0.5);
	assert.equal(clampUnit(2), 1);
	assert.equal(clampUnit(-1), 0);
	assert.equal(clampUnit(Number.NaN), 0);
});

test('hue is an angle, so it wraps instead of stopping at the ends', () => {
	assert.equal(wrapHue(0), 0);
	assert.equal(wrapHue(360), 0, 'a full turn is back at red');
	assert.equal(wrapHue(370), 10);
	assert.equal(wrapHue(-30), 330, 'rotating backwards past red comes round');
	assert.equal(wrapHue(-360), 0);
	assert.equal(wrapHue(Number.NaN), 0);
});

/* --- hex ------------------------------------------------------------------ */

test('hex parsing reads 3, 4, 6 and 8 digits, and refuses the near misses', () => {
	assert.deepEqual(parseHexColor('#ff8800'), { rgb: { r: 255, g: 136, b: 0 }, alpha: null });
	assert.deepEqual(parseHexColor('ff8800'), { rgb: { r: 255, g: 136, b: 0 }, alpha: null }, 'the # is optional');
	assert.deepEqual(parseHexColor('#F80'), { rgb: { r: 255, g: 136, b: 0 }, alpha: null }, 'case does not matter');
	assert.deepEqual(
		parseHexColor('f80'),
		{ rgb: { r: 255, g: 136, b: 0 }, alpha: null },
		'shorthand doubles each digit: #f80 is #ff8800, not #f80000',
	);
	assert.deepEqual(parseHexColor('  #ff8800  '), { rgb: { r: 255, g: 136, b: 0 }, alpha: null }, 'pasted values carry spaces');

	const withAlpha = parseHexColor('#FF880080');
	assert.ok(withAlpha);
	assert.deepEqual(withAlpha.rgb, { r: 255, g: 136, b: 0 });
	assert.equal(Math.round((withAlpha.alpha ?? 0) * 255), 128, 'the alpha byte is reported, not silently dropped');
	const shorthandAlpha = parseHexColor('#f808');
	assert.equal(Math.round((shorthandAlpha?.alpha ?? 0) * 255), 136, '#f808 is #ff880088');

	assert.equal(parseHexColor('#gg0000'), null, 'not hex digits');
	assert.equal(parseHexColor('#12345'), null, 'five digits is not a length CSS has');
	assert.equal(parseHexColor('#1234567'), null);
	assert.equal(parseHexColor(''), null);
	assert.equal(parseHexColor('#'), null);
	assert.equal(parseHexColor('rebeccapurple'), null, 'a name is not a hex, and is not read as one');
	assert.equal(parseHexColor('rgb(1,2,3)'), null);
});

test('hex printing is lowercase, six digits, and clamps what it is given', () => {
	assert.equal(rgbToHex({ r: 224, g: 122, b: 63 }), '#e07a3f');
	assert.equal(rgbToHex({ r: 0, g: 0, b: 0 }), '#000000');
	assert.equal(rgbToHex({ r: 255, g: 255, b: 255 }), '#ffffff');
	assert.equal(rgbToHex({ r: 18, g: 52, b: 86 }), '#123456', 'single digits are padded');
	assert.equal(rgbToHex({ r: 300, g: -4, b: Number.NaN }), '#ff0000', 'out-of-range channels are clamped, not printed');
});

test('a hex survives the round trip through every model that has an inverse', () => {
	// Not a random sample: a step of 7, 11 and 13 across the three channels covers
	// all six sextants of the hue circle and both ends of every range, in a few
	// thousand colors. If hsv->rgb->hsv loses a step anywhere, this finds it.
	let checked = 0;
	for (let r = 0; r < 256; r += 7) {
		for (let g = 0; g < 256; g += 11) {
			for (let b = 0; b < 256; b += 13) {
				const source = { r, g, b };
				const hex = rgbToHex(source);
				const parsed = parseHexColor(hex);
				assert.ok(parsed, hex);
				assert.deepEqual(parsed.rgb, source, `${hex} came back as something else`);
				const shown = hsvToRgb(rgbToHsv(source));
				assert.equal(rgbToHex(shown), hex, `${hex} moved on the way through HSV`);
				checked += 1;
			}
		}
	}
	assert.ok(checked > 1000, `the sweep covered ${checked} colors`);
});

/* --- HSV ------------------------------------------------------------------ */

test('HSV puts the six primaries where the wheel says they are', () => {
	assert.deepEqual(hsvToRgb({ h: 0, s: 1, v: 1 }), { r: 255, g: 0, b: 0 });
	assert.deepEqual(hsvToRgb({ h: 60, s: 1, v: 1 }), { r: 255, g: 255, b: 0 });
	assert.deepEqual(hsvToRgb({ h: 120, s: 1, v: 1 }), { r: 0, g: 255, b: 0 });
	assert.deepEqual(hsvToRgb({ h: 180, s: 1, v: 1 }), { r: 0, g: 255, b: 255 });
	assert.deepEqual(hsvToRgb({ h: 240, s: 1, v: 1 }), { r: 0, g: 0, b: 255 });
	assert.deepEqual(hsvToRgb({ h: 300, s: 1, v: 1 }), { r: 255, g: 0, b: 255 });
	assert.deepEqual(hsvToRgb({ h: 360, s: 1, v: 1 }), { r: 255, g: 0, b: 0 }, 'the circle closes');
	assert.deepEqual(hsvToRgb({ h: 0, s: 0, v: 0.5 }), { r: 128, g: 128, b: 128 }, 'no saturation is a grey at that value');
	assert.deepEqual(hsvToRgb({ h: 200, s: 1, v: 0 }), { r: 0, g: 0, b: 0 }, 'value 0 is black whatever the hue');
});

test('RGB to HSV reports the primaries back, and a grey as having no saturation', () => {
	assert.deepEqual(rgbToHsv({ r: 255, g: 0, b: 0 }), { h: 0, s: 1, v: 1 });
	assert.deepEqual(rgbToHsv({ r: 0, g: 255, b: 0 }), { h: 120, s: 1, v: 1 });
	assert.deepEqual(rgbToHsv({ r: 0, g: 0, b: 255 }), { h: 240, s: 1, v: 1 });
	assert.deepEqual(rgbToHsv({ r: 255, g: 255, b: 255 }), { h: 0, s: 0, v: 1 });
	assert.deepEqual(rgbToHsv({ r: 0, g: 0, b: 0 }), { h: 0, s: 0, v: 0 });

	const grey = rgbToHsv({ r: 128, g: 128, b: 128 });
	assert.equal(grey.s, 0, 'a grey has no saturation');
	near(grey.v, 128 / 255, 1e-12);
	assert.equal(grey.h, 0, 'with no chroma the hue is undefined, so it is 0…');
	assert.equal(
		rgbToHsv({ r: 128, g: 128, b: 128 }, 200).h,
		200,
		'…unless the tool already had one, which is what stops a grey snapping the wheel to red',
	);
	assert.deepEqual(
		hsvToRgb(rgbToHsv({ r: 128, g: 128, b: 128 }, 200)),
		{ r: 128, g: 128, b: 128 },
		'and keeping that hue changes nothing about the color, because saturation is 0',
	);
});

/* --- the derived models --------------------------------------------------- */

test('HSL, HWB and CMYK agree with their definitions on colors that can be checked by hand', () => {
	// Pure red: lightness is halfway, whiteness and blackness are both nothing, and
	// print takes it as full magenta and yellow with no black.
	assert.deepEqual(rgbToHsl({ r: 255, g: 0, b: 0 }), { h: 0, s: 1, l: 0.5 });
	assert.deepEqual(rgbToHwb({ r: 255, g: 0, b: 0 }), { h: 0, w: 0, b: 0 });
	assert.deepEqual(rgbToCmyk({ r: 255, g: 0, b: 0 }), { c: 0, m: 1, y: 1, k: 0 });

	assert.deepEqual(rgbToHsl({ r: 255, g: 255, b: 255 }), { h: 0, s: 0, l: 1 });
	assert.deepEqual(rgbToHwb({ r: 255, g: 255, b: 255 }), { h: 0, w: 1, b: 0 });
	assert.deepEqual(rgbToCmyk({ r: 255, g: 255, b: 255 }), { c: 0, m: 0, y: 0, k: 0 });

	assert.deepEqual(rgbToHsl({ r: 0, g: 0, b: 0 }), { h: 0, s: 0, l: 0 });
	assert.deepEqual(rgbToHwb({ r: 0, g: 0, b: 0 }), { h: 0, w: 0, b: 1 });
	assert.deepEqual(rgbToCmyk({ r: 0, g: 0, b: 0 }), { c: 0, m: 0, y: 0, k: 1 }, 'black is all K, no ink');

	// A mid grey: w + b reaches 1, which is exactly the case CSS defines as "grey
	// whatever the hue", and HSL saturation is 0 rather than a division by zero.
	const grey = rgb('#808080');
	const hwb = rgbToHwb(grey);
	near(hwb.w + hwb.b, 1, 1e-12, 'grey: ');
	assert.equal(rgbToHsl(grey).s, 0);
	near(rgbToCmyk(grey).k, 1 - 128 / 255, 1e-12, 'grey cmyk: ');

	// HSL and HSV share a hue by definition, so they must never disagree about one.
	for (const hex of ['#e07a3f', '#3f7ae0', '#7ae03f', '#e03f7a', '#123456']) {
		near(rgbToHsl(rgb(hex)).h, rgbToHsv(rgb(hex)).h, 1e-12, `${hex} hue: `);
		near(rgbToHwb(rgb(hex)).h, rgbToHsv(rgb(hex)).h, 1e-12, `${hex} hwb hue: `);
	}
});

test('OKLCH matches the published values, including the ones a person can check', () => {
	// Ottosson's own example: sRGB red is oklch(0.6280 0.2577 29.23).
	const red = rgbToOklch({ r: 255, g: 0, b: 0 });
	near(red.l, 0.6279553606145516, 1e-9, 'red L: ');
	near(red.c, 0.2576833077361567, 1e-9, 'red C: ');
	near(red.h, 29.233885192342633, 1e-9, 'red H: ');
	near(red.l, 0.628, 5e-4);
	near(red.c, 0.2577, 5e-5);
	near(red.h, 29.23, 5e-3);

	// The endpoints: white is L 1 with no chroma, black is L 0 with none.
	const white = rgbToOklch({ r: 255, g: 255, b: 255 });
	near(white.l, 1, 1e-6, 'white L: ');
	assert.ok(white.c < 1e-6, `white has no chroma, got ${white.c}`);
	assert.equal(white.h, 0, 'an achromatic color reports hue 0, as CSS does, rather than floating-point dust');
	const black = rgbToOklch({ r: 0, g: 0, b: 0 });
	near(black.l, 0, 1e-12, 'black L: ');
	assert.equal(black.c, 0);

	// The property that makes OKLCH worth showing: equal steps in L look equal.
	// Perceptual lightness is monotonic in a grey ramp, which sRGB values are not.
	const ramp = [16, 48, 96, 148, 196, 240].map((value) => rgbToOklch({ r: value, g: value, b: value }).l);
	for (let index = 1; index < ramp.length; index += 1) {
		assert.ok((ramp[index] as number) > (ramp[index - 1] as number), `L must rise through a grey ramp at ${index}`);
	}
	// Step sizes are deliberately not asserted: how evenly L spreads is a property
	// of the standard, and only the order is something a mistake here would break.
});

test('the sRGB transfer function is the standard one at its defined points', () => {
	near(srgbToLinear(0), 0);
	near(srgbToLinear(1), 1);
	// The toe: below 0.04045 the curve is a straight line through the origin.
	near(srgbToLinear(0.04045), 0.04045 / 12.92, 1e-12);
	near(srgbToLinear(0.04045 / 2), 0.04045 / 2 / 12.92, 1e-12);
	// And it is continuous across the join, which is the point of the 0.055 offset.
	const below = srgbToLinear(0.04045);
	const above = srgbToLinear(0.04046);
	assert.ok(Math.abs(above - below) < 1e-4, `the curve jumps at the join: ${below} -> ${above}`);
	near(srgbToLinear(0.5), ((0.5 + 0.055) / 1.055) ** 2.4, 1e-12);
	assert.equal(srgbToLinear(2), 1, 'clamped, because a channel is 0-1');
	assert.equal(srgbToLinear(-1), 0);
});

/* --- contrast ------------------------------------------------------------- */

test('contrast ratios are the WCAG ones, at the values the standard publishes', () => {
	const white = rgb('#ffffff');
	const black = rgb('#000000');

	assert.equal(relativeLuminance(white), 1, 'white is the top of the scale');
	assert.equal(relativeLuminance(black), 0, 'black is the bottom');
	near(relativeLuminance(rgb('#808080')), 0.2158, 1e-4, 'mid grey: ');
	near(relativeLuminance(rgb('#ff0000')), 0.2126, 1e-9, 'red is the luma coefficient for R: ');

	assert.equal(formatContrast(contrastRatio(white, black)), '21.00:1', 'the top of the scale');
	assert.equal(formatContrast(contrastRatio(black, white)), '21.00:1', 'the pair is unordered');
	assert.equal(formatContrast(contrastRatio(white, white)), '1.00:1', 'the bottom of the scale');
	assert.equal(
		formatContrast(contrastRatio(rgb('#767676'), white)),
		'4.54:1',
		'the grey W3C uses to show where AA for normal text starts',
	);
	assert.equal(
		formatContrast(contrastRatio(rgb('#777777'), white)),
		'4.48:1',
		'one step lighter, and it fails',
	);
	assert.equal(formatContrast(contrastRatio(rgb('#ff0000'), white)), '4.00:1', 'pure red on white');
	assert.equal(formatContrast(Number.NaN), '—', 'a ratio that cannot be computed is not printed as a number');
});

test('the verdicts are the four thresholds, and the sentence says the strongest true claim', () => {
	const { aaNormal, aaLarge, aaaNormal, aaaLarge } = TOOL_COLOR_CONFIG.contrast;
	assert.deepEqual([aaNormal, aaLarge, aaaNormal, aaaLarge], [4.5, 3, 7, 4.5], 'the WCAG 2.x numbers');

	assert.deepEqual(contrastVerdicts(21), { aaNormal: true, aaLarge: true, aaaNormal: true, aaaLarge: true });
	assert.deepEqual(contrastVerdicts(4.54), { aaNormal: true, aaLarge: true, aaaNormal: false, aaaLarge: true });
	assert.deepEqual(contrastVerdicts(4.4), { aaNormal: false, aaLarge: true, aaaNormal: false, aaaLarge: false });
	assert.deepEqual(contrastVerdicts(2.9), { aaNormal: false, aaLarge: false, aaaNormal: false, aaaLarge: false });
	assert.deepEqual(contrastVerdicts(7), { aaNormal: true, aaLarge: true, aaaNormal: true, aaaLarge: true }, 'thresholds are inclusive');

	assert.match(contrastSentence(21), /AAA passes at every text size/);
	assert.match(contrastSentence(4.54), /AA passes at every text size/);
	assert.match(contrastSentence(4.4), /AA passes for large text only/);
	assert.match(contrastSentence(6.9), /AA passes at every text size/, 'below AAA for body text, above it for large');
	assert.match(contrastSentence(2.9), /below every WCAG threshold/);
	assert.match(contrastSentence(4.4), /^4\.40:1/, 'the sentence leads with the ratio it judged');
});

/* --- naming a color ------------------------------------------------------- */

test('the twelve hue families are 30° each, red centred on 0°', () => {
	const expected: [number, string][] = [
		[0, 'red'],
		[14, 'red'],
		[15, 'orange'],
		[30, 'orange'],
		[45, 'yellow'],
		[75, 'chartreuse'],
		[105, 'green'],
		[135, 'spring green'],
		[165, 'cyan'],
		[195, 'azure'],
		[225, 'blue'],
		[255, 'violet'],
		[285, 'magenta'],
		[315, 'rose'],
		[345, 'red'],
		[359, 'red'],
		[360, 'red'],
		[-30, 'rose'],
	];
	for (const [hue, name] of expected) assert.equal(hueFamily(hue), name, `${hue}°`);
});

test('a color is described in words, and the words follow from its numbers', () => {
	assert.equal(describeColor(hsvOf('#ff0000')), 'a vivid red');
	assert.equal(describeColor(hsvOf('#00ff00')), 'a vivid green');
	assert.equal(describeColor(hsvOf('#e07a3f')), 'an orange', 'the article agrees with the word');
	assert.equal(describeColor(hsvOf('#0080ff')), 'a vivid azure');
	assert.equal(describeColor(hsvOf('#d0e0f0')), 'a pale azure', 'low saturation is pale, whatever the hue');
	assert.equal(describeColor(hsvOf('#0a0a14')), 'a deep blue', 'low value is deep');
	assert.equal(describeColor(hsvOf('#808080')), 'a grey');
	assert.equal(describeColor(hsvOf('#ffffff')), 'near white');
	assert.equal(describeColor(hsvOf('#000000')), 'near black');
	assert.equal(describeColor(hsvOf('#0d0c0c')), 'near black', 'a value this low is black whatever is tinting it');
	assert.equal(describeColor(hsvOf('#202020')), 'almost black', 'a dark grey is not black, and is not called black');
	assert.equal(describeColor(hsvOf('#f5f0e8')), 'almost white', 'a very light tint of something is not white, and is not called white');
	assert.equal(describeColor({ h: 200, s: 0, v: 0.5 }), 'a grey', 'a hue with no saturation is a grey, not a cyan');
});

/* --- tints, shades and schemes ------------------------------------------- */

test('a tint mixes toward white and a shade toward black, by the amount asked for', () => {
	assert.equal(rgbToHex(tint(rgb('#000000'), 0.5)), '#808080');
	assert.equal(rgbToHex(tint(rgb('#000000'), 0)), '#000000', '0 leaves it alone');
	assert.equal(rgbToHex(tint(rgb('#000000'), 1)), '#ffffff', '1 is white');
	assert.equal(rgbToHex(shade(rgb('#ffffff'), 0.5)), '#808080');
	assert.equal(rgbToHex(shade(rgb('#ffffff'), 1)), '#000000');
	assert.equal(rgbToHex(tint(rgb('#e07a3f'), 2)), '#ffffff', 'an amount past the range is clamped');
	assert.equal(rgbToHex(shade(rgb('#e07a3f'), -1)), '#e07a3f');
	// A tint of a color keeps its hue: that is what makes it a tint of it.
	const base = rgb('#e07a3f');
	near(rgbToHsv(tint(base, 0.4)).h, rgbToHsv(base).h, 1, 'a tint keeps the hue');
	near(rgbToHsv(shade(base, 0.4)).h, rgbToHsv(base).h, 1, 'a shade keeps the hue');
});

test('every scheme is the rotation its name says, at the saturation and value chosen', () => {
	const red = { h: 0, s: 1, v: 1 };
	assert.deepEqual(
		schemeColors(red, 'complement').map((entry) => entry.hex),
		['#ff0000', '#00ffff'],
		'180° apart',
	);
	assert.deepEqual(
		schemeColors(red, 'analogous').map((entry) => entry.hex),
		['#ff0080', '#ff0000', '#ff8000'],
		'30° either side, and the base is in the middle',
	);
	assert.deepEqual(
		schemeColors(red, 'triadic').map((entry) => entry.hex),
		['#ff0000', '#00ff00', '#0000ff'],
		'three primaries',
	);
	assert.deepEqual(
		schemeColors(red, 'square').map((entry) => entry.hex),
		['#ff0000', '#80ff00', '#00ffff', '#8000ff'],
		'four at 90°',
	);
	assert.deepEqual(
		schemeColors(red, 'split').map((entry) => entry.hex),
		['#ff0000', '#00ff80', '#0080ff'],
		'either side of the complement, not on it',
	);

	// Monochrome is not a rotation: it holds the hue and mixes toward white and
	// black, so the base is the color the visitor actually has.
	const monochrome = schemeColors(hsvOf('#e07a3f'), 'monochrome');
	assert.equal(monochrome.length, 5);
	assert.deepEqual(
		monochrome.map((entry) => entry.role),
		['Tint 60%', 'Tint 30%', 'Base', 'Shade 30%', 'Shade 60%'],
	);
	assert.equal(monochrome[2]?.hex, '#e07a3f', 'the base is the current color');
	assert.equal(monochrome[0]?.hex, rgbToHex(tint(rgb('#e07a3f'), 0.6)));
	assert.equal(monochrome[4]?.hex, rgbToHex(shade(rgb('#e07a3f'), 0.6)));
	for (let index = 1; index < monochrome.length; index += 1) {
		const previous = monochrome[index - 1] as { rgb: Rgb };
		const next = monochrome[index] as { rgb: Rgb };
		assert.ok(
			relativeLuminance(next.rgb) < relativeLuminance(previous.rgb),
			`the ramp gets darker at ${index}`,
		);
	}

	// A scheme at half value stays at half value: rebuilding it at full value would
	// hand back colors that shout over whatever the visitor was doing.
	const muted = schemeColors({ h: 210, s: 0.5, v: 0.5 }, 'triadic');
	for (const entry of muted) {
		near(rgbToHsv(entry.rgb).v, 0.5, 0.01, `${entry.role} value: `);
		near(rgbToHsv(entry.rgb).s, 0.5, 0.01, `${entry.role} saturation: `);
	}
	for (const name of COLOR_SCHEMES) {
		assert.ok(schemeColors(red, name).length >= 2, `${name} offers at least a pair`);
		assert.ok(
			schemeColors(red, name).every((entry) => entry.role.length > 0 && /^#[0-9a-f]{6}$/.test(entry.hex)),
			`${name} names its swatches and prints a hex for each`,
		);
	}
});

/* --- the wheel ------------------------------------------------------------ */

test('the wheel reads red at three o’clock and turns clockwise, as every generated hue wheel does', () => {
	const size = 200;
	const at = (x: number, y: number) => wheelToHs({ x, y }, size, 42);

	// Screen y grows downward, so atan2(dy, dx) turns clockwise: red at 0° on the
	// right, then yellow-green below it, cyan on the left, blue above.
	near((at(199, 100)?.h ?? -1), 0, 0.6, '3 o’clock: ');
	near((at(100, 199)?.h ?? -1), 90, 0.6, '6 o’clock: ');
	near((at(1, 100)?.h ?? -1), 180, 0.6, '9 o’clock: ');
	near((at(100, 1)?.h ?? -1), 270, 0.6, '12 o’clock: ');

	near(at(100, 100)?.s ?? -1, 0, 1e-12, 'the centre has no saturation');
	assert.equal(at(100, 100)?.h, 42, 'and no angle, so the hue already on screen is kept');
	near(at(150, 100)?.s ?? -1, 0.5, 1e-12, 'halfway out is half saturated');
	near(at(199, 100)?.s ?? -1, 0.99, 1e-12, 'the rim is the fullest color');
	assert.equal(at(400, 400)?.s, 1, 'past the rim, saturation stops at 1 rather than the point being refused');
	assert.equal(wheelToHs({ x: 0, y: 0 }, 0), null, 'a wheel with no size has nothing to say');
});

test('a color maps back to the point it was read from', () => {
	const size = 240;
	for (const hs of [
		{ h: 0, s: 1 },
		{ h: 90, s: 0.5 },
		{ h: 200, s: 0.25 },
		{ h: 359, s: 1 },
	]) {
		const point = hsToWheelPoint(hs, size);
		const back = wheelToHs(point, size);
		assert.ok(back);
		near(back.h, hs.h, 1e-9, `hue of ${hs.h}/${hs.s}: `);
		near(back.s, hs.s, 1e-9, `saturation of ${hs.h}/${hs.s}: `);
	}
	// The marker has to land inside the canvas, or the visitor loses track of it.
	const edge = hsToWheelPoint({ h: 45, s: 1 }, size);
	assert.ok(edge.x >= 0 && edge.x <= size && edge.y >= 0 && edge.y <= size, `the rim point ${JSON.stringify(edge)} is inside the square`);
});

test('a drag past the rim is pulled back to it, keeping the hue', () => {
	const size = 200;
	assert.deepEqual(clampToDisc({ x: 400, y: 100 }, size), { x: 200, y: 100 }, 'straight out to the right edge');
	const diagonal = clampToDisc({ x: 300, y: 300 }, size);
	near(Math.hypot(diagonal.x - 100, diagonal.y - 100), 100, 1e-9, 'the diagonal lands on the rim');
	near(wheelToHs(diagonal, size)?.h ?? -1, 45, 1e-9, 'and keeps its angle');
	assert.deepEqual(clampToDisc({ x: 120, y: 90 }, size), { x: 120, y: 90 }, 'a point inside is left alone');
	assert.deepEqual(clampToDisc({ x: 1, y: 1 }, 0), { x: 0, y: 0 }, 'a wheel with no size');
});

test('the backing store follows the element and the pixel ratio, and stops at the cap', () => {
	const { maxBacking, fallbackCssSize, maxPixelRatio } = TOOL_COLOR_CONFIG.wheel;
	assert.equal(wheelBackingSize(240, 1), 240);
	assert.equal(wheelBackingSize(240, 2), 480);
	assert.equal(wheelBackingSize(240, 3), 640, 'capped, not 720');
	assert.equal(wheelBackingSize(240, maxPixelRatio + 2), maxBacking, 'a 5× screen does not get a 5× buffer');
	assert.equal(wheelBackingSize(1000, 2), maxBacking);
	assert.equal(wheelBackingSize(0, 2), fallbackCssSize * 2, 'no layout yet: the fallback size');
	assert.equal(wheelBackingSize(Number.NaN, Number.NaN), fallbackCssSize, 'and no ratio either');
	assert.equal(wheelBackingSize(240, 0), 240, 'a ratio of 0 is treated as 1, not as nothing');
	assert.ok(wheelBackingSize(240, 2) ** 2 * 4 <= maxBacking ** 2 * 4, 'the cap is what bounds the allocation');
});

test('the wheel is painted per pixel: white at the centre, the primaries at the rim, nothing outside', () => {
	const size = 64;
	const pixels = new Uint8ClampedArray(size * size * 4);
	paintWheelBase(pixels, size);
	const at = (x: number, y: number) => [
		pixels[(y * size + x) * 4] as number,
		pixels[(y * size + x) * 4 + 1] as number,
		pixels[(y * size + x) * 4 + 2] as number,
		pixels[(y * size + x) * 4 + 3] as number,
	];

	const centre = at(size / 2, size / 2);
	// Near white rather than exactly: a pixel is not a point, and this one's centre
	// sits 0.7px from the wheel's, so it carries a trace of the hue at that angle.
	// The trace is the honest answer, and it is why the assertion is a range.
	assert.ok(
		centre[0] > 245 && centre[1] > 245 && centre[2] > 245,
		`the centre is white, got ${centre}`,
	);
	assert.equal(centre[3], 255);

	const right = at(size - 1, size / 2);
	assert.ok(right[0] > 250 && right[1] < 20 && right[2] < 20, `3 o’clock is red, got ${right}`);
	const bottom = at(size / 2, size - 1);
	assert.ok(bottom[1] > 250 && bottom[0] > 100 && bottom[0] < 160 && bottom[2] < 20, `6 o’clock is chartreuse, got ${bottom}`);
	const left = at(0, size / 2);
	assert.ok(left[1] > 250 && left[2] > 250 && left[0] < 20, `9 o’clock is cyan, got ${left}`);
	assert.ok(
		left[3] >= 254,
		`and its pixel centre is a hair inside the radius, so coverage is a round 254 rather than 255: got ${left[3]}`,
	);

	const corner = at(0, 0);
	assert.equal(corner[3], 0, 'outside the circle is transparent, so the panel shows through');
	assert.equal(at(size - 1, size - 1)[3], 0);

	// Coverage falls off over one pixel, which is what makes the edge smooth rather
	// than staircased.
	let partial = 0;
	for (let index = 3; index < pixels.length; index += 4) {
		const alpha = pixels[index] as number;
		if (alpha > 0 && alpha < 255) partial += 1;
	}
	assert.ok(partial > 0, 'some pixels are part-covered');
	assert.ok(partial < size * 4, `but only around the rim, and ${partial} is too many for a ${size}px wheel`);
});

test('brightness scales the wheel without touching its alpha', () => {
	const size = 32;
	const base = new Uint8ClampedArray(size * size * 4);
	paintWheelBase(base, size);
	const shown = new Uint8ClampedArray(size * size * 4);

	applyWheelValue(shown, base, 1);
	assert.deepEqual(Array.from(shown), Array.from(base), 'value 1 is the base unchanged');

	applyWheelValue(shown, base, 0.5);
	const rim = (size - 1) * 4 + (size / 2) * size * 4;
	assert.equal(shown[rim], Math.round((base[rim] as number) * 0.5), 'channels are halved');
	assert.equal(shown[rim + 3], base[rim + 3], 'alpha is not: a darker wheel is a darker color, not a transparent one');

	applyWheelValue(shown, base, 0);
	assert.equal(shown[(size / 2) * size * 4 + (size / 2) * 4], 0, 'value 0 is black');
	assert.equal(shown[(size / 2) * size * 4 + (size / 2) * 4 + 3], 255, 'and still opaque at the centre');

	applyWheelValue(shown, base, 2);
	assert.deepEqual(Array.from(shown), Array.from(base), 'an out-of-range value is clamped');
});

/* --- reading an image ----------------------------------------------------- */

test('an image is fitted inside a box without being enlarged or stretched', () => {
	assert.deepEqual(fitInside(4000, 3000, 560), { width: 560, height: 420, scale: 0.14 });
	assert.deepEqual(fitInside(3000, 4000, 560), { width: 420, height: 560, scale: 0.14 }, 'portrait keeps its ratio');
	assert.deepEqual(fitInside(200, 100, 560), { width: 200, height: 100, scale: 1 }, 'a small image is not enlarged');
	assert.deepEqual(fitInside(1000, 1000, 160), { width: 160, height: 160, scale: 0.16 });
	assert.deepEqual(fitInside(1, 1, 160), { width: 1, height: 1, scale: 1 });
	assert.deepEqual(fitInside(0, 0, 160), { width: 1, height: 1, scale: 1 }, 'a degenerate image is one pixel, not zero');
	const wide = fitInside(10_000, 3, 160);
	assert.equal(wide.width, 160);
	assert.ok(wide.height >= 1, `an extreme ratio still gets a row of pixels, got ${wide.height}`);
});

test('common colors counts what is there, skips what is transparent, and does not repeat itself', () => {
	const options = {
		maxColors: TOOL_COLOR_CONFIG.sample.maxCommonColors,
		bucketShift: TOOL_COLOR_CONFIG.sample.bucketShift,
		minDistance: TOOL_COLOR_CONFIG.sample.minColorDistance,
	};
	// 40 warm pixels, 30 cool ones, and two that are transparent: the shares are of
	// the 70 that were counted, because a half-transparent pixel has no color of
	// its own — what it looks like depends on what is behind it.
	const pixels = new Uint8ClampedArray(72 * 4);
	let index = 0;
	const put = (r: number, g: number, b: number, a: number) => {
		pixels[index] = r;
		pixels[index + 1] = g;
		pixels[index + 2] = b;
		pixels[index + 3] = a;
		index += 4;
	};
	for (let n = 0; n < 40; n += 1) put(200 + (n % 5), 40, 30, 255);
	for (let n = 0; n < 30; n += 1) put(20, 60 + (n % 5), 210, 255);
	put(255, 0, 0, 0);
	put(0, 255, 0, 127);

	const found = commonColors(pixels, options);
	assert.equal(found.length, 2, 'the two clusters, and not the eight shades inside them');
	assert.equal(found[0]?.hex, rgbToHex({ r: 202, g: 40, b: 30 }), 'the largest cluster first, at its own average');
	assert.equal(found[0]?.count, 40);
	near(found[0]?.share ?? 0, 40 / 70, 1e-12, 'share of the opaque pixels: ');
	near(found[1]?.share ?? 0, 24 / 70, 1e-12, 'the cool cluster split across two buckets, one of which was too close to report: ');

	// The same input twice is the same palette: ties are broken by bucket, so a
	// tool that recounts on every click does not shuffle its answers.
	assert.deepEqual(commonColors(pixels, options), found);

	// A fully transparent image has nothing to report, and says so by returning
	// nothing rather than inventing a color from the alpha-zero bytes.
	assert.deepEqual(commonColors(new Uint8ClampedArray(64 * 4), options), []);

	// The minimum distance is what turns "eight shades of one sky" into one color.
	const ramp = new Uint8ClampedArray(8 * 4);
	for (let n = 0; n < 8; n += 1) {
		ramp[n * 4] = 100 + n;
		ramp[n * 4 + 1] = 140 + n;
		ramp[n * 4 + 2] = 190 + n;
		ramp[n * 4 + 3] = 255;
	}
	assert.equal(commonColors(ramp, options).length, 1, 'one blue, counted eight times');
	assert.equal(
		commonColors(ramp, { ...options, minDistance: 0 }).length,
		3,
		// The ramp steps one channel value at a time across 8 pixels, which crosses
		// three of the 4-bit bucket boundaries: with merging off, all three are
		// reported, and that is the whole of what the minimum distance is doing.
		'and more than one when the tool is told not to merge',
	);
	assert.equal(channelDistance({ r: 10, g: 10, b: 10 }, { r: 40, g: 12, b: 9 }), 30, 'the widest channel, not the sum');
});

/* --- printing ------------------------------------------------------------- */

test('each format prints in the syntax that reads it back', () => {
	const color = rgb('#e07a3f');
	assert.equal(formatRgbCss(color), 'rgb(224 122 63)', 'space-separated, as CSS Color 4 writes it');
	// Hand-computed from 224/122/63: hue 22.0°, saturation 0.6314/0.8745, lightness
	// (0.8784 + 0.2471) / 2.
	assert.equal(formatHslCss(rgbToHsl(color)), 'hsl(22.0 72.2% 56.3%)');
	assert.equal(formatHwbCss(rgbToHwb(color)), 'hwb(22.0 24.7% 12.2%)');
	assert.equal(formatHsvText(hsvOf('#e07a3f')), '22.0° 71.9% 87.8%', 'HSV has no CSS function, so it is printed as three numbers');
	assert.equal(formatCmykText(rgbToCmyk(color)), '0% 46% 72% 12%', 'nor does CMYK');
	assert.equal(formatOklchCss(rgbToOklch(color)), 'oklch(68.3% 0.1460 48.5)');
	assert.equal(formatRgbCss({ r: 0, g: 0, b: 0 }), 'rgb(0 0 0)');
	assert.equal(formatOklchCss(rgbToOklch(rgb('#ffffff'))), 'oklch(100.0% 0.0000 0.0)', 'white: no chroma, and no arbitrary hue beside it');
});

test('the read-out is one row per format, in config order, and says which rows are CSS', () => {
	const rows = formatValues(hsvOf('#e07a3f'));
	assert.deepEqual(
		rows.map((row) => row.format),
		[...COLOR_FORMATS],
		'the config decides the order',
	);
	assert.deepEqual(
		rows.map((row) => row.label),
		COLOR_FORMATS.map((format) => COLOR_FORMAT_LABEL[format]),
		'and the labels',
	);
	assert.deepEqual(
		rows.map((row) => [row.format, row.css]),
		[
			['hex', true],
			['rgb', true],
			['hsl', true],
			['hsv', false],
			['cmyk', false],
			['hwb', true],
			['oklch', true],
		],
		'two of the seven are not CSS functions, and the rows say so instead of implying they are',
	);
	assert.equal(rows[0]?.value, '#e07a3f');
	assert.ok(rows.every((row) => row.hint.length > 20), 'every row carries its trade-off');

	assert.equal(
		formatBlock(hsvOf('#e07a3f')),
		[
			'HEX   #e07a3f',
			'RGB   rgb(224 122 63)',
			'HSL   hsl(22.0 72.2% 56.3%)',
			'HSV   22.0° 71.9% 87.8%',
			'CMYK  0% 46% 72% 12%',
			'HWB   hwb(22.0 24.7% 12.2%)',
			'OKLCH oklch(68.3% 0.1460 48.5)',
		].join('\n'),
		'the copied block is the read-out, aligned, with nothing added',
	);
});

/* --- any CSS color -------------------------------------------------------- */

test('the serialised shapes a browser produces are read back, and nothing else is', () => {
	assert.deepEqual(parseCssColorString('rgb(224, 122, 63)'), { rgb: { r: 224, g: 122, b: 63 }, alpha: null }, 'the legacy comma form');
	assert.deepEqual(parseCssColorString('rgb(224 122 63)'), { rgb: { r: 224, g: 122, b: 63 }, alpha: null }, 'and the modern one');
	assert.deepEqual(parseCssColorString('rgba(224, 122, 63, 0.5)'), { rgb: { r: 224, g: 122, b: 63 }, alpha: 0.5 });
	assert.deepEqual(parseCssColorString('rgb(224 122 63 / 50%)'), { rgb: { r: 224, g: 122, b: 63 }, alpha: 0.5 }, 'a slash alpha in percent');
	assert.deepEqual(parseCssColorString('rgb(50% 25% 0%)'), { rgb: { r: 128, g: 64, b: 0 }, alpha: null }, 'percentage channels');
	assert.deepEqual(parseCssColorString('#f80'), { rgb: { r: 255, g: 136, b: 0 }, alpha: null }, 'a canvas normalises to hex');
	assert.deepEqual(parseCssColorString('RGB(1, 2, 3)'), { rgb: { r: 1, g: 2, b: 3 }, alpha: null }, 'the function name is not case-sensitive');
	assert.deepEqual(parseCssColorString('rgb(300, -20, 12)'), { rgb: { r: 255, g: 0, b: 12 }, alpha: null }, 'out-of-range channels are clamped');

	assert.equal(parseCssColorString('rebeccapurple'), null, 'a name is the browser’s job, not this parser’s');
	assert.equal(parseCssColorString('hsl(200 60% 40%)'), null, 'and so is hsl()');
	assert.equal(parseCssColorString('rgb(none 1 2)'), null, 'a missing channel has no honest number');
	assert.equal(parseCssColorString('rgb(1, 2)'), null, 'too few channels');
	assert.equal(parseCssColorString('rgb(1, 2, 3, 4, 5)'), null, 'too many');
	assert.equal(parseCssColorString('rgba(1, 2, 3, x)'), null, 'an alpha that is not a number');
	assert.equal(parseCssColorString(''), null);
	assert.equal(parseCssColorString('not a color'), null);
});

test('the starting colors in config are the colors the tool starts on', () => {
	// The fallbacks inside the module are the same two values written out, so a
	// config typo cannot leave the tool with no color — but they must not drift.
	assert.deepEqual(parseHexColor(TOOL_COLOR_CONFIG.defaultColor)?.rgb, { r: 224, g: 122, b: 63 });
	assert.deepEqual(parseHexColor(TOOL_COLOR_CONFIG.defaultBackground)?.rgb, { r: 255, g: 255, b: 255 });
	assert.equal(describeColor(hsvOf(TOOL_COLOR_CONFIG.defaultColor)), 'an orange', 'the opening color is one its own description agrees with');
	assert.equal(
		TOOL_COLOR_CONFIG.defaultBackground,
		'#ffffff',
		'contrast is checked against white until the visitor says otherwise',
	);
	assert.equal(IMAGE_FILE_CONFIG.maxBytes, 25 * 1024 * 1024, 'the image budget both image-reading tools share');
	assert.equal(IMAGE_FILE_CONFIG.maxSourcePixels, 40_000_000);
});

/* ========================================================================= *
 * The controller, against the DOM shim.
 *
 * The shim's rule is that an unsupported selector THROWS rather than matching
 * nothing, so every query below is a claim that the markup has that hook — and
 * tests/tools-markup.test.ts makes the same claim against the component's real
 * output, which is what stops the two from drifting.
 *
 * The shim has a recording canvas (tests/support/dom.mjs), so the wheel's size,
 * its painted bytes and the marker drawn over them are all assertable. What it
 * cannot do is parse a CSS color name or decode an image; those paths are driven
 * with a fake createImageBitmap here and against jsdom in
 * tests/tools-color-dom.test.ts.
 * ========================================================================= */

import { installTestDom } from './support/dom.mjs';

type Dom = ReturnType<typeof installTestDom>;

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
	style: Record<string, string>;
	width: number;
	height: number;
	files: ImageFile[];
};

type FakeContext = {
	__calls: unknown[][];
	/** What getImageData reports; a test decides what the sampled pixel is. */
	__pixels: number[];
	/** The last ImageData handed to putImageData — the wheel as it was drawn. */
	__lastPut?: { width: number; height: number; data: Uint8ClampedArray };
};

type ShimCanvas = ShimNode & { __context: FakeContext };

type ImageFile = { name: string; type: string; size: number };

type FakeBitmap = { width: number; height: number; close(): void };

/** The color picker's markup, mirroring src/components/tools/ColorPicker.astro. */
const HOOKS: Record<string, string> = {
	'data-color-wheel': 'canvas',
	'data-color-wheel-hint': 'p',
	'data-color-hue': 'input',
	'data-color-saturation': 'input',
	'data-color-value': 'input',
	'data-color-hue-value': 'span',
	'data-color-saturation-value': 'span',
	'data-color-value-value': 'span',
	'data-color-swatch': 'div',
	'data-color-name': 'p',
	'data-color-hex': 'input',
	'data-color-red': 'input',
	'data-color-green': 'input',
	'data-color-blue': 'input',
	'data-color-css': 'input',
	'data-color-scheme': 'select',
	'data-color-scheme-hint': 'p',
	'data-color-scheme-list': 'div',
	'data-color-palette-list': 'div',
	'data-color-palette-empty': 'p',
	'data-color-palette-count': 'span',
	'data-color-palette-add': 'button',
	'data-color-palette-copy': 'button',
	'data-color-palette-clear': 'button',
	'data-color-formats': 'div',
	'data-color-formats-copy': 'button',
	'data-color-contrast-bg': 'input',
	'data-color-contrast-ratio': 'span',
	'data-color-contrast-sentence': 'span',
	'data-color-contrast-verdicts': 'div',
	'data-color-contrast-sample': 'div',
	'data-color-contrast-swap': 'button',
	'data-color-image-drop': 'label',
	'data-color-image-input': 'input',
	'data-color-image-preview': 'canvas',
	'data-color-image-meta': 'p',
	'data-color-image-hint': 'p',
	'data-color-image-clear': 'button',
	'data-color-common-list': 'div',
	'data-color-copy': 'button',
	'data-color-reset': 'button',
	'data-color-status': 'p',
	'data-color-error': 'p',
};

function buildTool(dom: Dom): void {
	const { document } = dom;
	const section = document.createElement('section');
	section.setAttribute('data-color-picker', '');
	for (const [hook, tag] of Object.entries(HOOKS)) {
		const element = document.createElement(tag);
		element.setAttribute(hook, '');
		section.appendChild(element);
	}
	document.body.appendChild(section);
	/*
	 * The controls the controller reads defaults from, and the elements the
	 * component renders as hidden or disabled. A fixture without these would
	 * silently test the fallbacks instead of the markup.
	 */
	node(dom, '[data-color-error]').hidden = true;
	node(dom, '[data-color-image-preview]').hidden = true;
	node(dom, '[data-color-image-clear]').hidden = true;
	node(dom, '[data-color-common-list]').hidden = true;
	node(dom, '[data-color-scheme]').value = 'complement';
	node(dom, '[data-color-palette-copy]').disabled = true;
	node(dom, '[data-color-palette-clear]').disabled = true;
	node(dom, '[data-color-contrast-bg]').value = TOOL_COLOR_CONFIG.defaultBackground;
}

type Harness = { dom: Dom; canvases: ShimCanvas[] };

/** Install the shim, build the fixture, init the controller, and always tear down. */
async function withTool(run: (harness: Harness) => void | Promise<void>): Promise<void> {
	const dom = installTestDom();
	// Every canvas the tool creates is captured, because the one that matters most
	// — the 1×1 scratch a single pixel is read through — is never in the document.
	const canvases: ShimCanvas[] = [];
	const create = dom.document.createElement.bind(dom.document);
	dom.document.createElement = (tag: string) => {
		const element = create(tag) as unknown as ShimCanvas;
		if (tag === 'canvas') canvases.push(element);
		return element as unknown as ReturnType<typeof create>;
	};
	buildTool(dom);
	const { initColorPicker, destroyColorPicker } = await import('../src/scripts/tools-color.ts');
	initColorPicker();
	try {
		await run({ dom, canvases });
	} finally {
		destroyColorPicker();
		dom.uninstall();
	}
}

/** The 1×1 canvas the tool samples pixels and parses CSS colors through. */
function scratchCanvas(canvases: ShimCanvas[]): ShimCanvas {
	const found = canvases.find((canvas) => canvas.width === 1 && canvas.height === 1);
	assert.ok(found, 'the tool never created its 1×1 scratch canvas');
	return found;
}

const fire = (
	element: { dispatchEvent: (event: Record<string, unknown>) => unknown } | null,
	type: string,
	extra: Record<string, unknown> = {},
): unknown => {
	assert.ok(element, `nothing to fire ${type} at`);
	return element.dispatchEvent({ type, preventDefault: () => {}, ...extra });
};

function node(dom: Dom, selector: string): ShimNode {
	const found = dom.q(selector) as ShimNode | null;
	assert.ok(found, `the fixture has no ${selector}`);
	return found;
}

function nodes(dom: Dom, selector: string): ShimNode[] {
	return dom.qAll(selector) as ShimNode[];
}

const status = (dom: Dom): string => node(dom, '[data-color-status]').textContent;
const errorOf = (dom: Dom): string => node(dom, '[data-color-error]').textContent;
const hexOf = (dom: Dom): string => node(dom, '[data-color-hex]').value;
const nameOf = (dom: Dom): string => node(dom, '[data-color-name]').textContent;
const swatchOf = (dom: Dom): string => node(dom, '[data-color-swatch]').style.background;
const ratioOf = (dom: Dom): string => node(dom, '[data-color-contrast-ratio]').textContent;
const formatValue = (dom: Dom, format: string): string =>
	node(dom, `[data-color-formats] .tool__color-format[data-format="${format}"] .tool__color-format-value`)
		.textContent;
const badges = (dom: Dom): { verdict: string; pass: string; text: string }[] =>
	nodes(dom, '[data-color-contrast-verdicts] .tool__color-badge').map((badge) => ({
		verdict: badge.dataset.verdict ?? '',
		pass: badge.dataset.pass ?? '',
		text: badge.textContent,
	}));
const schemeSwatches = (dom: Dom): ShimNode[] =>
	nodes(dom, '[data-color-scheme-list] .tool__color-swatch');
const paletteSwatches = (dom: Dom): ShimNode[] =>
	nodes(dom, '[data-color-palette-list] .tool__color-swatch');
const paletteRemovals = (dom: Dom): ShimNode[] =>
	nodes(dom, '[data-color-palette-list] .tool__color-mini');
const commonSwatches = (dom: Dom): ShimNode[] =>
	nodes(dom, '[data-color-common-list] .tool__color-swatch');

/** Put a value in a control and tell the tool about it, as a visitor would. */
function type(dom: Dom, selector: string, value: string, event = 'input'): void {
	const target = node(dom, selector);
	target.value = value;
	fire(target as unknown as Parameters<typeof fire>[0], event);
}

const click = (dom: Dom, selector: string): unknown =>
	fire(node(dom, selector) as unknown as Parameters<typeof fire>[0], 'click');

/** Swap the global navigator for one with a clipboard, and put it back after. */
function withClipboard(clipboard: unknown): () => void {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
	Object.defineProperty(globalThis, 'navigator', { value: { clipboard }, configurable: true });
	return () => {
		if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
		else delete (globalThis as { navigator?: unknown }).navigator;
	};
}

/** Give the shim a createImageBitmap, and take it away afterwards. */
function withImageDecode(decode: (file: ImageFile) => Promise<FakeBitmap>): () => void {
	Object.defineProperty(globalThis, 'createImageBitmap', { value: decode, configurable: true });
	return () => {
		delete (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
	};
}

const imageFile = (name: string, type = 'image/png', size = 4096): ImageFile => ({ name, type, size });

/** A decoded image whose pixels the test decides, through the shim's canvas. */
function bitmap(width: number, height: number): FakeBitmap & { closed: boolean } {
	const fake = {
		width,
		height,
		closed: false,
		close() {
			fake.closed = true;
		},
	};
	return fake;
}

/* --- first paint ---------------------------------------------------------- */

test('with no tool on the page, init does nothing and destroy is safe', async () => {
	const dom = installTestDom();
	const { initColorPicker, destroyColorPicker } = await import('../src/scripts/tools-color.ts');
	initColorPicker();
	assert.equal(dom.q('[data-color-status]'), null, 'the fixture was never built');
	destroyColorPicker();
	dom.uninstall();
});

test('the tool opens on the configured color, with every surface already agreeing', async () => {
	await withTool(({ dom }) => {
		assert.equal(hexOf(dom), TOOL_COLOR_CONFIG.defaultColor);
		assert.equal(swatchOf(dom), TOOL_COLOR_CONFIG.defaultColor, 'the swatch is the same color the field says');
		assert.equal(nameOf(dom), 'an orange');
		assert.equal(node(dom, '[data-color-red]').value, '224');
		assert.equal(node(dom, '[data-color-green]').value, '122');
		assert.equal(node(dom, '[data-color-blue]').value, '63');
		assert.equal(node(dom, '[data-color-hue]').value, '22', 'the slider is at the hue, not at its markup default');
		assert.equal(node(dom, '[data-color-hue-value]').textContent, '22°');
		assert.equal(node(dom, '[data-color-saturation-value]').textContent, '72%');
		assert.equal(node(dom, '[data-color-value-value]').textContent, '88%');
		assert.equal(formatValue(dom, 'hex'), TOOL_COLOR_CONFIG.defaultColor);
		assert.equal(formatValue(dom, 'oklch'), 'oklch(68.3% 0.1460 48.5)');
		assert.equal(nodes(dom, '[data-color-formats] .tool__color-format').length, COLOR_FORMATS.length);
		assert.equal(
			node(dom, '[data-color-palette-count]').textContent,
			`0 of ${TOOL_COLOR_CONFIG.maxPaletteEntries}`,
		);
		assert.equal(node(dom, '[data-color-palette-empty]').hidden, false, 'an empty palette says so');
		assert.equal(node(dom, '[data-color-palette-copy]').disabled, true, 'and there is nothing to copy');
		assert.equal(schemeSwatches(dom).length, 2, 'the default scheme is the complement: two colors');
		assert.equal(
			node(dom, '[data-color-scheme-hint]').textContent,
			COLOR_SCHEME_HINT.complement,
			'the hint is the config copy for the scheme that is selected',
		);
		assert.match(status(dom), /^Pick a color: drag the wheel, type a hex, or drop an image/);
		assert.match(status(dom), /#e07a3f, an orange/, 'the opening line says what color it opened on');
		assert.match(status(dom), /Nothing leaves this tab\.$/);
		assert.equal(errorOf(dom), '', 'nothing has gone wrong yet');
		assert.equal(node(dom, '[data-color-error]').hidden, true);
	});
});

test('contrast is measured against white before the visitor says otherwise', async () => {
	await withTool(({ dom }) => {
		assert.equal(node(dom, '[data-color-contrast-bg]').value, '#ffffff');
		/*
		 * The opening color on white is 2.99:1 — a hair under the 3:1 AA wants for
		 * large text. The tool opens on a failing pair and says so on first paint,
		 * which is a better first impression than a green badge it has not earned.
		 */
		assert.equal(ratioOf(dom), '2.99:1');
		assert.equal(ratioOf(dom), formatContrast(contrastRatio(rgb('#e07a3f'), rgb('#ffffff'))));
		assert.deepEqual(
			badges(dom).map((badge) => [badge.verdict, badge.pass]),
			[
				['aaNormal', 'false'],
				['aaLarge', 'false'],
				['aaaNormal', 'false'],
				['aaaLarge', 'false'],
			],
			'and every threshold says fail',
		);
		for (const badge of badges(dom)) {
			assert.match(badge.text, /pass|fail/, 'the word is in the badge, not only its color');
			assert.match(badge.text, /:1$/, 'and so is the threshold it was measured against');
		}
		assert.match(
			node(dom, '[data-color-contrast-sentence]').textContent,
			/^2\.99:1 — below every WCAG threshold, for any text size\.$/,
		);
		const sample = node(dom, '[data-color-contrast-sample]');
		assert.equal(sample.style.color, '#e07a3f');
		assert.equal(sample.style.background, '#ffffff');
	});
});

test('the wheel is drawn to its element at the backing size, with the marker over the pixels', async () => {
	await withTool(({ dom, canvases }) => {
		const wheel = node(dom, '[data-color-wheel]') as unknown as ShimCanvas;
		// The shim's element is 320×152, so the wheel takes the smaller edge, at a
		// ratio of 1: the size is the element's, not a constant in the module.
		assert.equal(wheel.width, 152);
		assert.equal(wheel.height, 152);
		const calls = wheel.__context.__calls.map((call) => call[0]);
		assert.ok(calls.includes('createImageData'), 'the wheel is painted per pixel');
		assert.ok(calls.includes('putImageData'));
		assert.ok(
			calls.lastIndexOf('stroke') > calls.lastIndexOf('putImageData'),
			'the marker is drawn after the pixels, because putImageData replaces rather than composites',
		);
		const strokes = wheel.__context.__calls.filter((call) => call[0] === 'stroke');
		assert.equal(strokes.length, 2, 'two rings, so the marker reads on any color');
		assert.deepEqual(
			strokes.map((stroke) => stroke[1]),
			['rgba(0, 0, 0, 0.72)', '#ffffff'],
			'dark under light — not a theme token, because the wheel shows the same colors in both themes',
		);
		const put = wheel.__context.__lastPut;
		assert.ok(put, 'something was drawn');
		assert.equal(put.width, 152);
		// The pixel just inside the rim at three o'clock is red, scaled by the
		// current brightness: that one number is the wheel, the value slider and the
		// per-pixel paint agreeing.
		const rim = (76 * 152 + 150) * 4;
		assert.ok((put.data[rim] as number) > 200, `red at the rim, got ${put.data[rim]}`);
		assert.ok((put.data[rim + 1] as number) < 60, `and not much green, got ${put.data[rim + 1]}`);
		assert.equal(scratchCanvas(canvases).width, 1, 'the scratch canvas a pixel is read through is 1×1');
	});
});

test('brightness repaints the wheel darker, without rebuilding it or compounding', async () => {
	await withTool(({ dom }) => {
		const wheel = node(dom, '[data-color-wheel]') as unknown as ShimCanvas;
		// The centre of the wheel is white at full value, so its red channel IS the
		// brightness the wheel was painted at.
		const centre = () => wheel.__context.__lastPut?.data[(76 * 152 + 76) * 4] as number;
		const creates = () =>
			wheel.__context.__calls.filter((call) => call[0] === 'createImageData').length;
		const atStart = centre();
		assert.ok(atStart > 200 && atStart < 255, `the opening brightness, got ${atStart}`);
		const createsBefore = creates();

		type(dom, '[data-color-value]', '50');
		assert.equal(centre(), 128, 'value is applied to the full-value buffer, so half is half of 255');
		assert.equal(creates(), createsBefore + 1, 'one repaint…');
		assert.equal(
			wheel.width,
			152,
			'…and no new backing store: the hue/saturation picture is cached by size',
		);

		type(dom, '[data-color-value]', '100');
		assert.equal(centre(), 255, 'back to full, exactly: scaling the same buffer does not compound');
		type(dom, '[data-color-value]', '0');
		assert.equal(centre(), 0, 'and value 0 is black');

		type(dom, '[data-color-value]', String(Math.round(hsvOf('#e07a3f').v * 100)));
		assert.equal(node(dom, '[data-color-value-value]').textContent, '88%');
		assert.equal(hexOf(dom), '#e07a3f', 'the color follows the slider back to where it started');
	});
});

test('the wheel answers a drag, and a drag past the rim keeps the hue it had', async () => {
	await withTool(({ dom }) => {
		const wheel = node(dom, '[data-color-wheel]') as unknown as ShimCanvas;
		// At full brightness, so the color a drag produces is the wheel's own and
		// not that color scaled by whatever value was already set.
		type(dom, '[data-color-value]', '100');

		/*
		 * The shim's element is 320×152 on screen with a 152×152 backing store, so
		 * every pointer position is converted on its way in: clientX 240 is x 114 of
		 * the store, which is halfway out at three o'clock. These four positions are
		 * the wheel's whole claim — angle is hue, distance is saturation, the rim is
		 * the fullest color, and a drag that overshoots is clamped rather than lost.
		 */
		const drag = (clientX: number, clientY: number, buttons = 1) =>
			fire(wheel as unknown as Parameters<typeof fire>[0], 'pointermove', {
				clientX,
				clientY,
				buttons,
				pointerId: 1,
			});

		fire(wheel as unknown as Parameters<typeof fire>[0], 'pointerdown', {
			clientX: 1000,
			clientY: 76,
			buttons: 1,
			pointerId: 1,
		});
		assert.equal(hexOf(dom), '#ff0000', 'far past the rim at three o’clock: clamped to red at full saturation');
		assert.match(status(dom), /^Color set from the wheel: #ff0000, a vivid red\./);

		drag(240, 76);
		assert.equal(
			hexOf(dom),
			rgbToHex(hsvToRgb({ h: 0, s: 0.5, v: 1 })),
			'halfway out along the same angle is the same hue with half as much color',
		);

		drag(160, 152);
		assert.equal(hexOf(dom), '#80ff00', 'six o’clock on the rim is 90°: chartreuse');

		drag(400, 400, 0);
		assert.equal(hexOf(dom), '#80ff00', 'a hover with no button held does not repaint the color');
	});
});

/* --- typing --------------------------------------------------------------- */

test('a hex rewrites every other surface, and does not fight the field it came from', async () => {
	await withTool(({ dom }) => {
		type(dom, '[data-color-hex]', '#00ff00');
		assert.equal(hexOf(dom), '#00ff00', 'the field keeps what was typed…');
		type(dom, '[data-color-hex]', '#00ff80');
		assert.equal(hexOf(dom), '#00ff80', '…even when it is not the canonical form yet');
		assert.equal(node(dom, '[data-color-red]').value, '0');
		assert.equal(node(dom, '[data-color-green]').value, '255');
		assert.equal(node(dom, '[data-color-blue]').value, '128');
		assert.equal(node(dom, '[data-color-hue]').value, '150');
		assert.equal(node(dom, '[data-color-saturation]').value, '100');
		assert.equal(nameOf(dom), 'a vivid spring green');
		assert.equal(swatchOf(dom), '#00ff80');
		assert.equal(formatValue(dom, 'rgb'), 'rgb(0 255 128)');
		assert.equal(formatValue(dom, 'hex'), '#00ff80');
		assert.match(status(dom), /^Color set from the hex field: #00ff80, a vivid spring green\./);
		assert.equal(node(dom, '[data-color-error]').hidden, true);

		// Moving the sliders then writes the canonical hex back, because no field is
		// being typed in any more.
		type(dom, '[data-color-hue]', '180');
		assert.equal(hexOf(dom), '#00ffff', 'a change from elsewhere does rewrite the hex field');
	});
});

test('a hex that is not a hex is refused out loud, and changes nothing', async () => {
	await withTool(({ dom }) => {
		type(dom, '[data-color-hex]', '#e07a3f');
		type(dom, '[data-color-hex]', 'banana');
		assert.equal(errorOf(dom), '“banana” is not a hex color. It takes 3, 4, 6 or 8 hex digits, with or without the leading #.');
		assert.equal(node(dom, '[data-color-error]').hidden, false);
		assert.equal(hexOf(dom), 'banana', 'what they typed stays on screen, so they can fix it');
		assert.equal(node(dom, '[data-color-red]').value, '224', 'and the color did not move');
		assert.equal(swatchOf(dom), '#e07a3f');

		type(dom, '[data-color-hex]', '#12345');
		assert.match(errorOf(dom), /^“#12345” is not a hex color\./);

		type(dom, '[data-color-hex]', '#123456');
		assert.equal(node(dom, '[data-color-error]').hidden, true, 'a good value clears the refusal');
		assert.equal(hexOf(dom), '#123456');
	});
});

test('an alpha channel is read, dropped, and reported rather than ignored', async () => {
	await withTool(({ dom }) => {
		type(dom, '[data-color-hex]', '#00ff0080');
		assert.equal(hexOf(dom), '#00ff0080');
		assert.equal(node(dom, '[data-color-green]').value, '255', 'the color channels were read');
		assert.equal(swatchOf(dom), '#00ff00');
		assert.match(
			status(dom),
			/The alpha channel \(50%\) was dropped — this picker works in opaque sRGB\./,
			'half of 255 is 50%, and the sentence says what happened to it',
		);

		type(dom, '[data-color-hex]', '#00ff00ff');
		assert.doesNotMatch(status(dom), /alpha channel/, 'a fully opaque alpha is not a thing to report');
	});
});

test('the RGB channels set the color, and an out-of-range channel is clamped not refused', async () => {
	await withTool(({ dom }) => {
		type(dom, '[data-color-red]', '10');
		assert.equal(hexOf(dom), '#0a7a3f');
		assert.equal(node(dom, '[data-color-red]').value, '10', 'the channel being typed is not rewritten');
		assert.equal(node(dom, '[data-color-green]').value, '122', 'the other two follow the color');

		type(dom, '[data-color-green]', '300');
		assert.equal(node(dom, '[data-color-green]').value, '300', 'what was typed stays, so it can be corrected');
		assert.equal(hexOf(dom), '#0aff3f', 'and the color read it as 255');

		type(dom, '[data-color-blue]', '-20');
		assert.equal(hexOf(dom), '#0aff00');
		type(dom, '[data-color-blue]', '');
		assert.equal(hexOf(dom), '#0aff00', 'an empty channel holds the value it had rather than becoming 0');
		assert.match(status(dom), /^Color set from the RGB channels: /);
	});
});

test('desaturating with the slider keeps the hue, so the wheel does not jump to red', async () => {
	await withTool(({ dom }) => {
		type(dom, '[data-color-hue]', '200');
		type(dom, '[data-color-saturation]', '0');
		assert.equal(
			hexOf(dom),
			'#e0e0e0',
			'no saturation is a grey at the current brightness, which is 88% of 255',
		);
		assert.equal(node(dom, '[data-color-hue]').value, '200', 'and the hue the visitor chose is still there');
		assert.equal(node(dom, '[data-color-hue-value]').textContent, '200°');
		assert.equal(nameOf(dom), 'a grey');

		type(dom, '[data-color-saturation]', '100');
		assert.equal(
			hexOf(dom),
			rgbToHex(hsvToRgb({ h: 200, s: 1, v: 224 / 255 })),
			'raising the saturation brings back the color they were on, not red',
		);
		assert.equal(node(dom, '[data-color-hue]').value, '200');
	});
});

test('the CSS color field reads what this browser can parse, and says so when it cannot', async () => {
	await withTool(({ dom }) => {
		type(dom, '[data-color-css]', 'rgb(18, 52, 86)', 'change');
		assert.equal(hexOf(dom), '#123456');
		assert.match(status(dom), /^Color set from the CSS color field: #123456/);
		assert.equal(node(dom, '[data-color-css]').value, 'rgb(18, 52, 86)', 'what was typed is left alone');

		type(dom, '[data-color-css]', 'rgba(255, 0, 0, 0.25)', 'change');
		assert.equal(hexOf(dom), '#ff0000');
		assert.match(status(dom), /The alpha channel \(25%\) was dropped/);

		/*
		 * A name is refused HERE because the shim has no CSS parser — which is the
		 * honest behavior for a browser that cannot read the value either. jsdom can
		 * parse one, and tests/tools-color-dom.test.ts asserts that it is accepted.
		 */
		type(dom, '[data-color-hex]', '#123456');
		type(dom, '[data-color-css]', 'rebeccapurple', 'change');
		assert.equal(
			errorOf(dom),
			'“rebeccapurple” is not a color this browser can read. Try a hex, rgb(), hsl(), oklch(), or a CSS color name.',
		);
		assert.equal(hexOf(dom), '#123456', 'and the color did not move');

		type(dom, '[data-color-css]', '', 'change');
		assert.equal(hexOf(dom), '#123456', 'clearing the field is not a color, and is not a refusal either');
	});
});

/* --- copying -------------------------------------------------------------- */

test('every format row has its own copy button, named for the value it copies', async () => {
	const written: string[] = [];
	const restore = withClipboard({
		writeText: async (value: string) => {
			written.push(value);
		},
	});
	try {
		await withTool(async ({ dom }) => {
			const buttons = nodes(dom, '[data-color-formats] .tool__color-mini');
			assert.equal(buttons.length, COLOR_FORMATS.length);
			const labels = buttons.map(
				(button) =>
					(button as unknown as { getAttribute?: (name: string) => string | null }).getAttribute?.(
						'aria-label',
					) ?? '',
			);
			assert.match(labels[0] ?? '', /^Copy the HEX value, #e07a3f$/);
			assert.match(labels[6] ?? '', /^Copy the OKLCH value, oklch\(68\.3% 0\.1460 48\.5\)$/);
			assert.match(
				labels[4] ?? '',
				/^Copy the CMYK value, 0% 46% 72% 12% — not a CSS function$/,
				'the two formats CSS cannot read say so in the name, not only in the hint',
			);

			fire(buttons[2] as unknown as Parameters<typeof fire>[0], 'click');
			await dom.settle();
			assert.deepEqual(written, ['hsl(22.0 72.2% 56.3%)'], 'the row copies its own value');
			assert.equal(status(dom), 'Copied the HSL value: hsl(22.0 72.2% 56.3%).');

			// The value is read at click time, so moving the color first changes what
			// the same button copies — a closure over the row as it was built would
			// have copied the color the tool opened on.
			type(dom, '[data-color-hex]', '#000000');
			fire(buttons[2] as unknown as Parameters<typeof fire>[0], 'click');
			await dom.settle();
			assert.equal(written[1], 'hsl(0.0 0.0% 0.0%)');
		});
	} finally {
		restore();
	}
});

test('copy hex and copy every format put the read-out on the clipboard, and only say so when it landed', async () => {
	const written: string[] = [];
	const restore = withClipboard({
		writeText: async (value: string) => {
			written.push(value);
		},
	});
	try {
		await withTool(async ({ dom }) => {
			click(dom, '[data-color-copy]');
			await dom.settle();
			assert.deepEqual(written, ['#e07a3f']);
			assert.equal(status(dom), 'Copied the hex color: #e07a3f.');
			assert.equal(node(dom, '[data-color-error]').hidden, true);

			click(dom, '[data-color-formats-copy]');
			await dom.settle();
			assert.equal(written.length, 2);
			assert.equal(written[1], formatBlock(hsvOf('#e07a3f')), 'the block is the read-out, and nothing else');
			assert.match(status(dom), /^Copied the color in every format: HEX/);
		});
	} finally {
		restore();
	}
});

test('a copy that could not happen says which kind of could-not', async () => {
	// No clipboard API at all — which is what a browser outside a secure context
	// has — is not a failed copy, and is not reported as one.
	await withTool(async ({ dom }) => {
		click(dom, '[data-color-copy]');
		await dom.settle();
		assert.match(
			errorOf(dom),
			/^This browser has no clipboard API \(it needs a secure context\), so nothing was copied\./,
		);
		assert.match(errorOf(dom), /selectable by hand/, 'and points at what still works');
		assert.doesNotMatch(status(dom), /Copied/, 'the status line never claims a copy that did not happen');
	});

	const restore = withClipboard({
		writeText: async () => {
			throw new Error('denied');
		},
	});
	try {
		await withTool(async ({ dom }) => {
			click(dom, '[data-color-copy]');
			await dom.settle();
			assert.match(errorOf(dom), /^The clipboard refused the copy, so nothing was copied\./);
			assert.doesNotMatch(status(dom), /Copied/);
		});
	} finally {
		restore();
	}
});

/* --- schemes -------------------------------------------------------------- */

test('changing the scheme rebuilds its swatches, and choosing one makes it the color', async () => {
	await withTool(({ dom }) => {
		assert.deepEqual(
			schemeSwatches(dom).map((entry) => entry.dataset.hex),
			['#e07a3f', '#3fa5e0'],
			'the complement of the opening color',
		);

		type(dom, '[data-color-scheme]', 'triadic', 'change');
		assert.deepEqual(
			schemeSwatches(dom).map((entry) => entry.dataset.hex),
			['#e07a3f', '#3fe07a', '#7a3fe0'],
		);
		assert.deepEqual(
			schemeSwatches(dom).map((entry) => entry.dataset.role),
			['Base', 'Triad +120°', 'Triad +240°'],
			'each swatch knows the part it plays, which is what its name says',
		);
		assert.match(status(dom), /^Triadic — three equal steps: /, 'the announcement names the scheme and its trade-off');
		assert.match(
			node(dom, '[data-color-scheme-hint]').textContent,
			/^Three colors 120° apart\./,
		);

		type(dom, '[data-color-scheme]', 'monochrome', 'change');
		const swatches = schemeSwatches(dom);
		assert.equal(swatches.length, 5);
		assert.equal(swatches[2]?.dataset.hex, '#e07a3f', 'the base of the ramp is the color on screen');
		assert.equal(swatches[0]?.dataset.role, 'Tint 60%');
		assert.equal(swatches[4]?.dataset.role, 'Shade 60%');

		fire(swatches[4] as unknown as Parameters<typeof fire>[0], 'click');
		assert.equal(hexOf(dom), rgbToHex(shade(rgb('#e07a3f'), 0.6)), 'choosing a swatch sets that color');
		assert.match(status(dom), /^Color set from the shade 60% swatch: /);

		// An unknown value from a select that was not built by this page is not
		// trusted: it falls back to the first scheme rather than drawing nothing.
		type(dom, '[data-color-scheme]', 'nonsense', 'change');
		assert.equal(schemeSwatches(dom).length, 2);
		assert.equal(node(dom, '[data-color-scheme-hint]').textContent, COLOR_SCHEME_HINT.complement);
	});
});

test('scheme swatches follow the color, and are rebuilt only when the scheme changes', async () => {
	await withTool(({ dom }) => {
		type(dom, '[data-color-scheme]', 'square', 'change');
		const before = schemeSwatches(dom);
		assert.equal(before.length, 4);

		type(dom, '[data-color-hex]', '#00ff00');
		const after = schemeSwatches(dom);
		assert.deepEqual(
			after.map((entry) => entry.dataset.hex),
			schemeColors(hsvOf('#00ff00'), 'square').map((entry) => entry.hex),
			'the same four buttons, recolored: 120°, then 210°, 300° and 30°',
		);
		assert.deepEqual(
			after.map((entry) => entry.dataset.hex),
			['#00ff00', '#0080ff', '#ff00ff', '#ff8000'],
		);
		assert.deepEqual(
			after.map((entry) => entry.dataset.role),
			before.map((entry) => entry.dataset.role),
			'a color change does not rebuild the scheme',
		);
	});
});

/* --- contrast ------------------------------------------------------------- */

test('the background field re-measures the pair, and swap turns it round', async () => {
	await withTool(({ dom }) => {
		type(dom, '[data-color-contrast-bg]', '#000000', 'change');
		assert.equal(node(dom, '[data-color-contrast-bg]').value, '#000000');
		assert.equal(ratioOf(dom), formatContrast(contrastRatio(rgb('#e07a3f'), rgb('#000000'))));
		assert.match(status(dom), /^Contrast against #000000: /);
		assert.equal(node(dom, '[data-color-contrast-sample]').style.background, '#000000');

		// White on black is the top of the scale, and every threshold passes.
		type(dom, '[data-color-hex]', '#ffffff');
		assert.equal(ratioOf(dom), '21.00:1');
		assert.deepEqual(
			badges(dom).map((badge) => badge.pass),
			['true', 'true', 'true', 'true'],
		);
		assert.match(node(dom, '[data-color-contrast-sentence]').textContent, /AAA passes at every text size/);

		click(dom, '[data-color-contrast-swap]');
		assert.equal(hexOf(dom), '#000000', 'the background became the color…');
		assert.equal(node(dom, '[data-color-contrast-bg]').value, '#ffffff', '…and the color became the background');
		assert.equal(ratioOf(dom), '21.00:1', 'the pair is the same pair, so the ratio is the same ratio');
		assert.match(status(dom), /^Swapped the pair: #000000 on #ffffff — /);

		// A value the browser cannot read leaves the check where it was, and says so.
		type(dom, '[data-color-contrast-bg]', 'not a color', 'change');
		assert.match(errorOf(dom), /^“not a color” is not a color this browser can read, so the contrast is still measured against #ffffff\./);
		assert.equal(ratioOf(dom), '21.00:1');
	});
});

test('a failing pair is described in the words that stop it being shipped', async () => {
	await withTool(({ dom }) => {
		// #777777 on white is 4.48:1 — the ratio one step short of AA for body text,
		// which is the case a badge on its own would let through.
		type(dom, '[data-color-hex]', '#777777');
		assert.equal(ratioOf(dom), '4.48:1');
		assert.deepEqual(
			badges(dom).map((badge) => [badge.verdict, badge.pass]),
			[
				['aaNormal', 'false'],
				['aaLarge', 'true'],
				['aaaNormal', 'false'],
				['aaaLarge', 'false'],
			],
		);
		assert.match(
			node(dom, '[data-color-contrast-sentence]').textContent,
			/^4\.48:1 — AA passes for large text only, so body text needs more contrast\.$/,
		);
		assert.match(badges(dom)[0]?.text ?? '', /AA · normal text — fail at 4\.5:1/);
		assert.match(badges(dom)[1]?.text ?? '', /AA · large text \(24px\+\) — pass at 3:1/);

		type(dom, '[data-color-hex]', '#cccccc');
		assert.deepEqual(
			badges(dom).map((badge) => badge.pass),
			['false', 'false', 'false', 'false'],
		);
		assert.match(
			node(dom, '[data-color-contrast-sentence]').textContent,
			/below every WCAG threshold, for any text size/,
		);
	});
});

/* --- palette -------------------------------------------------------------- */

test('the palette keeps what is added, sets what is chosen, and loses what is removed', async () => {
	await withTool(({ dom }) => {
		assert.equal(paletteSwatches(dom).length, 0);
		assert.equal(node(dom, '[data-color-palette-empty]').hidden, false);

		click(dom, '[data-color-palette-add]');
		assert.equal(status(dom), 'Added #e07a3f to the palette — 1 color.');
		assert.equal(node(dom, '[data-color-palette-count]').textContent, `1 of ${TOOL_COLOR_CONFIG.maxPaletteEntries}`);
		assert.equal(node(dom, '[data-color-palette-empty]').hidden, true);
		assert.equal(node(dom, '[data-color-palette-copy]').disabled, false);

		type(dom, '[data-color-hex]', '#123456');
		click(dom, '[data-color-palette-add]');
		assert.equal(status(dom), 'Added #123456 to the palette — 2 colors.');
		assert.deepEqual(
			paletteSwatches(dom).map((entry) => entry.dataset.hex),
			['#e07a3f', '#123456'],
		);
		assert.deepEqual(
			paletteRemovals(dom).length,
			2,
			'removal is its own button, because a control that needs a pointer hovering to appear is one a keyboard does not have',
		);

		fire(paletteSwatches(dom)[0] as unknown as Parameters<typeof fire>[0], 'click');
		assert.equal(hexOf(dom), '#e07a3f', 'choosing a palette color makes it the current one');
		assert.match(status(dom), /^Color set from palette color 1: /);

		fire(paletteRemovals(dom)[0] as unknown as Parameters<typeof fire>[0], 'click');
		assert.equal(status(dom), 'Removed #e07a3f from the palette — 1 color left.');
		assert.deepEqual(
			paletteSwatches(dom).map((entry) => entry.dataset.hex),
			['#123456'],
		);

		click(dom, '[data-color-palette-clear]');
		assert.equal(status(dom), 'Palette cleared.');
		assert.equal(paletteSwatches(dom).length, 0);
		assert.equal(node(dom, '[data-color-palette-empty]').hidden, false);
		assert.equal(node(dom, '[data-color-palette-clear]').disabled, true);

		// A duplicate is kept: a palette that quietly drops what it was asked to hold
		// has started editing the visitor's work. The current color is #e07a3f,
		// because choosing a swatch above made it so.
		click(dom, '[data-color-palette-add]');
		click(dom, '[data-color-palette-add]');
		assert.equal(paletteSwatches(dom).length, 2);
		assert.deepEqual(
			paletteSwatches(dom).map((entry) => entry.dataset.hex),
			['#e07a3f', '#e07a3f'],
			'the same color twice, because it was asked for twice',
		);
		assert.match(status(dom), /^Added #e07a3f to the palette — 2 colors\./);
	});
});

test('the palette stops at its cap and says why, instead of quietly dropping the color', async () => {
	await withTool(({ dom }) => {
		const { maxPaletteEntries } = TOOL_COLOR_CONFIG;
		for (let index = 0; index < maxPaletteEntries; index += 1) {
			type(dom, '[data-color-hex]', rgbToHex({ r: index, g: 40, b: 80 }));
			click(dom, '[data-color-palette-add]');
		}
		assert.equal(paletteSwatches(dom).length, maxPaletteEntries);
		assert.equal(node(dom, '[data-color-palette-count]').textContent, `${maxPaletteEntries} of ${maxPaletteEntries}`);
		assert.equal(node(dom, '[data-color-palette-add]').disabled, false, 'the button stays live so the refusal can be read');

		type(dom, '[data-color-hex]', '#ffffff');
		click(dom, '[data-color-palette-add]');
		assert.equal(
			errorOf(dom),
			`The palette holds ${maxPaletteEntries} colors and is full, so #ffffff was not added. Remove one first.`,
		);
		assert.equal(paletteSwatches(dom).length, maxPaletteEntries, 'and it was not added');

		fire(paletteRemovals(dom)[0] as unknown as Parameters<typeof fire>[0], 'click');
		click(dom, '[data-color-palette-add]');
		assert.equal(paletteSwatches(dom).length, maxPaletteEntries, 'one out, one in');
		assert.equal(node(dom, '[data-color-error]').hidden, true, 'and the refusal is cleared by the fix');
	});
});

test('the palette copies as CSS custom properties, and refuses to copy nothing', async () => {
	const written: string[] = [];
	const restore = withClipboard({
		writeText: async (value: string) => {
			written.push(value);
		},
	});
	try {
		await withTool(async ({ dom }) => {
			click(dom, '[data-color-palette-copy]');
			await dom.settle();
			assert.deepEqual(written, [], 'nothing was written');
			assert.equal(
				errorOf(dom),
				'The palette is empty, so there was nothing to copy. Add the current color with the button above.',
			);

			click(dom, '[data-color-palette-add]');
			type(dom, '[data-color-hex]', '#123456');
			click(dom, '[data-color-palette-add]');
			click(dom, '[data-color-palette-copy]');
			await dom.settle();
			assert.deepEqual(written, ['--color-1: #e07a3f;\n--color-2: #123456;']);
			assert.equal(status(dom), 'Copied 2 colors as CSS custom properties.');
		});
	} finally {
		restore();
	}
});

/* --- images --------------------------------------------------------------- */

test('a browser that cannot decode images is told, and the rest of the tool still works', async () => {
	await withTool(async ({ dom }) => {
		const files = [imageFile('photo.png')];
		node(dom, '[data-color-image-input]').files = files;
		fire(node(dom, '[data-color-image-input]') as unknown as Parameters<typeof fire>[0], 'change');
		await dom.settle();

		assert.match(
			errorOf(dom),
			/^This browser cannot decode images \(createImageBitmap is unavailable\), so a color cannot be taken from a file\./,
		);
		assert.match(errorOf(dom), /The wheel, the sliders and the hex field all still work\./, 'and what does work is named');
		assert.equal(node(dom, '[data-color-image-preview]').hidden, true, 'nothing was put on screen');

		type(dom, '[data-color-hex]', '#00ff00');
		assert.equal(hexOf(dom), '#00ff00', 'the refusal is about the image, not about the tool');
	});
});

test('a file that is not an image is refused by name, in this tool’s words', async () => {
	const restore = withImageDecode(async () => bitmap(10, 10));
	try {
		await withTool(async ({ dom }) => {
			node(dom, '[data-color-image-input]').files = [imageFile('notes.pdf', 'application/pdf', 2048)];
			fire(node(dom, '[data-color-image-input]') as unknown as Parameters<typeof fire>[0], 'change');
			await dom.settle();
			assert.equal(
				errorOf(dom),
				'“notes.pdf” is not a format this tool reads colors from. It reads PNG, JPEG, WebP, GIF, BMP or AVIF — not PDFs, documents, archives or video.',
			);

			node(dom, '[data-color-image-input]').files = [imageFile('empty.png', 'image/png', 0)];
			fire(node(dom, '[data-color-image-input]') as unknown as Parameters<typeof fire>[0], 'change');
			await dom.settle();
			assert.equal(errorOf(dom), '“empty.png” is empty, so there is nothing to sample.');

			const huge = IMAGE_FILE_CONFIG.maxBytes + 1;
			node(dom, '[data-color-image-input]').files = [imageFile('big.png', 'image/png', huge)];
			fire(node(dom, '[data-color-image-input]') as unknown as Parameters<typeof fire>[0], 'change');
			await dom.settle();
			assert.match(errorOf(dom), /^“big\.png” is 25\.0 MB\. This tool reads files up to 25\.0 MB so decoding cannot exhaust a phone's memory\./);
		});
	} finally {
		restore();
	}
});

test('an image over the decoded-pixel budget is refused before anything is drawn', async () => {
	const restore = withImageDecode(async () => bitmap(7000, 7000));
	try {
		await withTool(async ({ dom }) => {
			node(dom, '[data-color-image-input]').files = [imageFile('enormous.png')];
			fire(node(dom, '[data-color-image-input]') as unknown as Parameters<typeof fire>[0], 'change');
			await dom.settle();
			assert.equal(
				errorOf(dom),
				'“enormous.png” decodes to 7000×7000 (49,000,000 pixels), over this tool’s 40,000,000-pixel source budget.'.replace('tool’s', "tool's"),
			);
			assert.equal(node(dom, '[data-color-image-preview]').hidden, true);
		});
	} finally {
		restore();
	}
});

test('loading an image shows it, counts its colors, and offers them as buttons', async () => {
	const made: (FakeBitmap & { closed: boolean })[] = [];
	const restore = withImageDecode(async () => {
		const fake = bitmap(1200, 800);
		made.push(fake);
		return fake;
	});
	try {
		await withTool(async ({ dom, canvases }) => {
			node(dom, '[data-color-image-input]').files = [imageFile('photo.png', 'image/png', 245_760)];
			fire(node(dom, '[data-color-image-input]') as unknown as Parameters<typeof fire>[0], 'change');
			await dom.settle();

			assert.equal(node(dom, '[data-color-image-preview]').hidden, false);
			assert.equal(node(dom, '[data-color-image-clear]').hidden, false);
			assert.equal(
				node(dom, '[data-color-image-meta]').textContent,
				'photo.png · 1,200×800 · 240.0 KB · shown at 560×373',
				'the file, its real size, its bytes, and the size it is shown at',
			);
			assert.match(
				node(dom, '[data-color-image-hint]').textContent,
				/A keyboard cannot point at a pixel, so the common colors below are the same values as buttons\./,
			);
			const preview = node(dom, '[data-color-image-preview]') as unknown as ShimCanvas;
			assert.deepEqual(fitInside(1200, 800, TOOL_COLOR_CONFIG.sample.previewMaxEdge), {
				width: preview.width,
				height: preview.height,
				scale: 560 / 1200,
			});

			// The scan canvas is the third one the tool created, after the wheel and
			// the preview: it is drawn at the scan size, and its pixels are counted.
			const scan = canvases[canvases.length - 1] as unknown as ShimCanvas;
			assert.equal(scan.width, TOOL_COLOR_CONFIG.sample.scanMaxEdge);
			assert.equal(scan.height, 107, 'the scan keeps the aspect ratio of the file');
			assert.ok(
				scan.__context.__calls.some((call) => call[0] === 'getImageData'),
				'the scan reads pixels back',
			);

			/*
			 * The shim's canvas reports whatever pixels the test put there, and it
			 * defaults to fully transparent — so this first scan honestly found
			 * nothing, and says so rather than inventing a palette.
			 */
			assert.equal(commonSwatches(dom).length, 0);
			assert.equal(node(dom, '[data-color-common-list]').hidden, true);
			assert.match(
				errorOf(dom),
				/^Every pixel of “photo\.png” is transparent, so there is no color in it to count\./,
			);
			assert.match(status(dom), /It has no opaque pixels\.$/);

			/*
			 * The second load gets its own fresh canvases, so the pixels have to be
			 * handed to every canvas the loader creates from here on — one opaque
			 * color, which is one swatch at 100% of the pixels counted.
			 */
			const createCanvas = dom.document.createElement.bind(dom.document);
			dom.document.createElement = (tag: string) => {
				const created = createCanvas(tag);
				if (tag === 'canvas') {
					(created as unknown as ShimCanvas).__context.__pixels = [12, 130, 90, 255];
				}
				return created;
			};

			node(dom, '[data-color-image-input]').files = [imageFile('second.png', 'image/png', 1024)];
			fire(node(dom, '[data-color-image-input]') as unknown as Parameters<typeof fire>[0], 'change');
			await dom.settle();
			const swatches = commonSwatches(dom);
			assert.equal(swatches.length, 1);
			assert.equal(swatches[0]?.dataset.hex, '#0c825a');
			assert.match(swatches[0]?.textContent ?? '', /#0c825a · 100%/, 'the share is printed, so a count is not mistaken for the whole image');
			assert.match(
				status(dom),
				/^Loaded second\.png — 1,200×800, 1\.0 KB\. Click anywhere on it to take that pixel\./,
				'an image with colors in it invites the click',
			);
			assert.equal(node(dom, '[data-color-error]').hidden, true, 'and the transparency refusal is gone');

			// Back to the shim's own createElement: later tests want the scratch
			// canvas they can set pixels on themselves.
			dom.document.createElement = createCanvas;
			assert.equal(made[0]?.closed, true, 'the first image was released when the second was loaded');

			fire(swatches[0] as unknown as Parameters<typeof fire>[0], 'click');
			assert.equal(hexOf(dom), '#0c825a', 'a common color is a button, which is how a keyboard reaches into an image');
			assert.match(status(dom), /^Color set from the common colors in second\.png: #0c825a/);
		});
	} finally {
		restore();
	}
});

test('a pick reads the file’s own pixel, at the coordinate the click maps to', async () => {
	const restore = withImageDecode(async () => bitmap(1200, 800));
	try {
		await withTool(async ({ dom, canvases }) => {
			node(dom, '[data-color-image-input]').files = [imageFile('photo.png')];
			fire(node(dom, '[data-color-image-input]') as unknown as Parameters<typeof fire>[0], 'change');
			await dom.settle();

			const preview = node(dom, '[data-color-image-preview]') as unknown as ShimCanvas;
			const scratch = scratchCanvas(canvases);
			scratch.__context.__pixels = [18, 52, 86, 255];

			/*
			 * The shim's element is 320×152 on screen for a 560×373 preview of a
			 * 1200×800 file, so a click at (32, 19) is the pixel at (120, 100) of the
			 * file: two divisions, and the second is the one that makes it exact.
			 */
			fire(preview as unknown as Parameters<typeof fire>[0], 'pointerdown', {
				clientX: 32,
				clientY: 19,
				buttons: 1,
				pointerId: 1,
			});
			assert.equal(hexOf(dom), '#123456');
			assert.equal(
				status(dom),
				"Took #123456 from photo.png: the pixel at 120, 100 of the file's own 1,200×800, not an average of its neighbours.",
			);
			const draw = scratch.__context.__calls.filter((call) => call[0] === 'drawImage').at(-1);
			assert.deepEqual(
				draw?.slice(1),
				[120, 100, 1, 1, 0, 0, 1, 1],
				'one pixel is drawn out of the decoded image — no full-resolution buffer is ever allocated',
			);
			assert.ok(
				preview.__context.__calls.some((call) => call[0] === 'arc'),
				'and the pick is marked on the preview',
			);

			// A pixel with no alpha has no color of its own, and is not read as black.
			scratch.__context.__pixels = [0, 0, 0, 0];
			fire(preview as unknown as Parameters<typeof fire>[0], 'pointerdown', {
				clientX: 64,
				clientY: 38,
				buttons: 1,
				pointerId: 1,
			});
			assert.equal(hexOf(dom), '#123456', 'the color did not move');
			assert.match(
				errorOf(dom),
				/^That pixel of “photo\.png” is fully transparent, so it has no color of its own/,
			);
			assert.match(errorOf(dom), /Pick an opaque spot\./);

			// A half-transparent pixel is read, and the dropped alpha is reported.
			scratch.__context.__pixels = [255, 0, 0, 128];
			fire(preview as unknown as Parameters<typeof fire>[0], 'pointerdown', {
				clientX: 32,
				clientY: 19,
				buttons: 1,
				pointerId: 1,
			});
			assert.equal(hexOf(dom), '#ff0000');
			assert.match(status(dom), /The alpha channel \(50%\) was dropped — this picker works in opaque sRGB\./);
		});
	} finally {
		restore();
	}
});

test('a pick outside the preview is clamped to the edge of the file, not refused', async () => {
	const restore = withImageDecode(async () => bitmap(1200, 800));
	try {
		await withTool(async ({ dom, canvases }) => {
			node(dom, '[data-color-image-input]').files = [imageFile('photo.png')];
			fire(node(dom, '[data-color-image-input]') as unknown as Parameters<typeof fire>[0], 'change');
			await dom.settle();
			const preview = node(dom, '[data-color-image-preview]') as unknown as ShimCanvas;
			scratchCanvas(canvases).__context.__pixels = [1, 2, 3, 255];

			fire(preview as unknown as Parameters<typeof fire>[0], 'pointerdown', {
				clientX: 10_000,
				clientY: -500,
				buttons: 1,
				pointerId: 1,
			});
			assert.match(status(dom), /the pixel at 1,199 of|the pixel at 1,200 of|the pixel at 0, 799|the pixel at 1,199/, 'a click outside lands on the nearest real pixel');
			assert.match(status(dom), /the pixel at 1,199|the pixel at 1,200|the pixel at 0, 799/);
			assert.equal(hexOf(dom), '#010203');
		});
	} finally {
		restore();
	}
});

test('two images dropped at once: the last one wins, and the loser is closed', async () => {
	const made: (FakeBitmap & { closed: boolean })[] = [];
	const releases: (() => void)[] = [];
	const restore = withImageDecode(
		() =>
			new Promise<FakeBitmap>((resolve) => {
				const fake = bitmap(64, 64);
				made.push(fake);
				releases.push(() => resolve(fake));
			}),
	);
	try {
		await withTool(async ({ dom }) => {
			node(dom, '[data-color-image-input]').files = [imageFile('first.png')];
			fire(node(dom, '[data-color-image-input]') as unknown as Parameters<typeof fire>[0], 'change');
			node(dom, '[data-color-image-input]').files = [imageFile('second.png')];
			fire(node(dom, '[data-color-image-input]') as unknown as Parameters<typeof fire>[0], 'change');
			assert.equal(status(dom), 'Reading second.png…');

			(releases[1] as () => void)();
			await dom.settle();
			(releases[0] as () => void)();
			await dom.settle();

			assert.match(node(dom, '[data-color-image-meta]').textContent ?? '', /^second\.png/, 'the last drop owns the tool');
			assert.doesNotMatch(status(dom), /first\.png/, 'and the first one wrote nothing after losing');
			assert.equal(made[0]?.closed, true, 'the loser’s bitmap is closed, which is the only way its pixels go back');
			assert.equal(made[1]?.closed, false, 'the winner is still on screen');
		});
	} finally {
		restore();
	}
});

test('removing an image, resetting, and leaving the page all release the decoded file', async () => {
	const made: (FakeBitmap & { closed: boolean })[] = [];
	const restore = withImageDecode(async () => {
		const fake = bitmap(400, 300);
		made.push(fake);
		return fake;
	});
	try {
		await withTool(async ({ dom }) => {
			const load = async (name: string) => {
				node(dom, '[data-color-image-input]').files = [imageFile(name)];
				fire(node(dom, '[data-color-image-input]') as unknown as Parameters<typeof fire>[0], 'change');
				await dom.settle();
			};

			await load('one.png');
			click(dom, '[data-color-image-clear]');
			assert.equal(made[0]?.closed, true, 'Remove image releases the bitmap');
			assert.equal(node(dom, '[data-color-image-preview]').hidden, true);
			assert.equal(commonSwatches(dom).length, 0);
			assert.equal(node(dom, '[data-color-image-meta]').textContent, '');
			assert.equal(
				node(dom, '[data-color-image-hint]').textContent,
				'Drop an image, or choose one, to take a color from any pixel of it.',
				'the hint goes back to what it was before a file arrived',
			);

			await load('two.png');
			click(dom, '[data-color-palette-add]');
			type(dom, '[data-color-hex]', '#123456');
			click(dom, '[data-color-reset]');
			assert.equal(made[1]?.closed, true, 'Reset releases it too');
			assert.equal(hexOf(dom), TOOL_COLOR_CONFIG.defaultColor, 'and puts the color back');
			assert.equal(paletteSwatches(dom).length, 0, 'and empties the palette');
			assert.equal(node(dom, '[data-color-contrast-bg]').value, '#ffffff', 'and the background');
			assert.match(status(dom), /^Reset to #e07a3f\. The palette is empty again and any image was released\./);

			await load('three.png');
			dom.document.__fireWindowEvent('pagehide');
			assert.equal(made[2]?.closed, true, 'leaving the page is the last release path');
		});
	} finally {
		restore();
	}
});

test('a drop zone that is dragged over says so, and a dropped file is loaded', async () => {
	const made: (FakeBitmap & { closed: boolean })[] = [];
	const restore = withImageDecode(async () => {
		const fake = bitmap(50, 50);
		made.push(fake);
		return fake;
	});
	try {
		await withTool(async ({ dom }) => {
			const zone = node(dom, '[data-color-image-drop]');
			fire(zone as unknown as Parameters<typeof fire>[0], 'dragover');
			assert.equal(zone.dataset.dragOver, 'true', 'the zone is styled as a target while the file is over it');
			fire(zone as unknown as Parameters<typeof fire>[0], 'dragleave');
			assert.equal(zone.dataset.dragOver, 'false');

			fire(zone as unknown as Parameters<typeof fire>[0], 'drop', {
				dataTransfer: { files: [imageFile('dropped.png')] },
			});
			await dom.settle();
			assert.equal(zone.dataset.dragOver, 'false');
			assert.match(status(dom), /^Loaded dropped\.png/, 'a dropped file is loaded exactly like a chosen one');
			assert.equal(made.length, 1);
			assert.match(
				errorOf(dom),
				/^Every pixel of “dropped\.png” is transparent/,
				'the shim’s canvas reports transparent pixels, and the scan says so instead of guessing a palette',
			);

			fire(zone as unknown as Parameters<typeof fire>[0], 'drop', { dataTransfer: { files: [] } });
			await dom.settle();
			assert.equal(made.length, 1, 'a drop with no file in it is nothing: no decode, no refusal, no load');
			assert.match(status(dom), /^Loaded dropped\.png/, 'and the previous file is still on screen');
		});
	} finally {
		restore();
	}
});

/* --- the environments this tool has to survive ---------------------------- */

test('without a canvas the wheel and the image are given up, with a reason, and the tool still converts', async () => {
	const dom = installTestDom({ canvas2d: false });
	buildTool(dom);
	const { initColorPicker, destroyColorPicker } = await import('../src/scripts/tools-color.ts');
	initColorPicker();
	try {
		assert.equal(node(dom, '[data-color-wheel]').hidden, true, 'an undrawn canvas is removed, not left as an empty square');
		assert.equal(
			node(dom, '[data-color-wheel-hint]').textContent,
			'This browser has no canvas, so the wheel is not drawn. The hue, saturation and brightness sliders below set exactly the same values.',
		);
		assert.equal(
			node(dom, '[data-color-image-hint]').textContent,
			'This browser cannot draw an image into a canvas, so picking a color from a file cannot run here. Everything else on this tool works.',
		);

		// The sliders are the accessible path anyway, so losing the canvas loses a
		// picture and nothing else.
		type(dom, '[data-color-hue]', '240');
		type(dom, '[data-color-saturation]', '100');
		type(dom, '[data-color-value]', '100');
		assert.equal(hexOf(dom), '#0000ff');
		assert.equal(formatValue(dom, 'oklch'), formatOklchCss(rgbToOklch(rgb('#0000ff'))));
		assert.equal(node(dom, '[data-color-name]').textContent, 'a vivid blue');
		assert.equal(ratioOf(dom), formatContrast(contrastRatio(rgb('#0000ff'), rgb('#ffffff'))));

		const restore = withImageDecode(async () => bitmap(50, 50));
		try {
			node(dom, '[data-color-image-input]').files = [imageFile('photo.png')];
			fire(node(dom, '[data-color-image-input]') as unknown as Parameters<typeof fire>[0], 'change');
			await dom.settle();
			assert.match(
				errorOf(dom),
				/^This browser cannot draw an image into a canvas, so there is no surface to take a pixel from\. Nothing was loaded\./,
			);
		} finally {
			restore();
		}
	} finally {
		destroyColorPicker();
		dom.uninstall();
	}
});

test('a resize is settled before the wheel is redrawn, and a theme change repaints it', async () => {
	await withTool(({ dom }) => {
		const wheel = node(dom, '[data-color-wheel]') as unknown as ShimCanvas;
		const puts = () => wheel.__context.__calls.filter((call) => call[0] === 'putImageData').length;
		const before = puts();

		dom.document.__fireWindowEvent('resize');
		dom.advance(TOOL_COLOR_CONFIG.wheel.resizeDebounceMs - 1);
		assert.equal(puts(), before, 'not yet: a drag of the window edge fires this dozens of times a second');

		dom.advance(2);
		assert.equal(puts(), before + 1, 'one repaint once the resize settles');

		dom.document.__fireWindowEvent('resize');
		dom.document.__fireWindowEvent('resize');
		dom.advance(TOOL_COLOR_CONFIG.wheel.resizeDebounceMs + 1);
		assert.equal(puts(), before + 2, 'and a burst of resizes is still one repaint');

		const strokes = () => wheel.__context.__calls.filter((call) => call[0] === 'stroke').length;
		const markerBefore = strokes();
		dom.document.__fireWindowEvent('bnji:themechange');
		assert.equal(strokes(), markerBefore + 2, 'the marker is redrawn when the theme changes');
	});
});

test('destroy releases every listener, and the tool stops answering', async () => {
	const dom = installTestDom();
	buildTool(dom);
	const { initColorPicker, destroyColorPicker } = await import('../src/scripts/tools-color.ts');
	initColorPicker();
	const listeners = dom.listenerCount();
	assert.ok(listeners > 20, `the tool binds its controls: ${listeners} listeners`);

	destroyColorPicker();
	assert.equal(dom.listenerCount(), 0, 'teardown is one abort(), and it took every listener with it');

	type(dom, '[data-color-hex]', '#00ff00');
	assert.equal(hexOf(dom), '#00ff00', 'the field holds what the test put in it…');
	assert.equal(node(dom, '[data-color-red]').value, '224', '…and nothing else moved');
	assert.equal(nameOf(dom), 'an orange');
	assert.equal(swatchOf(dom), TOOL_COLOR_CONFIG.defaultColor);

	// And init can be called again on a fresh subtree, which is what a page that
	// swaps its content without a reload needs.
	initColorPicker();
	type(dom, '[data-color-hex]', '#00ff00');
	assert.equal(hexOf(dom), '#00ff00', 'a second init binds the tool again');
	destroyColorPicker();
	dom.uninstall();
});
