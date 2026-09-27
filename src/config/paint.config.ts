/**
 * Public settings for the shared board paint canvas.
 *
 * Canvas dimensions are logical pixels. The image is a single compressed
 * raster snapshot in D1, not an ever-growing history of pointer events.
 */
export const PAINT_CONFIG = {
	width: 1200,
	height: 750,
	maxImageChars: 850_000,
	maxRequestBytes: 860_000,
	pollIntervalMs: 20_000,
	syncsPerHour: 30,
	retainedCommitIds: 128,
	palette: [
		{ name: 'Charcoal', token: 'var(--paint-ink-charcoal)' },
		{ name: 'Red', token: 'var(--paint-ink-red)' },
		{ name: 'Orange', token: 'var(--paint-ink-orange)' },
		{ name: 'Yellow', token: 'var(--paint-ink-yellow)' },
		{ name: 'Green', token: 'var(--paint-ink-green)' },
		{ name: 'Teal', token: 'var(--paint-ink-teal)' },
		{ name: 'Blue', token: 'var(--paint-ink-blue)' },
		{ name: 'Violet', token: 'var(--paint-ink-violet)' },
		{ name: 'Pink', token: 'var(--paint-ink-pink)' },
	],
} as const;
