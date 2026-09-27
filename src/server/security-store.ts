/**
 * BNJI.NET — security event storage (D1).
 *
 * Records request metadata for abuse-detection on public profile endpoints.
 * This data lives in a SEPARATE table from public analytics (profile_views,
 * profile_reactions, profile_link_clicks) and is NEVER exposed through any
 * public API or page.
 *
 * Purpose: detect and respond to abuse (reaction/view spam, bot traffic,
 * rate-limit evasion). NOT for personalization, marketing or general traffic
 * analytics.
 *
 * Fields collected:
 *   SERVER-SIDE: ip, user-agent, country, city, ASN, geo coordinates,
 *     referrer, fingerprint, session key, endpoint, timestamp.
 *   CLIENT-SIDE (enriched via POST beacon): screen dimensions, pixel ratio,
 *     CPU cores, device memory, platform, timezone, language, WebGL renderer,
 *     touch support, device fingerprint hash.
 *
 * Retention: 60 days. Lazy cleanup on admin reads — when the row count
 * exceeds CLEANUP_THRESHOLD, rows older than 60 days are deleted.
 *
 * Privacy (Quebec Law 25 / PIPEDA): IP addresses, user-agent strings,
 * referrer URLs, precise geolocation, and device identifiers are personal
 * information. They are accessible only through the admin endpoint (which
 * requires a bearer token). All data in this table is server-only and must
 * never reach any public surface.
 *
 * Admin access: see src/pages/api/admin/security.ts — gated behind the
 * ACCESS_TOKEN environment variable. This is a stopgap, not real auth.
 */

/* --- structural D1 types (same pattern as board-store, profile-store) ---- */

type D1PreparedStatement = {
	bind(...values: (string | number | null)[]): D1PreparedStatement;
	all<T>(): Promise<{ results: T[] }>;
	run(): Promise<{ meta?: { changes?: number } }>;
	/**
	 * With a column name, D1 resolves to that column's SCALAR value (not a row
	 * object) — `first<number>('cnt')` is the number itself. Without one, it
	 * resolves to the whole row. Callers below rely on the scalar form.
	 */
	first<T>(colName?: string): Promise<T | null>;
};

type D1Database = {
	prepare(query: string): D1PreparedStatement;
};

/* --- public types --------------------------------------------------------- */

export type SecurityEvent = {
	profileSlug: string;
	endpoint: string;
	ipAddress: string;
	userAgent?: string;
	cfCountry?: string;
	cfCity?: string;
	cfAsn?: string;
	fingerprint?: string;
	sessionKey?: string;
	createdAt: number;
	/** Precise geolocation from Cloudflare cf.latitude/cf.longitude. */
	geoLatitude?: number;
	geoLongitude?: number;
	/** Referrer URL (may contain sensitive data). */
	referrer?: string;
	/* --- Client-enriched fields (sent via /api/profile/security/enrich) --- */
	screenWidth?: number;
	screenHeight?: number;
	screenPixelRatio?: number;
	hardwareConcurrency?: number;
	deviceMemory?: number;
	platform?: string;
	timezone?: string;
	language?: string;
	webglRenderer?: string;
	touchSupport?: boolean;
	deviceFingerprint?: string;
};

export type SecurityEventRow = SecurityEvent & { id: number };

export type SecurityEnrichment = {
	sessionKey: string;
	profileSlug: string;
	endpoint: string;
	screenWidth?: number;
	screenHeight?: number;
	screenPixelRatio?: number;
	hardwareConcurrency?: number;
	deviceMemory?: number;
	platform?: string;
	timezone?: string;
	language?: string;
	webglRenderer?: string;
	touchSupport?: boolean;
	deviceFingerprint?: string;
};

export interface SecurityStore {
	readonly kind: 'd1';

	/** Insert a security event. Non-blocking; callers should not await. */
	recordEvent(event: SecurityEvent): Promise<void>;

	/**
	 * Enrich the most recent matching security event with client-side data.
	 * Matches by (session_key, profile_slug, endpoint) within a 10-second
	 * window. Returns true if an event was enriched.
	 */
	enrichEvent(
		sessionKey: string,
		profileSlug: string,
		endpoint: string,
		since: number,
		enrichment: Omit<SecurityEnrichment, 'sessionKey' | 'profileSlug' | 'endpoint'>,
	): Promise<boolean>;

	/**
	 * List recent events (newest first). Triggers lazy retention cleanup
	 * before returning results. Only callable from the admin endpoint.
	 */
	listRecent(limit: number): Promise<SecurityEventRow[]>;

	/** Count total events (for admin overview). */
	countEvents(): Promise<number>;
}

/* --- retention config ----------------------------------------------------- */

/** Days to keep security events. */
const RETENTION_DAYS = 60;
/** Trigger cleanup when table exceeds this many rows. */
const CLEANUP_THRESHOLD = 5000;

/* --- SQL column lists (kept in sync with the schema) ---------------------- */

const INSERT_COLUMNS = `
	profile_slug, endpoint, ip_address, user_agent,
	cf_country, cf_city, cf_asn, fingerprint, session_key, created_at,
	geo_latitude, geo_longitude, referrer`;

const ALL_COLUMNS = `
	id, profile_slug, endpoint, ip_address, user_agent,
	cf_country, cf_city, cf_asn, fingerprint, session_key, created_at,
	geo_latitude, geo_longitude, referrer,
	screen_width, screen_height, screen_pixel_ratio,
	hardware_concurrency, device_memory, platform,
	timezone, language, webgl_renderer, touch_support, device_fingerprint`;

type SecurityEventDbRow = {
	id: number;
	profile_slug: string;
	endpoint: string;
	ip_address: string;
	user_agent: string | null;
	cf_country: string | null;
	cf_city: string | null;
	cf_asn: string | null;
	fingerprint: string | null;
	session_key: string | null;
	created_at: number;
	geo_latitude: number | null;
	geo_longitude: number | null;
	referrer: string | null;
	screen_width: number | null;
	screen_height: number | null;
	screen_pixel_ratio: number | null;
	hardware_concurrency: number | null;
	device_memory: number | null;
	platform: string | null;
	timezone: string | null;
	language: string | null;
	webgl_renderer: string | null;
	touch_support: number | null;
	device_fingerprint: string | null;
};

function rowToEvent(row: SecurityEventDbRow): SecurityEventRow {
	return {
		id: row.id,
		profileSlug: row.profile_slug,
		endpoint: row.endpoint,
		ipAddress: row.ip_address,
		userAgent: row.user_agent ?? undefined,
		cfCountry: row.cf_country ?? undefined,
		cfCity: row.cf_city ?? undefined,
		cfAsn: row.cf_asn ?? undefined,
		fingerprint: row.fingerprint ?? undefined,
		sessionKey: row.session_key ?? undefined,
		createdAt: row.created_at,
		geoLatitude: row.geo_latitude ?? undefined,
		geoLongitude: row.geo_longitude ?? undefined,
		referrer: row.referrer ?? undefined,
		screenWidth: row.screen_width ?? undefined,
		screenHeight: row.screen_height ?? undefined,
		screenPixelRatio: row.screen_pixel_ratio ?? undefined,
		hardwareConcurrency: row.hardware_concurrency ?? undefined,
		deviceMemory: row.device_memory ?? undefined,
		platform: row.platform ?? undefined,
		timezone: row.timezone ?? undefined,
		language: row.language ?? undefined,
		webglRenderer: row.webgl_renderer ?? undefined,
		touchSupport: row.touch_support === 1 ? true : row.touch_support === 0 ? false : undefined,
		deviceFingerprint: row.device_fingerprint ?? undefined,
	};
}

/* --- implementation ------------------------------------------------------- */

function createD1SecurityStore(db: D1Database): SecurityStore {
	return {
		kind: 'd1',

		async recordEvent(event) {
			try {
				await db
					.prepare(
						`INSERT INTO security_events
						 (${INSERT_COLUMNS})
						 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
					)
					.bind(
						event.profileSlug,
						event.endpoint,
						event.ipAddress,
						event.userAgent ?? null,
						event.cfCountry ?? null,
						event.cfCity ?? null,
						event.cfAsn ?? null,
						event.fingerprint ?? null,
						event.sessionKey ?? null,
						event.createdAt,
						event.geoLatitude ?? null,
						event.geoLongitude ?? null,
						event.referrer ?? null,
					)
					.run();
			} catch (error) {
				// Security logging must never break the request.
				console.warn('[bnji] security event recording failed:', error);
			}
		},

		async enrichEvent(sessionKey, profileSlug, endpoint, since, enrichment) {
			try {
				// Find the most recent matching event within the time window.
				// D1's first(<col>) resolves to that column's scalar value, so
				// `eventId` IS the id — reading `.id` off it would be undefined.
				const eventId = await db
					.prepare(
						`SELECT id FROM security_events
						 WHERE session_key = ?1 AND profile_slug = ?2 AND endpoint = ?3
						   AND created_at >= ?4
						 ORDER BY created_at DESC LIMIT 1`,
					)
					.bind(sessionKey, profileSlug, endpoint, since)
					.first<number>('id');

				if (eventId === null) return false;

				await db
					.prepare(
						`UPDATE security_events SET
						 screen_width = COALESCE(?1, screen_width),
						 screen_height = COALESCE(?2, screen_height),
						 screen_pixel_ratio = COALESCE(?3, screen_pixel_ratio),
						 hardware_concurrency = COALESCE(?4, hardware_concurrency),
						 device_memory = COALESCE(?5, device_memory),
						 platform = COALESCE(?6, platform),
						 timezone = COALESCE(?7, timezone),
						 language = COALESCE(?8, language),
						 webgl_renderer = COALESCE(?9, webgl_renderer),
						 touch_support = COALESCE(?10, touch_support),
						 device_fingerprint = COALESCE(?11, device_fingerprint)
						 WHERE id = ?12`,
					)
					.bind(
						enrichment.screenWidth ?? null,
						enrichment.screenHeight ?? null,
						enrichment.screenPixelRatio ?? null,
						enrichment.hardwareConcurrency ?? null,
						enrichment.deviceMemory ?? null,
						enrichment.platform ?? null,
						enrichment.timezone ?? null,
						enrichment.language ?? null,
						enrichment.webglRenderer ?? null,
						enrichment.touchSupport !== undefined ? (enrichment.touchSupport ? 1 : 0) : null,
						enrichment.deviceFingerprint ?? null,
						eventId,
					)
					.run();

				return true;
			} catch (error) {
				console.warn('[bnji] security event enrichment failed:', error);
				return false;
			}
		},

		async listRecent(limit) {
			// Lazy retention cleanup.
			try {
				const countRow = await db
					.prepare('SELECT COUNT(*) as cnt FROM security_events')
					.first<number>('cnt');
				const total = Number(countRow ?? 0);
				if (total > CLEANUP_THRESHOLD) {
					const cutoff = Date.now() - RETENTION_DAYS * 86_400_000;
					await db
						.prepare('DELETE FROM security_events WHERE created_at < ?1')
						.bind(cutoff)
						.run();
				}
			} catch (error) {
				console.warn('[bnji] security event cleanup failed:', error);
			}

			const safeLimit = Math.min(Math.max(1, limit), 500);
			const { results } = await db
				.prepare(
					`SELECT ${ALL_COLUMNS.trim()}
					 FROM security_events ORDER BY created_at DESC LIMIT ?1`,
				)
				.bind(safeLimit)
				.all<SecurityEventDbRow>();

			return results.map(rowToEvent);
		},

		async countEvents() {
			const total = await db
				.prepare('SELECT COUNT(*) as cnt FROM security_events')
				.first<number>('cnt');
			return Number(total ?? 0);
		},
	};
}

/* --- selection ------------------------------------------------------------ */

export function getSecurityStore(env: Record<string, unknown> | undefined): SecurityStore | null {
	const db = env?.BOARD_DB as D1Database | undefined;
	if (db && typeof db.prepare === 'function') return createD1SecurityStore(db);
	return null;
}