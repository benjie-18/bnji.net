/**
 * BNJI.NET — /projects/tools/ color picker and converter.
 *
 * WHAT THIS IS
 * ------------
 * One colour, held as hue/saturation/value, read out in seven formats; a wheel
 * and three sliders that set it; harmony schemes derived from it; a palette the
 * visitor fills by hand; a WCAG contrast check against a background they choose;
 * and an image they can drop and take an exact pixel from.
 *
 * THE ARITHMETIC IS THE PRODUCT
 * -----------------------------
 * Every conversion here is written out rather than handed to a library, because
 * a colour tool that cannot show its working cannot be checked — and because the
 * site's rule is that dependencies are a deliberate decision, not a default. The
 * formulas are the published ones: sRGB's transfer function and the WCAG 2.x
 * luminance coefficients, Björn Ottosson's OKLab matrices, and the standard
 * HSV/HSL/HWB/CMYK definitions. `tests/tools-color.test.ts` pins them against
 * values from outside this codebase (white and black at 21:1, #767676 on white
 * at 4.54:1, pure red at 4:1, sRGB white at OKLab L = 1) so a typo in a
 * coefficient is a failing test rather than a slightly wrong colour.
 *
 * WHAT IT DOES NOT DO, AND SAYS SO
 * --------------------------------
 *   - No alpha. A hex with an alpha channel, or a transparent pixel taken from
 *     an image, is read and reported as dropped: everything here is opaque sRGB,
 *     and a picker that silently discarded transparency would be lying about the
 *     value it hands back.
 *   - No colour management. A canvas reports sRGB, so a Display-P3 photograph is
 *     converted on the way in and can look a little duller than it does in a
 *     photo app. The note says this instead of pretending the values are the
 *     file's.
 *   - CMYK is derived from RGB. Without an ICC profile there is no honest
 *     inverse, so the four numbers are an approximation and the row says so.
 *   - Contrast is WCAG 2.x relative luminance, not APCA. The verdicts quote the
 *     thresholds they were measured against, and nothing here claims to predict
 *     how a person reads the pair.
 *   - Nothing is stored. The palette lives in memory for the life of the page,
 *     like every other tool here, and a reload starts empty.
 *
 * Like the other tools: no network, no API route, no storage. The only browser
 * APIs reached for are canvas, createImageBitmap and navigator.clipboard, and
 * each one is probed — a browser without it gets the reason on screen, never a
 * silent downgrade.
 */
import {
	COLOR_FORMATS,
	COLOR_FORMAT_HINT,
	COLOR_FORMAT_LABEL,
	COLOR_SCHEME_HINT,
	COLOR_SCHEME_LABEL,
	TOOL_COLOR_CONFIG,
	type ColorFormat,
	type ColorScheme,
} from '../config/tools.config';
import {
	checkDecodedImage,
	checkImageFile,
	COPY_REFUSED,
	COPY_UNAVAILABLE,
	copyText,
	formatBytes,
	formatCount,
	type ImagePurpose,
} from './tools-shared';

/* ------------------------------------------------------------------------- *
 * Types
 *
 * RGB channels are 0–255 integers because that is what a hex string and a
 * canvas pixel both hold. Every other model keeps fractions (0–1) and degrees
 * (0–360) until the moment it is printed, so a conversion never rounds twice.
 * ------------------------------------------------------------------------- */

export type Rgb = { r: number; g: number; b: number };
export type Hsv = { h: number; s: number; v: number };
export type Hsl = { h: number; s: number; l: number };
export type Hwb = { h: number; w: number; b: number };
export type Cmyk = { c: number; m: number; y: number; k: number };
export type Oklch = { l: number; c: number; h: number };

/** What a hex field can hold: the colour, and the alpha this tool drops. */
export type ParsedHex = { rgb: Rgb; alpha: number | null };

/** One row of the converter's read-out. */
export type ColorFormatValue = {
	format: ColorFormat;
	label: string;
	hint: string;
	value: string;
	/** True when `value` is something a browser will accept as a CSS colour. */
	css: boolean;
};

/** One swatch of a scheme, with the role it plays in it. */
export type SchemeColor = { rgb: Rgb; hex: string; role: string };

/** A colour found in an image, and how much of the image it is. */
export type CommonColor = { rgb: Rgb; hex: string; count: number; share: number };

export type ContrastVerdicts = {
	aaNormal: boolean;
	aaLarge: boolean;
	aaaNormal: boolean;
	aaaLarge: boolean;
};

/* ------------------------------------------------------------------------- *
 * Domains
 * ------------------------------------------------------------------------- */

/**
 * A channel is an integer 0–255, and a number outside that range is clamped to it
 * rather than refused: a typed 300 obviously means 255.
 *
 * A number that is not a number at all — a NaN from an empty field, an Infinity
 * from a division that went wrong — is not clamped, because there is nothing to
 * clamp. It becomes 0, the one value that cannot be mistaken for a colour the
 * visitor chose.
 */
export function clampChannel(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(255, Math.max(0, Math.round(value)));
}

/** Saturation, value, lightness and the rest live in 0–1. */
export function clampUnit(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

/**
 * Hue is an angle, so it wraps instead of clamping: 370° is 10°, and −30° is
 * 330°. A scheme that rotates past red has to come back around, not stop.
 */
export function wrapHue(degrees: number): number {
	if (!Number.isFinite(degrees)) return 0;
	const wrapped = degrees % 360;
	// `+ 0` normalises the -0 that `(-360) % 360` produces. It compares equal to 0
	// but is not identical to it, and a hue is printed, compared and used as a
	// marker position — three places a signed zero would be a surprise.
	return wrapped < 0 ? wrapped + 360 : wrapped + 0;
}

/* ------------------------------------------------------------------------- *
 * Hex
 * ------------------------------------------------------------------------- */

/**
 * Read a hex colour: 3, 4, 6 or 8 digits, with or without the leading `#`, in
 * either case. Four and eight digits carry an alpha channel, which is parsed and
 * returned separately — the tool reports it as dropped rather than ignoring it,
 * because `#ff880080` and `#ff8800` are not the same colour and the visitor
 * typed one of them.
 *
 * Returns null for anything that is not a hex colour, including the near misses
 * (`#gg0000`, `#12345`, an empty string) that a tolerant parser would round into
 * a colour the visitor never wrote.
 */
export function parseHexColor(text: string): ParsedHex | null {
	const digits = text.trim().replace(/^#/, '');
	if (digits.length === 0 || !/^[0-9a-fA-F]+$/.test(digits)) return null;
	const length = digits.length;
	if (length !== 3 && length !== 4 && length !== 6 && length !== 8) return null;
	// Shorthand doubles each digit: `#f80` is `#ff8800`, not `#f80000`.
	const size = length <= 4 ? 1 : 2;
	const channel = (index: number): number => {
		const part = digits.slice(index, index + size);
		return Number.parseInt(size === 1 ? part + part : part, 16);
	};
	const hasAlpha = length === 4 || length === 8;
	return {
		rgb: { r: channel(0), g: channel(size), b: channel(size * 2) },
		alpha: hasAlpha ? channel(size * 3) / 255 : null,
	};
}

/** The canonical form this tool prints and copies: lowercase, six digits. */
export function rgbToHex(rgb: Rgb): string {
	const pair = (value: number): string => clampChannel(value).toString(16).padStart(2, '0');
	return `#${pair(rgb.r)}${pair(rgb.g)}${pair(rgb.b)}`;
}

/* ------------------------------------------------------------------------- *
 * HSV — the model the wheel and the sliders drive
 * ------------------------------------------------------------------------- */

/**
 * HSV to RGB. The six sextants of the hue circle, written out: each is a
 * permutation of (chroma, second-largest, 0) lifted by the amount that keeps the
 * darkest channel at zero.
 */
export function hsvToRgb(hsv: Hsv): Rgb {
	const hue = wrapHue(hsv.h);
	const saturation = clampUnit(hsv.s);
	const value = clampUnit(hsv.v);
	const chroma = value * saturation;
	const sextant = hue / 60;
	const second = chroma * (1 - Math.abs((sextant % 2) - 1));
	const lift = value - chroma;
	let triplet: [number, number, number];
	if (sextant < 1) triplet = [chroma, second, 0];
	else if (sextant < 2) triplet = [second, chroma, 0];
	else if (sextant < 3) triplet = [0, chroma, second];
	else if (sextant < 4) triplet = [0, second, chroma];
	else if (sextant < 5) triplet = [second, 0, chroma];
	else triplet = [chroma, 0, second];
	return {
		r: clampChannel((triplet[0] + lift) * 255),
		g: clampChannel((triplet[1] + lift) * 255),
		b: clampChannel((triplet[2] + lift) * 255),
	};
}

/**
 * RGB to HSV.
 *
 * `fallbackHue` is the one piece of interface knowledge in this function, and it
 * is here because the alternative is visibly wrong: a grey has no hue — the
 * formula divides by a zero chroma — so it would report 0° and the wheel marker
 * would jump to red every time the visitor desaturated a colour. Passing the hue
 * the tool already had keeps the marker where the visitor left it, and changes
 * nothing about the colour itself (with saturation at zero, hue cannot affect
 * RGB).
 */
export function rgbToHsv(rgb: Rgb, fallbackHue = 0): Hsv {
	const r = clampChannel(rgb.r) / 255;
	const g = clampChannel(rgb.g) / 255;
	const b = clampChannel(rgb.b) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const chroma = max - min;
	let hue: number;
	if (chroma === 0) hue = wrapHue(fallbackHue);
	else if (max === r) hue = wrapHue(60 * (((g - b) / chroma) % 6));
	else if (max === g) hue = wrapHue(60 * ((b - r) / chroma + 2));
	else hue = wrapHue(60 * ((r - g) / chroma + 4));
	return { h: hue, s: max === 0 ? 0 : chroma / max, v: max };
}

/* ------------------------------------------------------------------------- *
 * The derived models
 * ------------------------------------------------------------------------- */

/** RGB to HSL. Same hue as HSV; lightness is (max + min) / 2, not max. */
export function rgbToHsl(rgb: Rgb): Hsl {
	const r = clampChannel(rgb.r) / 255;
	const g = clampChannel(rgb.g) / 255;
	const b = clampChannel(rgb.b) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const chroma = max - min;
	const lightness = (max + min) / 2;
	/*
	 * The denominator is the "double-cone" width: at L = 0 or 1 there is no room
	 * for chroma, so saturation would divide by zero — which is the honest answer
	 * anyway, since black and white have no saturation to report.
	 */
	const spread = 1 - Math.abs(2 * lightness - 1);
	return {
		h: rgbToHsv(rgb).h,
		s: chroma === 0 || spread === 0 ? 0 : chroma / spread,
		l: lightness,
	};
}

/**
 * RGB to HWB: the same hue, then how much white and how much black is in the
 * colour. Whiteness is the smallest channel and blackness is the complement of
 * the largest, so a grey reports w + b close to 1 — and CSS says that when they
 * reach 1 the colour is grey whatever the hue was.
 */
export function rgbToHwb(rgb: Rgb): Hwb {
	const r = clampChannel(rgb.r) / 255;
	const g = clampChannel(rgb.g) / 255;
	const b = clampChannel(rgb.b) / 255;
	return { h: rgbToHsv(rgb).h, w: Math.min(r, g, b), b: 1 - Math.max(r, g, b) };
}

/**
 * RGB to CMYK, the naive subtraction: black is what is missing from the
 * brightest channel, and the three inks are what is left once black is taken out.
 *
 * This is an approximation, and the row that prints it says so. A real
 * conversion needs an ICC profile for the press and paper in question, which no
 * browser has and no visitor of this tool has told us about; inventing one would
 * produce four confident numbers that a printer would disagree with.
 */
export function rgbToCmyk(rgb: Rgb): Cmyk {
	const r = clampChannel(rgb.r) / 255;
	const g = clampChannel(rgb.g) / 255;
	const b = clampChannel(rgb.b) / 255;
	const k = 1 - Math.max(r, g, b);
	// Pure black: every ink at zero, all of it in K. Without this branch the
	// division below is 0/0 and NaN reaches the screen.
	if (k >= 1) return { c: 0, m: 0, y: 0, k: 1 };
	return { c: (1 - r - k) / (1 - k), m: (1 - g - k) / (1 - k), y: (1 - b - k) / (1 - k), k };
}

/** One sRGB channel (0–1) to linear light, with the toe the standard specifies. */
export function srgbToLinear(channel: number): number {
	const value = clampUnit(channel);
	return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/**
 * RGB to OKLCH via OKLab, using Björn Ottosson's published matrices.
 *
 * OKLab is the reason this format is worth showing: it is perceptually even, so
 * two colours the same distance apart in it look the same distance apart to a
 * person — which sRGB, HSL and HSV all fail at badly (a step in blue looks
 * nothing like a step in yellow). L is lightness 0–1, C is chroma with no upper
 * bound in principle (sRGB colours stay under about 0.37), H is the same kind of
 * hue angle the wheel uses.
 */
export function rgbToOklch(rgb: Rgb): Oklch {
	const r = srgbToLinear(rgb.r / 255);
	const g = srgbToLinear(rgb.g / 255);
	const b = srgbToLinear(rgb.b / 255);

	// Linear sRGB to a cone-response space…
	const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
	const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
	const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

	// …compressed by a cube root, which is most of what makes it perceptual…
	const lRoot = Math.cbrt(l);
	const mRoot = Math.cbrt(m);
	const sRoot = Math.cbrt(s);

	// …then rotated into opponent axes: lightness, red-green, yellow-blue.
	const lightness = 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot;
	const a = 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot;
	const bAxis = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot;

	const chroma = Math.sqrt(a * a + bAxis * bAxis);
	/*
	 * With no chroma there is no hue to report, and the angle atan2 produces from
	 * floating-point dust is arbitrary: white comes out at 89.9°, which is a number
	 * that means nothing and reads like a bug next to a chroma of 0. CSS prints 0
	 * for an achromatic oklch, so this does too.
	 */
	if (chroma < 1e-4) return { l: lightness, c: chroma, h: 0 };
	return { l: lightness, c: chroma, h: wrapHue((Math.atan2(bAxis, a) * 180) / Math.PI) };
}

/* ------------------------------------------------------------------------- *
 * Contrast (WCAG 2.x)
 * ------------------------------------------------------------------------- */

/**
 * WCAG 2.x relative luminance: the three linear-light channels weighted by how
 * much the eye relies on each. The coefficients and the +0.05 in the ratio below
 * are the standard's, not this tool's choices.
 */
export function relativeLuminance(rgb: Rgb): number {
	return (
		0.2126 * srgbToLinear(rgb.r / 255) +
		0.7152 * srgbToLinear(rgb.g / 255) +
		0.0722 * srgbToLinear(rgb.b / 255)
	);
}

/**
 * The contrast ratio, 1:1 (identical luminance) to 21:1 (black on white). The
 * +0.05 on both sides is the standard's model of flare in a real eye looking at a
 * real screen; without it, black on white would be infinite.
 */
export function contrastRatio(foreground: Rgb, background: Rgb): number {
	const one = relativeLuminance(foreground);
	const other = relativeLuminance(background);
	return (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);
}

/** How a ratio measures against the four WCAG thresholds this tool quotes. */
export function contrastVerdicts(ratio: number): ContrastVerdicts {
	const { aaNormal, aaLarge, aaaNormal, aaaLarge } = TOOL_COLOR_CONFIG.contrast;
	return {
		aaNormal: ratio >= aaNormal,
		aaLarge: ratio >= aaLarge,
		aaaNormal: ratio >= aaaNormal,
		aaaLarge: ratio >= aaaLarge,
	};
}

/** "4.53:1" — two decimals, which is the precision the thresholds are quoted at. */
export function formatContrast(ratio: number): string {
	if (!Number.isFinite(ratio)) return '—';
	return `${ratio.toFixed(2)}:1`;
}

/**
 * The strongest claim the ratio supports, in one sentence. Written as a ladder so
 * a middling ratio says exactly what passes and what does not: "AA passes for
 * large text only" is the sentence that stops someone shipping 14px body copy on
 * the strength of a green badge.
 */
export function contrastSentence(ratio: number): string {
	const verdicts = contrastVerdicts(ratio);
	if (verdicts.aaaNormal) return `${formatContrast(ratio)} — AAA passes at every text size.`;
	if (verdicts.aaNormal) return `${formatContrast(ratio)} — AA passes at every text size.`;
	if (verdicts.aaaLarge)
		return `${formatContrast(ratio)} — AA and AAA pass for large text only, so body text needs more contrast.`;
	if (verdicts.aaLarge)
		return `${formatContrast(ratio)} — AA passes for large text only, so body text needs more contrast.`;
	return `${formatContrast(ratio)} — below every WCAG threshold, for any text size.`;
}

/* ------------------------------------------------------------------------- *
 * Tints, shades and schemes
 * ------------------------------------------------------------------------- */

/**
 * Mix a colour toward white by `amount` (0 leaves it alone, 1 gives pure white).
 * Mixing in RGB is what a tint means to a designer and what CSS `color-mix()`
 * does in sRGB; OKLab would spread the steps more evenly but would also make
 * "tint 50%" mean something no design tool agrees with.
 */
export function tint(rgb: Rgb, amount: number): Rgb {
	const mix = clampUnit(amount);
	return {
		r: clampChannel(rgb.r + (255 - rgb.r) * mix),
		g: clampChannel(rgb.g + (255 - rgb.g) * mix),
		b: clampChannel(rgb.b + (255 - rgb.b) * mix),
	};
}

/** The same toward black. This is what a shade is: the hue kept, light removed. */
export function shade(rgb: Rgb, amount: number): Rgb {
	const mix = clampUnit(amount);
	return {
		r: clampChannel(rgb.r * (1 - mix)),
		g: clampChannel(rgb.g * (1 - mix)),
		b: clampChannel(rgb.b * (1 - mix)),
	};
}

/**
 * The swatches for one harmony scheme, base colour included and labelled.
 *
 * Every scheme except monochrome is a set of hue rotations at the saturation and
 * value the visitor already chose, which is what makes them usable: a triad
 * rebuilt at full value would hand back three colours that shout over whatever
 * the page is doing. Monochrome is the exception — it holds the hue and mixes
 * toward white and black, because walking HSV's value only ever darkens a colour
 * that is already at 100%, and a ramp with three identical steps is not a ramp.
 */
export function schemeColors(hsv: Hsv, scheme: ColorScheme): SchemeColor[] {
	const base = { h: wrapHue(hsv.h), s: clampUnit(hsv.s), v: clampUnit(hsv.v) };
	const at = (degrees: number, role: string): SchemeColor => {
		const rgb = hsvToRgb({ ...base, h: wrapHue(base.h + degrees) });
		return { rgb, hex: rgbToHex(rgb), role };
	};
	const plain = (rgb: Rgb, role: string): SchemeColor => ({ rgb, hex: rgbToHex(rgb), role });

	switch (scheme) {
		case 'complement':
			return [at(0, 'Base'), at(180, 'Complement')];
		case 'analogous':
			return [at(-30, 'Analogous −30°'), at(0, 'Base'), at(30, 'Analogous +30°')];
		case 'triadic':
			return [at(0, 'Base'), at(120, 'Triad +120°'), at(240, 'Triad +240°')];
		case 'square':
			return [
				at(0, 'Base'),
				at(90, 'Square +90°'),
				at(180, 'Square +180°'),
				at(270, 'Square +270°'),
			];
		case 'split':
			return [at(0, 'Base'), at(150, 'Split +150°'), at(210, 'Split −150°')];
		case 'monochrome': {
			const rgb = hsvToRgb(base);
			return [
				plain(tint(rgb, 0.6), 'Tint 60%'),
				plain(tint(rgb, 0.3), 'Tint 30%'),
				plain(rgb, 'Base'),
				plain(shade(rgb, 0.3), 'Shade 30%'),
				plain(shade(rgb, 0.6), 'Shade 60%'),
			];
		}
		default:
			// Unreachable while ColorScheme is a closed union, and the compiler
			// says so; a runtime fallback keeps a bad select value from throwing.
			return [at(0, 'Base')];
	}
}

/* ------------------------------------------------------------------------- *
 * Naming a colour in words
 * ------------------------------------------------------------------------- */

/**
 * The twelve hue families, 30° each, centred on the names a person uses: red at
 * 0°, orange at 30°, and so on around the wheel. A lookup rather than a table of
 * named CSS colours, because a name this tool cannot derive from the numbers it
 * already has is a name it would have to look up in 148 entries and still get
 * wrong for anything between two of them.
 */
const HUE_FAMILIES: readonly { upTo: number; name: string }[] = [
	{ upTo: 15, name: 'red' },
	{ upTo: 45, name: 'orange' },
	{ upTo: 75, name: 'yellow' },
	{ upTo: 105, name: 'chartreuse' },
	{ upTo: 135, name: 'green' },
	{ upTo: 165, name: 'spring green' },
	{ upTo: 195, name: 'cyan' },
	{ upTo: 225, name: 'azure' },
	{ upTo: 255, name: 'blue' },
	{ upTo: 285, name: 'violet' },
	{ upTo: 315, name: 'magenta' },
	{ upTo: 345, name: 'rose' },
];

/** The family a hue falls in: 13° is orange, 200° is cyan. */
export function hueFamily(hue: number): string {
	const wrapped = wrapHue(hue);
	for (const family of HUE_FAMILIES) {
		if (wrapped < family.upTo) return family.name;
	}
	// 345°–360° is red again, which is the point of a circle.
	return 'red';
}

/** "a"/"an", because "a azure" in a status line reads like a bug. */
function article(phrase: string): string {
	return `${'aeiou'.includes(phrase.charAt(0)) ? 'an' : 'a'} ${phrase}`;
}

/**
 * The colour in plain words: "a muted orange", "near black", "a grey".
 *
 * It exists for two reasons. One is the status line, where a hex on its own asks
 * the visitor to picture the colour they just set. The other is that a colour is
 * never only a colour on this site — the description is text, so a screen reader
 * gets the same information the swatch gives an eye.
 */
export function describeColor(hsv: Hsv): string {
	const saturation = clampUnit(hsv.s);
	const value = clampUnit(hsv.v);
	if (value <= 0.06) return 'near black';
	if (value >= 0.97 && saturation <= 0.03) return 'near white';
	if (saturation <= 0.07) {
		if (value >= 0.9) return 'almost white';
		if (value <= 0.2) return 'almost black';
		return article('grey');
	}
	const family = hueFamily(hsv.h);
	// One modifier, in priority order. Two would read like a thesaurus, and the
	// first true one is the thing a person would say about the colour.
	if (saturation < 0.22) return article(`pale ${family}`);
	if (value < 0.3) return article(`deep ${family}`);
	if (saturation > 0.8 && value > 0.9) return article(`vivid ${family}`);
	return article(family);
}

/* ------------------------------------------------------------------------- *
 * Printing the formats
 * ------------------------------------------------------------------------- */

/** "57.6%" — one decimal, trailing zero kept, because CSS accepts it. */
function percent(value: number): string {
	return `${(clampUnit(value) * 100).toFixed(1)}%`;
}

/** A hue angle in degrees, one decimal. */
function degrees(value: number): string {
	return wrapHue(value).toFixed(1);
}

export function formatRgbCss(rgb: Rgb): string {
	return `rgb(${clampChannel(rgb.r)} ${clampChannel(rgb.g)} ${clampChannel(rgb.b)})`;
}

export function formatHslCss(hsl: Hsl): string {
	return `hsl(${degrees(hsl.h)} ${percent(hsl.s)} ${percent(hsl.l)})`;
}

export function formatHwbCss(hwb: Hwb): string {
	return `hwb(${degrees(hwb.h)} ${percent(hwb.w)} ${percent(hwb.b)})`;
}

export function formatOklchCss(oklch: Oklch): string {
	// Chroma has no upper bound, so four decimals: enough to keep two nearby
	// colours distinct, few enough to read.
	return `oklch(${percent(oklch.l)} ${Math.max(0, oklch.c).toFixed(4)} ${degrees(oklch.h)})`;
}

/** HSV has no CSS function, so it is printed as three numbers, not as a fake. */
export function formatHsvText(hsv: Hsv): string {
	return `${degrees(hsv.h)}° ${percent(hsv.s)} ${percent(hsv.v)}`;
}

/** CMYK has no CSS function either; these are the four ink percentages. */
export function formatCmykText(cmyk: Cmyk): string {
	const ink = (value: number): string => `${Math.round(clampUnit(value) * 100)}%`;
	return `${ink(cmyk.c)} ${ink(cmyk.m)} ${ink(cmyk.y)} ${ink(cmyk.k)}`;
}

/**
 * Every format, in the order the config lists them, for one colour. The labels
 * and the trade-off hints come from config, so the read-out and the documentation
 * of it cannot drift apart.
 */
export function formatValues(hsv: Hsv): ColorFormatValue[] {
	const rgb = hsvToRgb(hsv);
	const values: Record<ColorFormat, { value: string; css: boolean }> = {
		hex: { value: rgbToHex(rgb), css: true },
		rgb: { value: formatRgbCss(rgb), css: true },
		hsl: { value: formatHslCss(rgbToHsl(rgb)), css: true },
		hsv: { value: formatHsvText(hsv), css: false },
		cmyk: { value: formatCmykText(rgbToCmyk(rgb)), css: false },
		hwb: { value: formatHwbCss(rgbToHwb(rgb)), css: true },
		oklch: { value: formatOklchCss(rgbToOklch(rgb)), css: true },
	};
	return COLOR_FORMATS.map((format) => ({
		format,
		label: COLOR_FORMAT_LABEL[format],
		hint: COLOR_FORMAT_HINT[format],
		value: values[format].value,
		css: values[format].css,
	}));
}

/**
 * The block the "copy every format" button puts on the clipboard: one line per
 * format, labelled. Plain text, because the places a colour value gets pasted —
 * a stylesheet, a design file's notes, a chat message — all want plain text.
 */
export function formatBlock(hsv: Hsv): string {
	return formatValues(hsv)
		.map((row) => `${row.label.padEnd(5, ' ')} ${row.value}`)
		.join('\n');
}

/* ------------------------------------------------------------------------- *
 * The wheel
 *
 * One convention throughout, and it is the one every generated hue wheel uses:
 * hue 0° (red) is at three o'clock and increases clockwise on screen, because
 * canvas y grows downward and `atan2(dy, dx)` therefore turns clockwise. Saturation
 * is the distance from the centre, so the rim is the fullest colour the current
 * value allows. The same two functions map a pointer to a colour and a colour
 * back to a point, which is what keeps the marker where the visitor clicked.
 * ------------------------------------------------------------------------- */

export type WheelPoint = { x: number; y: number };
export type WheelHs = { h: number; s: number };

/**
 * A point in a square wheel to its hue and saturation.
 *
 * A point past the rim is not refused: saturation stops at 1 and the angle is
 * still read, which is what a drag off the edge should feel like. `clampToDisc`
 * exists for callers that want the point itself pulled back inside. Null comes
 * back only when the wheel has no size to speak of.
 *
 * `fallbackHue` matters at the exact centre alone, where saturation is zero and
 * the angle is undefined: keeping the hue already on screen is what stops a grey
 * from throwing the wheel back to red.
 */
export function wheelToHs(point: WheelPoint, size: number, fallbackHue = 0): WheelHs | null {
	const radius = size / 2;
	if (!(radius > 0)) return null;
	const dx = point.x - radius;
	const dy = point.y - radius;
	const distance = Math.hypot(dx, dy);
	const saturation = clampUnit(distance / radius);
	return {
		h: saturation === 0 ? wrapHue(fallbackHue) : wrapHue((Math.atan2(dy, dx) * 180) / Math.PI),
		s: saturation,
	};
}

/** The inverse: where the marker goes for a hue and saturation. */
export function hsToWheelPoint(hs: WheelHs, size: number): WheelPoint {
	const radius = size / 2;
	const radians = (wrapHue(hs.h) * Math.PI) / 180;
	const distance = clampUnit(hs.s) * radius;
	return {
		x: radius + Math.cos(radians) * distance,
		y: radius + Math.sin(radians) * distance,
	};
}

/**
 * Pull a point back inside the disc. Dragging past the rim should keep the hue
 * and pin saturation at 1 — a wheel that refused to answer outside its own edge
 * would drop the colour mid-drag.
 */
export function clampToDisc(point: WheelPoint, size: number): WheelPoint {
	const radius = size / 2;
	if (!(radius > 0)) return { x: 0, y: 0 };
	const dx = point.x - radius;
	const dy = point.y - radius;
	const distance = Math.hypot(dx, dy);
	if (distance <= radius) return { x: point.x, y: point.y };
	const scale = radius / distance;
	return { x: radius + dx * scale, y: radius + dy * scale };
}

/**
 * The backing store for the wheel: CSS size × device pixel ratio, capped. Drawn
 * per pixel, so its cost is its area — a 3× phone would otherwise ask for a
 * million pixels of atan2 for something 640 across already renders sharply.
 */
export function wheelBackingSize(cssSize: number, devicePixelRatio: number): number {
	const { fallbackCssSize, maxBacking, maxPixelRatio } = TOOL_COLOR_CONFIG.wheel;
	const size = Number.isFinite(cssSize) && cssSize > 0 ? cssSize : fallbackCssSize;
	const ratio =
		Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
			? Math.min(devicePixelRatio, maxPixelRatio)
			: 1;
	return Math.max(1, Math.min(Math.round(size * ratio), maxBacking));
}

/**
 * Paint the wheel at full value into a pixel buffer: hue from the angle,
 * saturation from the distance, and an antialiased rim.
 *
 * Written as a per-pixel loop rather than a conic gradient on purpose. A conic
 * gradient interpolates in premultiplied sRGB, so the hues between the stops are
 * not the hues an HSV wheel should show (yellow goes muddy through grey), and it
 * is not available in every browser this site supports — which would mean two
 * wheels, differing by browser, in a tool whose whole subject is exact colour.
 * The buffer is filled once per size and then only scaled by value, which is the
 * expensive part amortised: `applyWheelValue` is three multiplications a pixel.
 *
 * The rim's alpha is coverage — one pixel of falloff — so the circle's edge is
 * smooth against whatever the panel behind it is doing, in both themes.
 */
export function paintWheelBase(pixels: Uint8ClampedArray, size: number): void {
	const radius = size / 2;
	for (let y = 0; y < size; y += 1) {
		for (let x = 0; x < size; x += 1) {
			const index = (y * size + x) * 4;
			// Pixel centres, not corners: a 1×1 wheel then has one pixel that is
			// the centre, and the rim falls off symmetrically.
			const dx = x + 0.5 - radius;
			const dy = y + 0.5 - radius;
			const distance = Math.hypot(dx, dy);
			const coverage = Math.min(1, Math.max(0, radius - distance + 0.5));
			if (coverage <= 0) {
				pixels[index + 3] = 0;
				continue;
			}
			const rgb = hsvToRgb({
				h: wrapHue((Math.atan2(dy, dx) * 180) / Math.PI),
				s: clampUnit(distance / radius),
				v: 1,
			});
			pixels[index] = rgb.r;
			pixels[index + 1] = rgb.g;
			pixels[index + 2] = rgb.b;
			pixels[index + 3] = Math.round(coverage * 255);
		}
	}
}

/**
 * Scale a full-value wheel buffer to the current value. Multiplying is exactly
 * what compositing black at alpha 1 − V would do (`dst × (1 − a)`), so this is
 * the same image without the second pass — and it is cheap enough to run on every
 * input event from the brightness slider.
 */
export function applyWheelValue(
	pixels: Uint8ClampedArray,
	base: Uint8ClampedArray,
	value: number,
): void {
	const v = clampUnit(value);
	const count = Math.min(pixels.length, base.length);
	for (let index = 0; index < count; index += 1) {
		// Every fourth byte is alpha, which value must not touch: a darker wheel
		// is a darker colour, not a more transparent one.
		if (index % 4 === 3) {
			pixels[index] = base[index] as number;
			continue;
		}
		pixels[index] = (base[index] as number) * v;
	}
}

/* ------------------------------------------------------------------------- *
 * Reading an image
 * ------------------------------------------------------------------------- */

/**
 * Fit an image inside a box, never enlarging it, and report the scale. One
 * function for both the on-screen preview and the smaller scan buffer, so the two
 * cannot disagree about aspect ratio — a preview that stretched would put the
 * visitor's click on the wrong pixel.
 */
export function fitInside(
	width: number,
	height: number,
	maxEdge: number,
): { width: number; height: number; scale: number } {
	const source = {
		width: Math.max(1, Math.round(width)),
		height: Math.max(1, Math.round(height)),
	};
	const longest = Math.max(source.width, source.height);
	const scale = longest > maxEdge ? maxEdge / longest : 1;
	return {
		width: Math.max(1, Math.round(source.width * scale)),
		height: Math.max(1, Math.round(source.height * scale)),
		scale,
	};
}

/**
 * The largest per-channel gap between two colours. "Distance" here is deliberately
 * the crude measure: it is used only to stop one photograph reporting the same
 * blue eight times, and a perceptual metric would cost a cube root per pair to
 * make a heuristic slightly better.
 */
export function channelDistance(one: Rgb, other: Rgb): number {
	return Math.max(
		Math.abs(clampChannel(one.r) - clampChannel(other.r)),
		Math.abs(clampChannel(one.g) - clampChannel(other.g)),
		Math.abs(clampChannel(one.b) - clampChannel(other.b)),
	);
}

/**
 * The colours an image is mostly made of.
 *
 * How: every opaque pixel is dropped into one of 4,096 buckets (four bits per
 * channel), each bucket remembers the sum of its channels so the colour reported
 * is the bucket's average rather than its corner, and the buckets are ranked by
 * how many pixels they hold. A bucket is skipped when it is within
 * `minDistance` of a colour already chosen, which is what turns "eight shades of
 * the same sky" into a palette.
 *
 * What it is not: a clustering algorithm, and not a promise these are the
 * image's most important colours. A small saturated logo on a white background
 * will rank below the white, because white is more of the image. The share beside
 * each colour is printed so the visitor can see that for themselves.
 *
 * `share` is the fraction of the opaque pixels counted, and `count` is how many
 * there were — reported rather than hidden, since a scan of a downscaled buffer
 * is a sample of the file and the numbers say how big the sample was.
 */
export function commonColors(
	pixels: Uint8ClampedArray,
	options: { maxColors: number; bucketShift: number; minDistance: number },
): CommonColor[] {
	const buckets = new Map<
		number,
		{ count: number; r: number; g: number; b: number }
	>();
	let counted = 0;
	for (let index = 0; index + 3 < pixels.length; index += 4) {
		const alpha = pixels[index + 3] as number;
		// Half-transparent pixels are not a colour anyone sees: what they look like
		// depends on what is behind them, which this tool does not know.
		if (alpha < 128) continue;
		const r = pixels[index] as number;
		const g = pixels[index + 1] as number;
		const b = pixels[index + 2] as number;
		const key =
			((r >> options.bucketShift) << 8) |
			((g >> options.bucketShift) << 4) |
			(b >> options.bucketShift);
		const bucket = buckets.get(key);
		if (bucket) {
			bucket.count += 1;
			bucket.r += r;
			bucket.g += g;
			bucket.b += b;
		} else {
			buckets.set(key, { count: 1, r, g, b });
		}
		counted += 1;
	}
	if (counted === 0) return [];

	const ranked = [...buckets.entries()].sort((one, other) => {
		const byCount = other[1].count - one[1].count;
		// Ties broken by bucket, so the same image always gives the same palette:
		// a colour tool that shuffles its answers between clicks is not a tool.
		return byCount !== 0 ? byCount : one[0] - other[0];
	});

	const chosen: CommonColor[] = [];
	for (const [, bucket] of ranked) {
		const rgb = {
			r: clampChannel(bucket.r / bucket.count),
			g: clampChannel(bucket.g / bucket.count),
			b: clampChannel(bucket.b / bucket.count),
		};
		if (chosen.some((color) => channelDistance(color.rgb, rgb) < options.minDistance)) continue;
		chosen.push({ rgb, hex: rgbToHex(rgb), count: bucket.count, share: bucket.count / counted });
		if (chosen.length >= options.maxColors) break;
	}
	return chosen;
}

/* ------------------------------------------------------------------------- *
 * Reading any CSS colour
 * ------------------------------------------------------------------------- */

/**
 * Parse what a browser says a colour is, once it has accepted it.
 *
 * The CSSOM serialises a colour to `rgb(r, g, b)`, `rgba(r, g, b, a)` or the
 * space-separated forms of both, and a canvas normalises to `#rrggbb` or
 * `rgba(…)`. Those four shapes are all this has to read, because the browser has
 * already done the work that would otherwise mean reimplementing the whole of CSS
 * Color — named colours, `hsl()`, `oklch()`, `color()`, `currentColor` — and
 * getting it subtly wrong.
 */
export function parseCssColorString(text: string): ParsedHex | null {
	const value = text.trim();
	if (value.startsWith('#')) return parseHexColor(value);
	const match = /^rgba?\(\s*([^)]*?)\s*\)$/i.exec(value);
	if (!match) return null;
	const body = match[1] ?? '';
	// Both syntaxes: `255, 128, 0` and `255 128 0 / 50%`.
	const parts = body.includes(',') ? body.split(',') : body.split(/\s*\/\s*|\s+/);
	const numbers = parts.map((part) => part.trim()).filter((part) => part.length > 0);
	if (numbers.length < 3 || numbers.length > 4) return null;
	const channel = (raw: string): number | null => {
		if (raw.endsWith('%')) {
			const percentValue = Number.parseFloat(raw);
			return Number.isFinite(percentValue) ? (percentValue / 100) * 255 : null;
		}
		// `none` is legal CSS for a missing channel and this tool has no honest
		// number for it.
		if (raw.toLowerCase() === 'none') return null;
		const parsed = Number.parseFloat(raw);
		return Number.isFinite(parsed) ? parsed : null;
	};
	const r = channel(numbers[0] as string);
	const g = channel(numbers[1] as string);
	const b = channel(numbers[2] as string);
	if (r === null || g === null || b === null) return null;
	const alphaRaw = numbers.length === 4 ? numbers[3] : undefined;
	let alpha: number | null = null;
	if (alphaRaw !== undefined) {
		const parsedAlpha = alphaRaw.endsWith('%')
			? Number.parseFloat(alphaRaw) / 100
			: Number.parseFloat(alphaRaw);
		if (!Number.isFinite(parsedAlpha)) return null;
		alpha = clampUnit(parsedAlpha);
	}
	return { rgb: { r: clampChannel(r), g: clampChannel(g), b: clampChannel(b) }, alpha };
}

/* ------------------------------------------------------------------------- *
 * The controller
 * ------------------------------------------------------------------------- */

/** What this tool does with an image it accepts, in the shared refusals' words. */
const IMAGE_PURPOSE: ImagePurpose = { verb: 'reads colors from', nothing: 'sample' };

/**
 * The two paints of the marker rings: white over near-black.
 *
 * Deliberately not the design system's text colours. A hue wheel shows the same
 * colours in both themes — it is a picture of a colour space, not a themed
 * surface — so the ring that sits on it has to read on all of that at once. A
 * marker taken from a theme token would be white in the dark theme (lost on
 * yellow) and near-black in the light one (lost on blue); one ring of each,
 * drawn on top of each other, is visible on every colour the wheel can produce.
 * Canvas paint is not a stylesheet declaration, which is why these two values
 * are here rather than in tokens.css.
 */
const MARKER_LIGHT = '#ffffff';
const MARKER_DARK = 'rgba(0, 0, 0, 0.72)';

/**
 * The two colours the tool starts from, parsed from config. The fallbacks are the
 * same two values written out, because a config typo should not leave the tool
 * with no colour at all — and a test compares them, so they cannot drift.
 */
function defaultColor(): Rgb {
	return parseHexColor(TOOL_COLOR_CONFIG.defaultColor)?.rgb ?? { r: 224, g: 122, b: 63 };
}

function defaultBackground(): Rgb {
	return parseHexColor(TOOL_COLOR_CONFIG.defaultBackground)?.rgb ?? { r: 255, g: 255, b: 255 };
}

/**
 * Which control not to write back to. Setting `.value` on the field that holds
 * the caret moves the caret to the end and replaces what the visitor was
 * mid-way through typing — a half-typed `#ff8` "corrected" to `#ff8800` under
 * their fingers — so the field being edited is skipped and every other surface is
 * rewritten from the same colour.
 */
type RenderSkip = 'hex' | 'channel' | 'slider' | 'css' | null;

type SetOptions = { source?: string; announce?: boolean; skip?: RenderSkip };

/** The image a visitor dropped, and the map from its preview to its real pixels. */
type ImageSource = {
	name: string;
	bitmap: ImageBitmap;
	width: number;
	height: number;
	preview: { width: number; height: number; scale: number };
	picked: { x: number; y: number } | null;
	common: CommonColor[];
};

/** One format row, built once and updated in place. */
type FormatRow = {
	format: ColorFormat;
	label: string;
	value: HTMLElement;
	copy: HTMLButtonElement;
};

/** One scheme swatch, rebuilt when the scheme changes and recoloured otherwise. */
type SchemeSwatch = {
	role: string;
	button: HTMLButtonElement;
	chip: HTMLElement;
	caption: HTMLElement;
};

/** One contrast verdict badge: four of them, built once, re-worded on change. */
type ContrastBadge = { element: HTMLElement; label: string; threshold: string };

let started = false;
/** Set by init, cleared by destroy — the one place the tool is released. */
let teardown: (() => void) | null = null;

/**
 * Bind the color picker. Idempotent, and a no-op on any page without the markup,
 * so boot.ts can call it for every tool on every page.
 */
export function initColorPicker(): void {
	if (started) return;
	const root = document.querySelector<HTMLElement>('[data-color-picker]');
	if (!root) return;
	started = true;

	// One signal for every listener, as the other tools do: teardown is a single
	// abort() instead of a list of removeEventListener calls that can drift out of
	// sync with the bindings.
	const controller = new AbortController();
	const { signal } = controller;

	const wheel = root.querySelector<HTMLCanvasElement>('[data-color-wheel]');
	const wheelHint = root.querySelector<HTMLElement>('[data-color-wheel-hint]');
	const hueInput = root.querySelector<HTMLInputElement>('[data-color-hue]');
	const saturationInput = root.querySelector<HTMLInputElement>('[data-color-saturation]');
	const valueInput = root.querySelector<HTMLInputElement>('[data-color-value]');
	const hueValue = root.querySelector<HTMLElement>('[data-color-hue-value]');
	const saturationValue = root.querySelector<HTMLElement>('[data-color-saturation-value]');
	const valueValue = root.querySelector<HTMLElement>('[data-color-value-value]');
	const hexInput = root.querySelector<HTMLInputElement>('[data-color-hex]');
	const redInput = root.querySelector<HTMLInputElement>('[data-color-red]');
	const greenInput = root.querySelector<HTMLInputElement>('[data-color-green]');
	const blueInput = root.querySelector<HTMLInputElement>('[data-color-blue]');
	const cssInput = root.querySelector<HTMLInputElement>('[data-color-css]');
	const swatch = root.querySelector<HTMLElement>('[data-color-swatch]');
	const swatchName = root.querySelector<HTMLElement>('[data-color-name]');
	/*
	 * The scheme select is typed through a structural alias on purpose: this DOM
	 * lib declares HTMLSelectElement#remove() as returning void, which makes
	 * HTMLSelectElement structurally incompatible with Element, so
	 * querySelector<HTMLSelectElement> does not typecheck. The same workaround the
	 * other tools use for their selects.
	 */
	const schemeSelect = root.querySelector('[data-color-scheme]') as
		| (HTMLElement & { value: string })
		| null;
	const schemeHint = root.querySelector<HTMLElement>('[data-color-scheme-hint]');
	const schemeList = root.querySelector<HTMLElement>('[data-color-scheme-list]');
	const paletteList = root.querySelector<HTMLElement>('[data-color-palette-list]');
	const paletteEmpty = root.querySelector<HTMLElement>('[data-color-palette-empty]');
	const paletteCount = root.querySelector<HTMLElement>('[data-color-palette-count]');
	const paletteAdd = root.querySelector<HTMLButtonElement>('[data-color-palette-add]');
	const paletteCopy = root.querySelector<HTMLButtonElement>('[data-color-palette-copy]');
	const paletteClear = root.querySelector<HTMLButtonElement>('[data-color-palette-clear]');
	const formatsList = root.querySelector<HTMLElement>('[data-color-formats]');
	const formatsCopy = root.querySelector<HTMLButtonElement>('[data-color-formats-copy]');
	const backgroundInput = root.querySelector<HTMLInputElement>('[data-color-contrast-bg]');
	const contrastRatioValue = root.querySelector<HTMLElement>('[data-color-contrast-ratio]');
	const contrastSentenceValue = root.querySelector<HTMLElement>('[data-color-contrast-sentence]');
	const contrastVerdictList = root.querySelector<HTMLElement>('[data-color-contrast-verdicts]');
	const contrastSample = root.querySelector<HTMLElement>('[data-color-contrast-sample]');
	const contrastSwap = root.querySelector<HTMLButtonElement>('[data-color-contrast-swap]');
	const imageDrop = root.querySelector<HTMLElement>('[data-color-image-drop]');
	const imageInput = root.querySelector<HTMLInputElement>('[data-color-image-input]');
	const imagePreview = root.querySelector<HTMLCanvasElement>('[data-color-image-preview]');
	const imageMeta = root.querySelector<HTMLElement>('[data-color-image-meta]');
	const imageHint = root.querySelector<HTMLElement>('[data-color-image-hint]');
	const imageClear = root.querySelector<HTMLButtonElement>('[data-color-image-clear]');
	const commonList = root.querySelector<HTMLElement>('[data-color-common-list]');
	const copyButton = root.querySelector<HTMLButtonElement>('[data-color-copy]');
	const resetButton = root.querySelector<HTMLButtonElement>('[data-color-reset]');
	const statusLine = root.querySelector<HTMLElement>('[data-color-status]');
	const errorLine = root.querySelector<HTMLElement>('[data-color-error]');

	/* --- state ----------------------------------------------------------- */

	/**
	 * The colour, held as HSV rather than as the RGB it implies.
	 *
	 * The reason is the wheel. RGB channels are integers, so if RGB were the state
	 * then every drag would round-trip through 8 bits and the hue would drift by
	 * whatever the rounding decided — a wheel whose marker creeps while it is
	 * being dragged. Holding HSV keeps the marker exactly where the visitor put
	 * it, and integers appear only at the edges, where a hex or a channel is
	 * printed or typed.
	 */
	let current: Hsv = rgbToHsv(defaultColor());
	let background: Rgb = defaultBackground();
	/** Memory only, like every other tool here: a reload starts empty, and the note says so. */
	const palette: Rgb[] = [];
	let source: ImageSource | null = null;
	/**
	 * Bumped by every load and by reset. Decoding is asynchronous, so a second
	 * drop can land while one is still decoding; whichever arrives last owns the
	 * tool, and the loser must not write its pixels over the winner's.
	 */
	let generation = 0;
	let resizeTimer: number | undefined;
	/** The wheel's hue/saturation buffer, valid for `wheelBaseSize` only. */
	let wheelBase: Uint8ClampedArray | null = null;
	let wheelBaseSize = 0;
	let schemeBuilt: ColorScheme | null = null;
	let schemeSwatches: SchemeSwatch[] = [];
	/** The scheme's current colours, by index — what a swatch click sets. */
	let schemeRgb: Rgb[] = [];
	const formatRows: FormatRow[] = [];
	const contrastBadges: ContrastBadge[] = [];

	/* --- small view helpers ---------------------------------------------- */

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

	/** Grey out the two actions that make no sense mid-decode, and mark the state. */
	const setBusy = (value: boolean) => {
		if (copyButton) copyButton.disabled = value;
		if (resetButton) resetButton.disabled = value;
		if (paletteAdd) paletteAdd.disabled = value;
		if (statusLine) statusLine.dataset.busy = value ? 'true' : 'false';
	};

	const write = (cell: HTMLElement | null, value: string) => {
		if (cell) cell.textContent = value;
	};

	/** The select's value is not trusted on its own: anything unknown is the first scheme. */
	const selectedScheme = (): ColorScheme => {
		const value = schemeSelect?.value;
		return value === 'analogous' ||
			value === 'triadic' ||
			value === 'square' ||
			value === 'split' ||
			value === 'monochrome'
			? value
			: 'complement';
	};

	/* --- canvases -------------------------------------------------------- */

	/**
	 * A 2D context, or null. Every canvas here is an enhancement with a working
	 * alternative — the wheel has three sliders, the image has its list of common
	 * colours — so a browser without canvas loses a picture and keeps the tool,
	 * and is told which of those two things happened.
	 */
	const contextOf = (canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null => {
		if (!canvas || typeof canvas.getContext !== 'function') return null;
		try {
			return canvas.getContext('2d');
		} catch {
			return null;
		}
	};

	const wheelContext = contextOf(wheel);
	const previewContext = contextOf(imagePreview);
	/*
	 * A 1×1 canvas with two jobs. It is the scratch buffer a single pixel of the
	 * image is drawn into before being read, so sampling costs one pixel of
	 * ImageData whatever the photo's resolution; and because assigning to
	 * `fillStyle` accepts any valid CSS colour and ignores the rest, it is the
	 * second parser behind the "any CSS color" field.
	 */
	const scratch = document.createElement('canvas');
	scratch.width = 1;
	scratch.height = 1;
	const scratchContext = contextOf(scratch);

	/* --- the wheel ------------------------------------------------------- */

	const wheelCssSize = (): number => {
		if (!wheel || typeof wheel.getBoundingClientRect !== 'function') {
			return TOOL_COLOR_CONFIG.wheel.fallbackCssSize;
		}
		const rect = wheel.getBoundingClientRect();
		const measured = Math.min(rect.width, rect.height);
		return measured > 0 ? measured : TOOL_COLOR_CONFIG.wheel.fallbackCssSize;
	};

	/**
	 * Redraw the wheel.
	 *
	 * The hue and saturation picture depends on the backing size alone, so it is
	 * built once per size and kept; only the brightness scaling runs per frame,
	 * which is three multiplications a pixel instead of an atan2 and a conversion.
	 * That difference is the whole reason the brightness slider can be dragged
	 * smoothly at 640² instead of stuttering at 25fps.
	 */
	const drawWheel = () => {
		if (!wheel || !wheelContext) return;
		const size = wheelBackingSize(wheelCssSize(), window.devicePixelRatio ?? 1);
		if (wheel.width !== size || wheel.height !== size) {
			wheel.width = size;
			wheel.height = size;
		}
		if (wheelBaseSize !== size || !wheelBase) {
			wheelBase = new Uint8ClampedArray(size * size * 4);
			paintWheelBase(wheelBase, size);
			wheelBaseSize = size;
		}
		const frame = wheelContext.createImageData(size, size);
		applyWheelValue(frame.data, wheelBase, current.v);
		wheelContext.putImageData(frame, 0, 0);
		// After the pixels, because putImageData replaces rather than composites:
		// drawn first, the marker would be overwritten by the wheel itself.
		drawWheelMarker(size);
	};

	const drawWheelMarker = (size: number) => {
		if (!wheelContext) return;
		const point = hsToWheelPoint(current, size);
		const radius = Math.max(4, Math.min(18, size * 0.045));
		wheelContext.save();
		for (const [paint, width] of [
			[MARKER_DARK, radius * 0.5],
			[MARKER_LIGHT, radius * 0.25],
		] as const) {
			wheelContext.beginPath();
			wheelContext.arc(point.x, point.y, radius, 0, Math.PI * 2);
			wheelContext.lineWidth = Math.max(1.5, width);
			wheelContext.strokeStyle = paint;
			wheelContext.stroke();
		}
		wheelContext.restore();
	};

	/**
	 * Turn one pointer position into a colour. Clamped to the disc first, so a drag
	 * past the rim keeps its hue and pins saturation at 100% instead of dropping
	 * the colour mid-gesture.
	 */
	const pickFromWheel = (clientX: number, clientY: number) => {
		if (!wheel || !wheelContext || typeof wheel.getBoundingClientRect !== 'function') return;
		const rect = wheel.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		// The backing store can be larger than the element (that is the point of a
		// backing store), and the wheel was painted in backing pixels, so the
		// pointer is converted into the same space before it is read.
		const point = clampToDisc(
			{
				x: ((clientX - rect.left) / rect.width) * wheel.width,
				y: ((clientY - rect.top) / rect.height) * wheel.height,
			},
			wheel.width,
		);
		const hs = wheelToHs(point, wheel.width, current.h);
		if (!hs) return;
		setColor({ h: hs.h, s: hs.s, v: current.v }, { source: 'the wheel' });
	};

	/* --- rendering ------------------------------------------------------- */

	/** Write the whole interface from `current`. One writer, so the seven formats cannot disagree about which colour is current. */
	const render = (skip: RenderSkip = null) => {
		const rgb = hsvToRgb(current);
		const hex = rgbToHex(rgb);

		if (skip !== 'hex' && hexInput) hexInput.value = hex;
		if (skip !== 'channel') {
			if (redInput) redInput.value = String(rgb.r);
			if (greenInput) greenInput.value = String(rgb.g);
			if (blueInput) blueInput.value = String(rgb.b);
		}
		if (skip !== 'slider') {
			if (hueInput) hueInput.value = String(Math.round(current.h));
			if (saturationInput) saturationInput.value = String(Math.round(current.s * 100));
			if (valueInput) valueInput.value = String(Math.round(current.v * 100));
		}
		write(hueValue, `${Math.round(current.h)}°`);
		write(saturationValue, `${Math.round(current.s * 100)}%`);
		write(valueValue, `${Math.round(current.v * 100)}%`);

		/*
		 * An inline background here, and on every swatch this tool builds, is
		 * deliberate: the colour is the visitor's data, not the site's design. The
		 * rule against hex values outside tokens.css governs stylesheets — a theme
		 * colour hard-coded in a rule cannot be themed — and a value that changes on
		 * every keystroke cannot live in a stylesheet at all.
		 */
		if (swatch) {
			swatch.style.background = hex;
			swatch.dataset.hex = hex;
		}
		write(swatchName, describeColor(current));

		renderFormats();
		renderSchemes();
		renderContrast(rgb);
		drawWheel();
	};

	/**
	 * The seven format rows are built once and updated in place. Rebuilding them on
	 * every input event would mean 28 nodes and 7 listeners per frame of a slider
	 * drag, for a list whose shape never changes — only its values do.
	 */
	const buildFormats = () => {
		if (!formatsList) return;
		const rows = formatValues(current).map((row) => {
			const item = document.createElement('div');
			item.className = 'tool__color-format';
			item.dataset.format = row.format;

			const label = document.createElement('span');
			label.className = 'tool__color-format-label mono';
			label.textContent = row.label;

			const value = document.createElement('span');
			value.className = 'tool__color-format-value mono';
			value.textContent = row.value;

			const hint = document.createElement('span');
			hint.className = 'tool__color-format-hint';
			hint.textContent = row.hint;

			const copy = document.createElement('button');
			copy.type = 'button';
			copy.className = 'tool__color-mini';
			copy.textContent = 'Copy';
			copy.dataset.format = row.format;
			const format = row.format;
			const formatLabel = row.label;
			copy.addEventListener(
				'click',
				() => {
					// Read the row's value at click time, not from the closure that
					// built it: the colour has probably changed since.
					const current2 = formatRows.find((entry) => entry.format === format);
					void copyValue(current2?.value.textContent ?? '', `${formatLabel} value`);
				},
				{ signal },
			);

			/* replaceChildren, not append: `append` resolves to something else in this
			 * type environment (no other module in the repo uses it), and replaceChildren
			 * is what the other tools build their rows with. */
			item.replaceChildren(label, value, hint, copy);
			formatRows.push({ format, label: formatLabel, value, copy });
			return item;
		});
		formatsList.replaceChildren(...rows);
	};

	const renderFormats = () => {
		const rows = formatValues(current);
		rows.forEach((row, index) => {
			const ref = formatRows[index];
			if (!ref || ref.format !== row.format) return;
			ref.value.textContent = row.value;
			/*
			 * The accessible name carries the value itself: eight buttons all named
			 * "Copy" in one list is a list a screen reader cannot navigate, and the
			 * hex is the thing the visitor is about to paste somewhere.
			 */
			ref.copy.setAttribute(
				'aria-label',
				`Copy the ${row.label} value, ${row.value}${row.css ? '' : ' — not a CSS function'}`,
			);
		});
	};

	/**
	 * One swatch: a chip of the colour, with its hex as visible text beneath.
	 *
	 * The hex is text and not only a colour because a swatch is the one control
	 * here whose meaning IS a colour: in forced-colors mode the system palette
	 * repaints the chip and it carries nothing at all, and a screen reader gets the
	 * value from the name. All three swatch lists — schemes, palette, colors found
	 * in an image — are built from this one function, which is what makes them look
	 * like the same thing to a visitor who meets all three on one page.
	 */
	const buildSwatch = (
		hex: string,
		label: string,
		onChoose: () => void,
	): { button: HTMLButtonElement; chip: HTMLElement; caption: HTMLElement } => {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'tool__color-swatch';
		button.dataset.hex = hex;

		const chip = document.createElement('span');
		chip.className = 'tool__color-swatch-chip';
		chip.setAttribute('aria-hidden', 'true');
		chip.style.background = hex;

		const caption = document.createElement('span');
		caption.className = 'tool__color-swatch-hex mono';
		caption.setAttribute('aria-hidden', 'true');
		caption.textContent = hex;

		button.replaceChildren(chip, caption);
		button.setAttribute('aria-label', label);
		button.addEventListener('click', onChoose, { signal });
		return { button, chip, caption };
	};

	/**
	 * Build the scheme's swatches, but only when the scheme changed: within one
	 * scheme the roles and their count are fixed, so a colour change recolours the
	 * buttons that are already there instead of rebuilding them.
	 */
	const buildSchemes = (mode: ColorScheme) => {
		if (!schemeList || schemeBuilt === mode) return;
		const colors = schemeColors(current, mode);
		schemeSwatches = colors.map((color, index) => {
			const swatch = buildSwatch(color.hex, `${color.role}: ${color.hex}. Set this color.`, () => {
				// Read the scheme's colours at click time: the colour has probably
				// moved since this button was built.
				const rgb = schemeRgb[index];
				if (!rgb) return;
				setFromRgb(rgb, { source: `the ${color.role.toLowerCase()} swatch` });
			});
			swatch.button.dataset.role = color.role;
			return { role: color.role, ...swatch };
		});
		schemeList.replaceChildren(...schemeSwatches.map((entry) => entry.button));
		schemeBuilt = mode;
	};

	const renderSchemes = () => {
		const mode = selectedScheme();
		if (schemeHint) schemeHint.textContent = COLOR_SCHEME_HINT[mode];
		buildSchemes(mode);
		const colors = schemeColors(current, mode);
		schemeRgb = colors.map((color) => color.rgb);
		colors.forEach((color, index) => {
			const entry = schemeSwatches[index];
			if (!entry) return;
			entry.chip.style.background = color.hex;
			entry.button.dataset.hex = color.hex;
			entry.caption.textContent = color.hex;
			/*
			 * Colour is never the only signal: the name says the hex and the role the
			 * swatch plays, so the scheme is usable with the colour unseen — and the
			 * caption under it is the hex, for the same reason.
			 */
			entry.button.setAttribute(
				'aria-label',
				`${COLOR_SCHEME_LABEL[mode]} — ${entry.role}: ${color.hex}. Set this color.`,
			);
		});
	};

	const renderPalette = () => {
		if (!paletteList) return;
		const { maxPaletteEntries } = TOOL_COLOR_CONFIG;
		const entries = palette.map((rgb, index) => {
			const hex = rgbToHex(rgb);
			const entry = document.createElement('div');
			entry.className = 'tool__color-palette-entry';

			const { button } = buildSwatch(
				hex,
				`${hex}, palette color ${formatCount(index + 1)} of ${formatCount(palette.length)}. Set this color.`,
				() => setFromRgb(rgb, { source: `palette color ${index + 1}` }),
			);

			/*
			 * Removal is its own button under the swatch, not a badge on it. A control
			 * that only appears while a pointer is over its swatch is a control a
			 * keyboard user does not have, and its name says which colour it removes
			 * or the list is unnavigable by ear.
			 */
			const remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'tool__color-mini';
			remove.textContent = 'Remove';
			remove.setAttribute('aria-label', `Remove ${hex} from the palette.`);
			remove.addEventListener('click', () => removePaletteAt(index), { signal });

			entry.replaceChildren(button, remove);
			return entry;
		});
		paletteList.replaceChildren(...entries);
		paletteList.dataset.empty = palette.length === 0 ? 'true' : 'false';
		if (paletteEmpty) paletteEmpty.hidden = palette.length > 0;
		write(
			paletteCount,
			`${formatCount(palette.length)} of ${formatCount(maxPaletteEntries)}`,
		);
		if (paletteCopy) paletteCopy.disabled = palette.length === 0;
		if (paletteClear) paletteClear.disabled = palette.length === 0;
	};

	const buildContrastBadges = () => {
		if (!contrastVerdictList) return;
		const { aaNormal, aaLarge, aaaNormal, aaaLarge, largeTextPx } = TOOL_COLOR_CONFIG.contrast;
		const rows: [string, string, string][] = [
			['aaNormal', 'AA · normal text', String(aaNormal)],
			['aaLarge', `AA · large text (${largeTextPx}px+)`, String(aaLarge)],
			['aaaNormal', 'AAA · normal text', String(aaaNormal)],
			['aaaLarge', `AAA · large text (${largeTextPx}px+)`, String(aaaLarge)],
		];
		const badges = rows.map(([key, label, threshold]) => {
			const badge = document.createElement('span');
			badge.className = 'tool__color-badge';
			badge.dataset.verdict = key;
			contrastVerdictList.appendChild(badge);
			return { element: badge, label, threshold };
		});
		contrastBadges.push(...badges);
	};

	const renderContrast = (rgb: Rgb) => {
		const ratio = contrastRatio(rgb, background);
		const verdicts = contrastVerdicts(ratio);
		write(contrastRatioValue, formatContrast(ratio));
		write(contrastSentenceValue, contrastSentence(ratio));
		for (const badge of contrastBadges) {
			const pass = verdicts[badge.element.dataset.verdict as keyof ContrastVerdicts] ?? false;
			badge.element.dataset.pass = pass ? 'true' : 'false';
			/*
			 * Pass or fail is written out as well as coloured, and the threshold it
			 * was measured against travels with it: a badge that says "AA" with no
			 * number asks the visitor to trust arithmetic they cannot see, and colour
			 * alone would be the only signal for a sighted reader.
			 */
			badge.element.textContent = `${badge.label} — ${pass ? 'pass' : 'fail'} at ${badge.threshold}:1`;
		}
		if (contrastSample) {
			contrastSample.style.background = rgbToHex(background);
			contrastSample.style.color = rgbToHex(rgb);
			contrastSample.dataset.ratio = ratio.toFixed(2);
		}
	};

	/* --- setting the colour --------------------------------------------- */

	/** The single writer. Every path that changes the colour goes through here. */
	const setColor = (hsv: Hsv, options: SetOptions = {}) => {
		current = {
			h: wrapHue(Number.isFinite(hsv.h) ? hsv.h : current.h),
			s: clampUnit(hsv.s),
			v: clampUnit(hsv.v),
		};
		render(options.skip);
		if (options.announce !== false && options.source) {
			setStatus(
				`Color set from ${options.source}: ${rgbToHex(hsvToRgb(current))}, ${describeColor(current)}.`,
			);
		}
	};

	/**
	 * Set the colour from RGB — the direction hex fields, channel fields, image
	 * pixels and swatches all arrive from. The hue already on screen is kept when
	 * the incoming colour has none, so picking a grey does not throw the wheel back
	 * to red.
	 */
	const setFromRgb = (rgb: Rgb, options: SetOptions = {}) => {
		setColor(rgbToHsv(rgb, current.h), options);
	};

	const alphaNote = (alpha: number | null): string =>
		alpha === null || alpha >= 1
			? ''
			: ` The alpha channel (${Math.round(alpha * 100)}%) was dropped — this picker works in opaque sRGB.`;

	/* --- copying --------------------------------------------------------- */

	const copyValue = async (value: string, description: string) => {
		if (value.length === 0) return;
		const outcome = await copyText(value);
		if (outcome === 'unavailable') {
			showError(`${COPY_UNAVAILABLE} The values on screen are selectable by hand.`);
			return;
		}
		if (outcome === 'refused') {
			showError(`${COPY_REFUSED} The ${description} is still on screen to select.`);
			return;
		}
		clearError();
		setStatus(`Copied the ${description}: ${value}.`);
	};

	/* --- the palette ----------------------------------------------------- */

	const addPalette = () => {
		const rgb = hsvToRgb(current);
		const hex = rgbToHex(rgb);
		const { maxPaletteEntries } = TOOL_COLOR_CONFIG;
		if (palette.length >= maxPaletteEntries) {
			/*
			 * The button stays live and refuses out loud rather than going disabled:
			 * "24 of 24" beside a dead button asks the visitor to work out why, and a
			 * screen reader meets a disabled control with no reason attached.
			 */
			showError(
				`The palette holds ${formatCount(maxPaletteEntries)} colors and is full, so ${hex} was not added. Remove one first.`,
			);
			return;
		}
		// A duplicate is allowed. A palette that quietly refuses the colour the
		// visitor asked it to keep has started editing their work.
		palette.push(rgb);
		clearError();
		renderPalette();
		setStatus(
			`Added ${hex} to the palette — ${formatCount(palette.length)} ${palette.length === 1 ? 'color' : 'colors'}.`,
		);
	};

	const removePaletteAt = (index: number) => {
		const rgb = palette[index];
		if (!rgb) return;
		palette.splice(index, 1);
		renderPalette();
		setStatus(
			`Removed ${rgbToHex(rgb)} from the palette — ${formatCount(palette.length)} ${palette.length === 1 ? 'color' : 'colors'} left.`,
		);
	};

	const copyPalette = async () => {
		if (palette.length === 0) {
			showError(
				'The palette is empty, so there was nothing to copy. Add the current color with the button above.',
			);
			return;
		}
		// CSS custom properties, because that is what a palette is for: pasted into
		// a stylesheet it works, and the names say which entry is which.
		const block = palette.map((rgb, index) => `--color-${index + 1}: ${rgbToHex(rgb)};`).join('\n');
		const outcome = await copyText(block);
		if (outcome === 'unavailable') {
			showError(`${COPY_UNAVAILABLE} Each swatch's name carries its hex value.`);
			return;
		}
		if (outcome === 'refused') {
			showError(COPY_REFUSED);
			return;
		}
		clearError();
		setStatus(
			`Copied ${formatCount(palette.length)} ${palette.length === 1 ? 'color' : 'colors'} as CSS custom properties.`,
		);
	};

	const clearPalette = () => {
		if (palette.length === 0) return;
		palette.length = 0;
		renderPalette();
		setStatus('Palette cleared.');
	};

	/* --- the image ------------------------------------------------------- */

	const releaseSource = () => {
		if (!source) return;
		// close() is the only thing that returns a decoded image's pixels to the
		// browser before the GC gets around to it, and a photo is the largest thing
		// this tool ever holds.
		source.bitmap.close();
		source = null;
	};

	const drawPreview = () => {
		if (!source || !imagePreview || !previewContext) return;
		if (imagePreview.width !== source.preview.width) imagePreview.width = source.preview.width;
		if (imagePreview.height !== source.preview.height) {
			imagePreview.height = source.preview.height;
		}
		previewContext.clearRect(0, 0, source.preview.width, source.preview.height);
		previewContext.drawImage(source.bitmap, 0, 0, source.preview.width, source.preview.height);
		if (source.picked) drawPickMarker();
	};

	const drawPickMarker = () => {
		if (!source?.picked || !previewContext) return;
		const cx = source.picked.x * source.preview.scale;
		const cy = source.picked.y * source.preview.scale;
		previewContext.save();
		for (const [paint, width] of [
			[MARKER_DARK, 3],
			[MARKER_LIGHT, 1.5],
		] as const) {
			previewContext.beginPath();
			previewContext.arc(cx, cy, 7, 0, Math.PI * 2);
			previewContext.lineWidth = width;
			previewContext.strokeStyle = paint;
			previewContext.stroke();
		}
		previewContext.restore();
	};

	/**
	 * Take one pixel of the file, at the file's own resolution.
	 *
	 * The preview on screen is downscaled to fit, so sampling the preview would
	 * hand back whatever the browser's resampling made of that neighbourhood — a
	 * different colour from the one the visitor clicked, and the kind of small
	 * wrongness a colour tool cannot afford. Instead the mapped coordinate is
	 * drawn 1:1 out of the decoded image into a 1×1 canvas: exact, and cheap,
	 * because no full-resolution ImageData is ever allocated. A 40-megapixel photo
	 * costs the same to sample as a thumbnail.
	 */
	const sampleAt = (originalX: number, originalY: number): { rgb: Rgb; alpha: number } | null => {
		if (!source || !scratchContext) return null;
		const x = Math.min(source.width - 1, Math.max(0, Math.round(originalX)));
		const y = Math.min(source.height - 1, Math.max(0, Math.round(originalY)));
		scratchContext.clearRect(0, 0, 1, 1);
		scratchContext.drawImage(source.bitmap, x, y, 1, 1, 0, 0, 1, 1);
		const pixel = scratchContext.getImageData(0, 0, 1, 1).data;
		return {
			rgb: { r: pixel[0] as number, g: pixel[1] as number, b: pixel[2] as number },
			alpha: (pixel[3] as number) / 255,
		};
	};

	const pickFromImage = (clientX: number, clientY: number) => {
		if (!source || !imagePreview || !previewContext) return;
		if (typeof imagePreview.getBoundingClientRect !== 'function') return;
		const rect = imagePreview.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		// Two divisions: pointer to preview pixels, preview pixels to file pixels.
		// The second is the one that makes the answer the file's own.
		const previewX = ((clientX - rect.left) / rect.width) * source.preview.width;
		const previewY = ((clientY - rect.top) / rect.height) * source.preview.height;
		const x = Math.min(source.width - 1, Math.max(0, Math.round(previewX / source.preview.scale)));
		const y = Math.min(source.height - 1, Math.max(0, Math.round(previewY / source.preview.scale)));
		const sample = sampleAt(x, y);
		if (!sample) {
			showError(
				'This browser cannot read pixels from a canvas, so a color cannot be taken from the image. The common colors below are the alternative, and they are buttons.',
			);
			return;
		}
		if (sample.alpha === 0) {
			showError(
				`That pixel of “${source.name}” is fully transparent, so it has no color of its own — what it looks like depends on what is behind it. Pick an opaque spot.`,
			);
			return;
		}
		clearError();
		source.picked = { x, y };
		setFromRgb(sample.rgb, { announce: false });
		drawPreview();
		setStatus(
			`Took ${rgbToHex(hsvToRgb(current))} from ${source.name}: the pixel at ${formatCount(x)}, ${formatCount(y)} of the file's own ${formatCount(source.width)}×${formatCount(source.height)}, not an average of its neighbours.${alphaNote(sample.alpha)}`,
		);
	};

	const renderCommon = () => {
		if (!commonList) return;
		const name = source?.name ?? 'the image';
		const swatches = (source?.common ?? []).map((color) => {
			const share = Math.round(color.share * 100);
			/*
			 * These buttons are the keyboard's way into an image: a pointer can click
			 * a pixel and a keyboard cannot, so the colours the scan found are here as
			 * focusable controls with the share they represent in the name and in the
			 * caption beside the hex.
			 */
			const { button, caption } = buildSwatch(
				color.hex,
				`${color.hex}, ${share}% of the opaque pixels in ${name} — ${formatCount(color.count)} of them. Set this color.`,
				() => setFromRgb(color.rgb, { source: `the common colors in ${name}` }),
			);
			caption.textContent = `${color.hex} · ${share}%`;
			return button;
		});
		commonList.replaceChildren(...swatches);
		commonList.hidden = swatches.length === 0;
	};

	const clearImage = () => {
		releaseSource();
		if (imagePreview) {
			imagePreview.width = 0;
			imagePreview.height = 0;
			imagePreview.hidden = true;
		}
		if (commonList) {
			commonList.replaceChildren();
			commonList.hidden = true;
		}
		if (imageClear) imageClear.hidden = true;
		write(imageMeta, '');
		write(imageHint, 'Drop an image, or choose one, to take a color from any pixel of it.');
	};

	/**
	 * Count the colours in a downscaled copy of the image.
	 *
	 * Downscaled because counting 40 million pixels would take seconds and the
	 * answer would be no better: at 160px on the long edge the sample is still tens
	 * of thousands of pixels. The shares printed beside each colour are computed
	 * from that sample, so what the visitor reads is what was actually counted.
	 */
	const scanColors = (bitmap: ImageBitmap, scan: { width: number; height: number }): CommonColor[] => {
		// A canvas of its own rather than the preview's: the preview is on screen at
		// another size, and drawing a 160px scan into it would be visible as a
		// flicker.
		const scanCanvas = document.createElement('canvas');
		scanCanvas.width = scan.width;
		scanCanvas.height = scan.height;
		const context = contextOf(scanCanvas);
		if (!context) return [];
		context.drawImage(bitmap, 0, 0, scan.width, scan.height);
		const data = context.getImageData(0, 0, scan.width, scan.height).data;
		const { maxCommonColors, bucketShift, minColorDistance } = TOOL_COLOR_CONFIG.sample;
		return commonColors(data, {
			maxColors: maxCommonColors,
			bucketShift,
			minDistance: minColorDistance,
		});
	};

	const loadImage = async (file: File) => {
		clearError();
		const check = checkImageFile(file, IMAGE_PURPOSE);
		if (!check.ok) {
			showError(check.message);
			return;
		}
		if (typeof createImageBitmap !== 'function') {
			showError(
				'This browser cannot decode images (createImageBitmap is unavailable), so a color cannot be taken from a file. The wheel, the sliders and the hex field all still work.',
			);
			return;
		}
		if (!previewContext || !scratchContext) {
			showError(
				'This browser cannot draw an image into a canvas, so there is no surface to take a pixel from. Nothing was loaded.',
			);
			return;
		}

		// Claim the slot BEFORE the first await, so a second drop that lands while
		// this one is decoding cannot have its result written over it.
		const token = (generation += 1);
		setBusy(true);
		setStatus(`Reading ${file.name}…`);

		let bitmap: ImageBitmap;
		try {
			bitmap = await createImageBitmap(file);
		} catch {
			if (token !== generation) return;
			setBusy(false);
			showError(
				`Could not decode “${file.name}”. The file may be corrupt, or it may use a variant of the format this browser cannot read.`,
			);
			return;
		}

		if (token !== generation) {
			// Superseded mid-decode: this bitmap belongs to nobody now.
			bitmap.close();
			return;
		}

		const budget = checkDecodedImage({
			name: file.name,
			width: bitmap.width,
			height: bitmap.height,
		});
		if (!budget.ok) {
			bitmap.close();
			setBusy(false);
			showError(budget.message);
			return;
		}

		// Past every check: only now is a previous image released, so a refused drop
		// leaves the one already on screen alone.
		releaseSource();
		const preview = fitInside(bitmap.width, bitmap.height, TOOL_COLOR_CONFIG.sample.previewMaxEdge);
		source = {
			name: file.name,
			bitmap,
			width: bitmap.width,
			height: bitmap.height,
			preview,
			picked: null,
			common: [],
		};
		if (imagePreview) imagePreview.hidden = false;
		if (imageClear) imageClear.hidden = false;
		drawPreview();
		write(
			imageMeta,
			`${file.name} · ${formatCount(bitmap.width)}×${formatCount(bitmap.height)} · ${formatBytes(file.size)} · shown at ${formatCount(preview.width)}×${formatCount(preview.height)}`,
		);
		write(
			imageHint,
			'Click or tap the image to take that exact pixel. A keyboard cannot point at a pixel, so the common colors below are the same values as buttons.',
		);
		setBusy(false);

		const common = scanColors(bitmap, fitInside(bitmap.width, bitmap.height, TOOL_COLOR_CONFIG.sample.scanMaxEdge));
		if (token !== generation || !source) return;
		source.common = common;
		renderCommon();
		const dimensions = `${formatCount(bitmap.width)}×${formatCount(bitmap.height)}`;
		if (common.length === 0) {
			showError(
				`Every pixel of “${file.name}” is transparent, so there is no color in it to count. It is on screen, and picking an opaque spot still works.`,
			);
			setStatus(`Loaded ${file.name} — ${dimensions}, ${formatBytes(file.size)}. It has no opaque pixels.`);
			return;
		}
		setStatus(
			`Loaded ${file.name} — ${dimensions}, ${formatBytes(file.size)}. Click anywhere on it to take that pixel.`,
		);
	};

	/* --- any CSS colour -------------------------------------------------- */

	/**
	 * Read a colour the way the browser will read it, in whatever syntax the
	 * visitor used.
	 *
	 * Two parsers, in order, because neither alone is enough:
	 *   1. assigning to `style.color` and reading it back. The CSSOM ignores what
	 *      it cannot parse (the property stays empty) and serialises what it can,
	 *      so the browser does the work of knowing named colours, `hsl()`,
	 *      `oklch()`, `color()` and every alias — and it is the same parser that
	 *      will read the CSS this value gets pasted back into;
	 *   2. a canvas `fillStyle`, for the browsers that serialise a wide-gamut
	 *      `color()` back out as `color()` instead of as RGB. Canvas normalises
	 *      everything it accepts to hex or rgba.
	 * Neither is trusted to have parsed correctly on its own: both results go
	 * through `parseCssColorString`, which reads only the shapes a serialiser can
	 * produce. Reimplementing CSS Color here would mean getting it subtly wrong.
	 */
	const readCssColor = (text: string): ParsedHex | null => {
		const trimmed = text.trim();
		if (trimmed.length === 0) return null;
		const direct = parseCssColorString(trimmed);
		if (direct) return direct;

		const probe = document.createElement('span');
		probe.style.color = '';
		probe.style.color = trimmed;
		const serialised = probe.style.color;
		if (typeof serialised === 'string' && serialised.length > 0) {
			const fromStyle = parseCssColorString(serialised);
			if (fromStyle) return fromStyle;
		}
		if (!scratchContext) return null;
		/*
		 * Two sentinels, because one cannot tell "invalid" from "the visitor typed
		 * this exact colour": a valid value overwrites at least one of the two, and
		 * no single colour is equal to both.
		 */
		for (const sentinel of ['#010203', '#040506'] as const) {
			scratchContext.fillStyle = sentinel;
			scratchContext.fillStyle = trimmed;
			const value = scratchContext.fillStyle;
			if (typeof value === 'string' && value !== sentinel) {
				const fromCanvas = parseCssColorString(value);
				if (fromCanvas) return fromCanvas;
			}
		}
		return null;
	};

	const applyCssColor = (text: string) => {
		const parsed = readCssColor(text);
		if (!parsed) {
			showError(
				`“${text.trim()}” is not a color this browser can read. Try a hex, rgb(), hsl(), oklch(), or a CSS color name.`,
			);
			return;
		}
		clearError();
		setFromRgb(parsed.rgb, { source: 'the CSS color field', skip: 'css', announce: false });
		setStatus(
			`Color set from the CSS color field: ${rgbToHex(hsvToRgb(current))}, ${describeColor(current)}.${alphaNote(parsed.alpha)}`,
		);
	};

	/* --- events ---------------------------------------------------------- */

	const onSlider = (which: 'h' | 's' | 'v') => {
		const input = which === 'h' ? hueInput : which === 's' ? saturationInput : valueInput;
		if (!input) return;
		const raw = Number.parseFloat(input.value);
		if (!Number.isFinite(raw)) return;
		const next = { ...current };
		if (which === 'h') next.h = wrapHue(raw);
		else if (which === 's') next.s = clampUnit(raw / 100);
		else next.v = clampUnit(raw / 100);
		const names = { h: 'hue', s: 'saturation', v: 'brightness' } as const;
		// The slider being dragged is not written back: it is already where the
		// visitor put it, and rewriting it mid-drag fights the drag.
		setColor(next, { source: `the ${names[which]} slider`, skip: 'slider' });
	};

	const onHex = () => {
		if (!hexInput) return;
		const parsed = parseHexColor(hexInput.value);
		if (!parsed) {
			showError(
				`“${hexInput.value.trim()}” is not a hex color. It takes 3, 4, 6 or 8 hex digits, with or without the leading #.`,
			);
			return;
		}
		clearError();
		setFromRgb(parsed.rgb, { source: 'the hex field', skip: 'hex', announce: false });
		setStatus(
			`Color set from the hex field: ${rgbToHex(hsvToRgb(current))}, ${describeColor(current)}.${alphaNote(parsed.alpha)}`,
		);
	};

	const onChannel = () => {
		const rgb = hsvToRgb(current);
		const read = (input: HTMLInputElement | null, fallback: number): number => {
			const raw = Number.parseInt(input?.value ?? '', 10);
			// An out-of-range number is clamped rather than refused: a channel field
			// is a nudge, and 300 obviously means 255.
			return Number.isFinite(raw) ? clampChannel(raw) : fallback;
		};
		setFromRgb(
			{
				r: read(redInput, rgb.r),
				g: read(greenInput, rgb.g),
				b: read(blueInput, rgb.b),
			},
			{ source: 'the RGB channels', skip: 'channel' },
		);
	};

	const onBackground = () => {
		if (!backgroundInput) return;
		const typed = backgroundInput.value.trim();
		if (typed.length === 0) return;
		const parsed = readCssColor(typed);
		if (!parsed) {
			showError(
				`“${typed}” is not a color this browser can read, so the contrast is still measured against ${rgbToHex(background)}.`,
			);
			return;
		}
		clearError();
		background = parsed.rgb;
		const hex = rgbToHex(background);
		if (typed.toLowerCase() !== hex) backgroundInput.value = hex;
		renderContrast(hsvToRgb(current));
		setStatus(
			`Contrast against ${hex}: ${contrastSentence(contrastRatio(hsvToRgb(current), background))}`,
		);
		if (parsed.alpha !== null && parsed.alpha < 1) {
			showError(
				`The alpha channel of “${typed}” was dropped: contrast is measured against the opaque ${hex}, because a half-transparent background has no one colour.`,
			);
		}
	};

	const swapContrast = () => {
		const rgb = hsvToRgb(current);
		const previousBackground = background;
		background = rgb;
		setFromRgb(previousBackground, { announce: false });
		if (backgroundInput) backgroundInput.value = rgbToHex(background);
		clearError();
		setStatus(
			`Swapped the pair: ${rgbToHex(hsvToRgb(current))} on ${rgbToHex(background)} — ${contrastSentence(contrastRatio(hsvToRgb(current), background))}`,
		);
	};

	const reset = () => {
		generation += 1;
		clearError();
		clearImage();
		palette.length = 0;
		renderPalette();
		background = defaultBackground();
		if (backgroundInput) backgroundInput.value = rgbToHex(background);
		if (cssInput) cssInput.value = '';
		current = rgbToHsv(defaultColor());
		render();
		setBusy(false);
		setStatus(
			`Reset to ${rgbToHex(hsvToRgb(current))}. The palette is empty again and any image was released.`,
		);
	};

	hexInput?.addEventListener('input', onHex, { signal });
	redInput?.addEventListener('input', onChannel, { signal });
	greenInput?.addEventListener('input', onChannel, { signal });
	blueInput?.addEventListener('input', onChannel, { signal });
	cssInput?.addEventListener('change', () => applyCssColor(cssInput.value), { signal });
	hueInput?.addEventListener('input', () => onSlider('h'), { signal });
	saturationInput?.addEventListener('input', () => onSlider('s'), { signal });
	valueInput?.addEventListener('input', () => onSlider('v'), { signal });
	schemeSelect?.addEventListener(
		'change',
		() => {
			const mode = selectedScheme();
			// The label is already the select's own option text, so the announcement
			// carries the trade-off the visitor cannot see in a row of swatches.
			setStatus(`${COLOR_SCHEME_LABEL[mode]}: ${COLOR_SCHEME_HINT[mode]}`);
			renderSchemes();
		},
		{ signal },
	);
	backgroundInput?.addEventListener('change', onBackground, { signal });
	contrastSwap?.addEventListener('click', swapContrast, { signal });
	paletteAdd?.addEventListener('click', addPalette, { signal });
	paletteCopy?.addEventListener('click', () => void copyPalette(), { signal });
	paletteClear?.addEventListener('click', clearPalette, { signal });
	copyButton?.addEventListener(
		'click',
		() => void copyValue(rgbToHex(hsvToRgb(current)), 'hex color'),
		{ signal },
	);
	formatsCopy?.addEventListener(
		'click',
		() => void copyValue(formatBlock(current), 'color in every format'),
		{ signal },
	);
	resetButton?.addEventListener('click', reset, { signal });
	imageClear?.addEventListener('click', clearImage, { signal });

	/*
	 * Pointer events, not click: a wheel is dragged, and click would report only
	 * where it was released. Capturing the pointer keeps the drag alive once the
	 * cursor leaves the canvas, which it will — a drag toward the rim of a circle
	 * ends outside its own bounding box more often than not.
	 */
	const wireDrag = (
		canvas: HTMLCanvasElement | null,
		onPick: (clientX: number, clientY: number) => void,
	) => {
		if (!canvas) return;
		canvas.addEventListener(
			'pointerdown',
			(event) => {
				const pointer = event as PointerEvent;
				pointer.preventDefault();
				if (typeof canvas.setPointerCapture === 'function') {
					try {
						canvas.setPointerCapture(pointer.pointerId);
					} catch {
						// A capture that fails is a drag that stops at the edge. The
						// colour was already set by the pointerdown, so nothing is lost.
					}
				}
				onPick(pointer.clientX, pointer.clientY);
			},
			{ signal },
		);
		canvas.addEventListener(
			'pointermove',
			(event) => {
				const pointer = event as PointerEvent;
				// Nothing held down, no drag: a hover must not repaint the colour.
				if (pointer.buttons === 0) return;
				onPick(pointer.clientX, pointer.clientY);
			},
			{ signal },
		);
	};

	wireDrag(wheel, pickFromWheel);
	wireDrag(imagePreview, pickFromImage);

	imageInput?.addEventListener(
		'change',
		() => {
			const file = imageInput.files?.[0];
			if (file) void loadImage(file);
			// Cleared, so choosing the same file twice in a row still fires change.
			imageInput.value = '';
		},
		{ signal },
	);

	/*
	 * Drag and drop is the other way in. dragover must be cancelled or the browser
	 * navigates to the dropped file instead of handing it over.
	 */
	if (imageDrop) {
		imageDrop.addEventListener(
			'dragover',
			(event) => {
				event.preventDefault();
				imageDrop.dataset.dragOver = 'true';
			},
			{ signal },
		);
		imageDrop.addEventListener(
			'dragleave',
			() => {
				imageDrop.dataset.dragOver = 'false';
			},
			{ signal },
		);
		imageDrop.addEventListener(
			'drop',
			(event) => {
				event.preventDefault();
				imageDrop.dataset.dragOver = 'false';
				const file = event.dataTransfer?.files?.[0];
				if (file) void loadImage(file);
			},
			{ signal },
		);
	}

	// The wheel's marker is painted over the wheel's own colours, so a theme change
	// is a repaint — otherwise the ring keeps the old theme's paint until the
	// visitor happens to move something.
	window.addEventListener(
		'bnji:themechange',
		() => {
			drawWheel();
			drawPickMarker();
		},
		{ signal },
	);

	/*
	 * Redrawing on every resize event would run the per-pixel loop dozens of times
	 * a second while a window is being dragged, so the resize is settled first.
	 */
	window.addEventListener(
		'resize',
		() => {
			if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
			resizeTimer = window.setTimeout(() => {
				resizeTimer = undefined;
				drawWheel();
			}, TOOL_COLOR_CONFIG.wheel.resizeDebounceMs);
		},
		{ signal },
	);

	// Leaving the page releases the decoded image: a bitmap is the one thing this
	// tool holds that the browser will not reclaim on its own schedule.
	window.addEventListener(
		'pagehide',
		() => {
			generation += 1;
			releaseSource();
		},
		{ signal },
	);

	teardown = () => {
		controller.abort();
		if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
		resizeTimer = undefined;
		generation += 1;
		releaseSource();
		palette.length = 0;
		wheelBase = null;
		wheelBaseSize = 0;
		schemeBuilt = null;
		schemeSwatches = [];
		schemeRgb = [];
		formatRows.length = 0;
		contrastBadges.length = 0;
		current = rgbToHsv(defaultColor());
		background = defaultBackground();
	};

	/* --- first paint ----------------------------------------------------- */

	if (!wheelContext) {
		/*
		 * No canvas is not a broken tool. The three sliders set exactly what the
		 * wheel sets — and they are the accessible path anyway, since the wheel is a
		 * picture a screen reader cannot use and the sliders are labelled controls
		 * that announce their values. Say which of those two things happened rather
		 * than leaving an empty square.
		 */
		if (wheel) wheel.hidden = true;
		write(
			wheelHint,
			'This browser has no canvas, so the wheel is not drawn. The hue, saturation and brightness sliders below set exactly the same values.',
		);
	} else {
		write(
			wheelHint,
			'Drag in the wheel: the angle is the hue and the distance from the centre is how much colour there is. The sliders below set the same two values, and brightness is the third.',
		);
	}
	if (!previewContext) {
		write(
			imageHint,
			'This browser cannot draw an image into a canvas, so picking a color from a file cannot run here. Everything else on this tool works.',
		);
	}

	buildFormats();
	buildContrastBadges();
	if (backgroundInput) backgroundInput.value = rgbToHex(background);
	render();
	renderPalette();
	setBusy(false);
	setStatus(
		`Pick a color: drag the wheel, type a hex, or drop an image and take a pixel from it. Starting on ${rgbToHex(hsvToRgb(current))}, ${describeColor(current)}. Nothing leaves this tab.`,
	);
}

/**
 * Release every listener this tool owns, close any decoded image, and re-arm the
 * init so a second call binds a fresh subtree. Used by the tests, and by anything
 * that ever swaps the page's content without a reload.
 */
export function destroyColorPicker(): void {
	const release = teardown;
	teardown = null;
	started = false;
	release?.();
}
