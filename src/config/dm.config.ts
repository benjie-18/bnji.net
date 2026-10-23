/**
 * BNJI.NET — private messaging policy (Phase D of the chat plan).
 *
 * All values are PUBLIC: they are limits and switches, not secrets. The
 * /community/messages/ page reads them for input attributes and disclosure copy, the
 * DM routes read them for enforcement, and docs/CONFIGURATION.md documents
 * each one.
 *
 * Rollback (plan §14): set `enabled: false` and redeploy — every /api/dm/*
 * route refuses with `dm_disabled` and the UI hides itself, independent of
 * room chat. `images.enabled: false` independently turns off attachments
 * while text keeps working.
 *
 * Retention: 60 days — the owner's answer (2026-09-30) recorded in plan §15;
 * enforced by the hourly sweep (plan §9.3) and stated in docs/DATA.md §11.
 */
export type DmConfig = {
	/** Master switch. false = every DM route refuses server-side and the UI hides. */
	enabled: boolean;
	/** Message text, code points, after the shared sanitizer (§12.2). */
	maxTextLength: number;
	/** Messages returned per history page (REST pulls are bounded, §10). */
	historyPage: number;
	/** dm_messages retention window; the hourly cron purges older rows. */
	retentionDays: number;
	rate: {
		/** Per-account send budget, D1 counter prefix bnji-dm-send: (plan §7.5). */
		sendPerMinute: number;
		/** Per-account image uploads, prefix bnji-dm-image: (plan §7.5). */
		uploadsPerHour: number;
		/** Per-account report budget, prefix bnji-dm-report: (mirrors Phase C). */
		reportsPerWindow: number;
		reportWindowMs: number;
		/** Socket connects per minute per account, prefix bnji-dm-ws:. */
		connectsPerMinute: number;
	};
	images: {
		/** Independent kill switch (plan §14: images toggle separately). */
		enabled: boolean;
		/** Base64-decoded byte ceiling. 1.4 MB = the board's documented D1 base64 ceiling (D6). */
		maxDecodedBytes: number;
		/** Longest edge the CLIENT normalises to before upload (§7.4 — canvas, strips EXIF). */
		maxEdge: number;
		/** Allowed types after server-side magic-byte sniffing. No SVG — it is a script vector. */
		allowedTypes: readonly ('image/png' | 'image/jpeg' | 'image/webp')[];
	};
};

export const DM_CONFIG: DmConfig = {
	enabled: true,
	maxTextLength: 2_000,
	historyPage: 50,
	retentionDays: 60,
	rate: {
		sendPerMinute: 30,
		uploadsPerHour: 20,
		reportsPerWindow: 10,
		reportWindowMs: 10 * 60_000,
		connectsPerMinute: 12,
	},
	images: {
		enabled: true,
		maxDecodedBytes: 1_400_000,
		maxEdge: 1600,
		allowedTypes: ['image/png', 'image/jpeg', 'image/webp'],
	},
};
