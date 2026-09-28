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
	maxStickerCount: 24,
	/** Import box: a new sticker is fitted inside this, aspect kept. */
	maxStickerWidth: 60,
	maxStickerHeight: 39,
	/**
	 * Resize ceiling: 4x the import box in each axis. A sticker starts at its
	 * import size and can be shrunk to nothing or grown up to this — the
	 * server enforces it as the stored-size limit, so the two agree.
	 */
	maxStickerResizeWidth: 240,
	maxStickerResizeHeight: 156,
	maxStickerImageChars: 18_000,
	maxStickerSourceBytes: 8_000_000,
	maxStickerSourcePixels: 40_000_000,
	maxStickerPayloadChars: 180_000,
	maxStorageChars: 1_050_000,
	maxRequestBytes: 1_100_000,
	pollIntervalMs: 20_000,
	syncsPerHour: 30,
	retainedCommitIds: 128,
	maxActionsPerPublish: 5000,
	maxActivityRows: 5000,
	activityRetentionDays: 60,
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
