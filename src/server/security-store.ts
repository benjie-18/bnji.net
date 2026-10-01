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
 *     referrer, fingerprint, session key, surface, target id, timestamp.
 *   CLIENT-SIDE (enriched via POST beacon): screen dimensions, pixel ratio,
 *     CPU cores, device memory, platform, timezone, language, WebGL renderer,
 *     touch support, device fingerprint hash.
 *
 * Retention: shared admin-configurable raw-tracking window (60 days by
 * default, 1–365). Hourly Worker cleanup plus admin-read recovery sweep.
 *
 * Privacy (Quebec Law 25 / PIPEDA): IP addresses, user-agent strings,
 * referrer URLs, precise geolocation, and device identifiers are personal
 * information. They are accessible only through the admin surface (which
 * requires a bearer token or an admin session). All data in this table is
 * server-only and must never reach any public surface.
 *
 * Admin access: see src/pages/api/admin/ and the /admin dashboard.
 */

import { getTrackingRetentionDays, purgeExpiredTrackingRows } from './tracking-retention';

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

/** Which part of the site an event came from. */
export type SecuritySurface = 'profile' | 'board' | 'dm';

export const SECURITY_SURFACES: readonly SecuritySurface[] = ['profile', 'board', 'dm'];

export type SecurityEvent = {
	/** Which surface acted. Defaults to 'profile' for pre-surface events. */
	surface?: SecuritySurface;
	/** Undefined for board/dm events — those surfaces have no profile. */
	profileSlug?: string;
	endpoint: string;
	/** The row this event acted on (board message id, link id), when there is one. */
	targetId?: string;
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

/** Client-reported device data folded into an existing event row. */
export type SecurityEnrichment = {
	sessionKey: string;
	surface: SecuritySurface;
	/** Undefined for board/dm events. */
	profileSlug?: string;
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

/** Filters for the admin security list. All optional and combinable. */
export type SecurityQuery = {
	limit: number;
	/** Omit to search every surface. */
	surface?: SecuritySurface;
	/** Restrict to one profile slug. */
	profileSlug?: string;
	/** Only events that carry a client fingerprint (i.e. were enriched). */
	enrichedOnly?: boolean;
	/** Only events from this IP (exact match). */
	ipAddress?: string;
	/** Only events sharing this device fingerprint — "everything from this device". */
	deviceFingerprint?: string;
	/** Only events at or after this epoch ms. */
	since?: number;
};

/** Aggregate counts for the admin overview. */
export type SecuritySummary = {
	total: number;
	retentionDays: number;
	bySurface: { surface: SecuritySurface; count: number }[];
	byEndpoint: { surface: SecuritySurface; endpoint: string; count: number }[];
	/** Events carrying a client-derived device fingerprint. */
	enriched: number;
	/** Distinct IP addresses seen. */
	uniqueIps: number;
	/** Distinct client-derived device fingerprints seen. */
	uniqueDevices: number;
	/** Events in the last 24 hours. */
	last24h: number;
};

export interface SecurityStore {
	readonly kind: 'd1';

	/** Insert a security event. Non-blocking; callers should not await. */
	recordEvent(event: SecurityEvent): Promise<void>;

	/**
	 * Enrich the most recent matching security event with client-side data.
	 * Matches by (session_key, surface, endpoint) and, for profile events,
	 * profile_slug — within the caller's time window. Returns true if an
	 * event was enriched.
	 */
	enrichEvent(
		match: { sessionKey: string; surface: SecuritySurface; profileSlug?: string; endpoint: string; since: number },
		enrichment: Omit<SecurityEnrichment, 'sessionKey' | 'surface' | 'profileSlug' | 'endpoint'>,
	): Promise<boolean>;

	/**
	 * List recent events (newest first) with optional filters. Triggers lazy
	 * retention cleanup before returning results. Admin-only.
	 */
	listRecent(query: SecurityQuery): Promise<SecurityEventRow[]>;

	/** Count events matching the same filters (no limit). Admin-only. */
	countMatching(query: Pick<SecurityQuery, 'surface' | 'profileSlug' | 'enrichedOnly' | 'ipAddress' | 'deviceFingerprint' | 'since'>): Promise<number>;

	/** Aggregate counts for the admin overview. Admin-only. */
	summarize(): Promise<SecuritySummary>;

	/**
	 * Top referring HOSTS behind page views since `since` (admin-only).
	 * Only the host survives this method — full referrer URLs can carry
	 * personal browsing paths, and the dashboard only needs the source site.
	 * Hosts in `excludeHosts` (our own hostnames) are dropped.
	 */
	topReferrers(since: number, limit: number, excludeHosts: string[]): Promise<{ host: string; count: number }[]>;
}

/* --- retention config ----------------------------------------------------- */

/** Legacy default retained for compatibility; runtime retention comes from trackingRetentionDays. */
export const RETENTION_DAYS = 60;
/** Legacy cleanup threshold retained for the existing admin configuration display; no longer gates expiry. */
export const CLEANUP_THRESHOLD = 5000;

/* --- SQL column lists (kept in sync with the schema) ---------------------- */

const INSERT_COLUMNS = `
	surface, profile_slug, endpoint, target_id, ip_address, user_agent,
	cf_country, cf_city, cf_asn, fingerprint, session_key, created_at,
	geo_latitude, geo_longitude, referrer`;

const ALL_COLUMNS = `
	id, surface, profile_slug, endpoint, target_id, ip_address, user_agent,
	cf_country, cf_city, cf_asn, fingerprint, session_key, created_at,
	geo_latitude, geo_longitude, referrer,
	screen_width, screen_height, screen_pixel_ratio,
	hardware_concurrency, device_memory, platform,
	timezone, language, webgl_renderer, touch_support, device_fingerprint`;

type SecurityEventDbRow = {
	id: number;
	surface: SecuritySurface;
	profile_slug: string | null;
	endpoint: string;
	target_id: string | null;
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
		surface: row.surface,
		profileSlug: row.profile_slug ?? undefined,
		endpoint: row.endpoint,
		targetId: row.target_id ?? undefined,
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

/**
 * Build the shared WHERE clause for the admin list/count queries.
 * Values are positional (?1, ?2, ...) in a fixed order so the list and count
 * paths can never drift apart.
 */
type WhereClause = { sql: string; values: (string | number)[] };

function buildWhere(
	filters: Pick<SecurityQuery, 'surface' | 'profileSlug' | 'enrichedOnly' | 'ipAddress' | 'deviceFingerprint' | 'since'>,
): WhereClause {
	const clauses: string[] = [];
	const values: (string | number)[] = [];

	if (filters.surface) {
		values.push(filters.surface);
		clauses.push(`surface = ?${values.length}`);
	}
	if (filters.profileSlug) {
		values.push(filters.profileSlug);
		clauses.push(`profile_slug = ?${values.length}`);
	}
	if (filters.ipAddress) {
		values.push(filters.ipAddress);
		clauses.push(`ip_address = ?${values.length}`);
	}
	if (filters.deviceFingerprint) {
		values.push(filters.deviceFingerprint);
		clauses.push(`device_fingerprint = ?${values.length}`);
	}
	if (filters.enrichedOnly) {
		clauses.push('device_fingerprint IS NOT NULL');
	}
	if (typeof filters.since === 'number' && Number.isFinite(filters.since)) {
		values.push(filters.since);
		clauses.push(`created_at >= ?${values.length}`);
	}

	return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values };
}

function createD1SecurityStore(db: D1Database): SecurityStore {
	return {
		kind: 'd1',

		async recordEvent(event) {
			try {
				await db
					.prepare(
						`INSERT INTO security_events
						 (${INSERT_COLUMNS})
						 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
					)
					.bind(
						event.surface ?? 'profile',
						event.profileSlug ?? null,
						event.endpoint,
						event.targetId ?? null,
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

		async enrichEvent({ sessionKey, surface, profileSlug, endpoint, since }, enrichment) {
			try {
				// Find the most recent matching event within the time window.
				// D1's first(<col>) resolves to that column's scalar value, so
				// `eventId` IS the id — reading `.id` off it would be undefined.
				//
				// profile_slug is matched only for profile events. For board/dm
				// events it is NULL, and `profile_slug = NULL` is never true in
				// SQL, so those would never match — hence the explicit branch.
				const eventId = await db
					.prepare(
						surface === 'profile'
							? `SELECT id FROM security_events
							 WHERE session_key = ?1 AND surface = ?2 AND profile_slug = ?3
							   AND endpoint = ?4 AND created_at >= ?5
							 ORDER BY created_at DESC LIMIT 1`
							: `SELECT id FROM security_events
							 WHERE session_key = ?1 AND surface = ?2
							   AND endpoint = ?3 AND created_at >= ?4
							 ORDER BY created_at DESC LIMIT 1`,
					)
					.bind(
						...(surface === 'profile'
							? [sessionKey, surface, profileSlug ?? null, endpoint, since]
							: [sessionKey, surface, endpoint, since]),
					)
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

		async listRecent(query) {
			// A private admin read performs only one bounded recovery batch. The
			// cutoff also hides any remaining backlog from the response.
			const days = await getTrackingRetentionDays(db);
			const cutoff = Date.now() - days * 86_400_000;
			try { await purgeExpiredTrackingRows(db, 'security_events', cutoff); }
			catch { console.warn('[bnji] security event cleanup failed'); }

			const safeLimit = Math.min(Math.max(1, Math.floor(query.limit) || 1), 500);
			const where = buildWhere({ ...query, since: Math.max(query.since ?? cutoff, cutoff) });
			const { results } = await db
				.prepare(
					`SELECT ${ALL_COLUMNS.trim()}
					 FROM security_events ${where.sql} ORDER BY created_at DESC, id DESC LIMIT ?${where.values.length + 1}`,
				)
				.bind(...where.values, safeLimit)
				.all<SecurityEventDbRow>();

			return results.map(rowToEvent);
		},

		async countMatching(filters) {
			const retentionDays = await getTrackingRetentionDays(db);
			const cutoff = Date.now() - retentionDays * 86_400_000;
			const where = buildWhere({ ...filters, since: Math.max(filters.since ?? cutoff, cutoff) });
			const total = await db
				.prepare(`SELECT COUNT(*) as cnt FROM security_events ${where.sql}`)
				.bind(...where.values)
				.first<number>('cnt');
			return Number(total ?? 0);
		},

		async summarize() {
			const retentionDays = await getTrackingRetentionDays(db);
			const now = Date.now();
			const cutoff = now - retentionDays * 86_400_000;
			const dayAgo = Math.max(now - 86_400_000, cutoff);
			const [
				totalRow,
				enrichedRow,
				uniqueIpsRow,
				uniqueDevicesRow,
				last24hRow,
				bySurfaceResults,
				byEndpointResults,
			] = await Promise.all([
				db.prepare('SELECT COUNT(*) as cnt FROM security_events WHERE created_at >= ?1').bind(cutoff).first<number>('cnt'),
				db
					.prepare('SELECT COUNT(*) as cnt FROM security_events WHERE created_at >= ?1 AND device_fingerprint IS NOT NULL')
					.bind(cutoff)
					.first<number>('cnt'),
				db
					.prepare('SELECT COUNT(DISTINCT ip_address) as cnt FROM security_events WHERE created_at >= ?1')
					.bind(cutoff)
					.first<number>('cnt'),
				db
					.prepare('SELECT COUNT(DISTINCT device_fingerprint) as cnt FROM security_events WHERE created_at >= ?1 AND device_fingerprint IS NOT NULL')
					.bind(cutoff)
					.first<number>('cnt'),
				db
					.prepare('SELECT COUNT(*) as cnt FROM security_events WHERE created_at >= ?1')
					.bind(dayAgo)
					.first<number>('cnt'),
				db
					.prepare('SELECT surface, COUNT(*) as cnt FROM security_events WHERE created_at >= ?1 GROUP BY surface')
					.bind(cutoff)
					.all<{ surface: SecuritySurface; cnt: number }>(),
				db
					.prepare(
						'SELECT surface, endpoint, COUNT(*) as cnt FROM security_events WHERE created_at >= ?1 GROUP BY surface, endpoint ORDER BY cnt DESC',
					)
					.bind(cutoff)
					.all<{ surface: SecuritySurface; endpoint: string; cnt: number }>(),
			]);

			return {
				total: Number(totalRow ?? 0),
				retentionDays,
				bySurface: bySurfaceResults.results.map((r) => ({ surface: r.surface, count: Number(r.cnt) })),
				byEndpoint: byEndpointResults.results.map((r) => ({
					surface: r.surface,
					endpoint: r.endpoint,
					count: Number(r.cnt),
				})),
				enriched: Number(enrichedRow ?? 0),
				uniqueIps: Number(uniqueIpsRow ?? 0),
				uniqueDevices: Number(uniqueDevicesRow ?? 0),
				last24h: Number(last24hRow ?? 0),
			};
		},

		async topReferrers(since, limit, excludeHosts) {
			// Raw URL groups first (cheap SQL), then collapse to hosts in JS —
			// SQLite has no host() function and the dashboard only shows hosts.
			const { results } = await db
				.prepare(
					`SELECT referrer, COUNT(*) AS n
					 FROM security_events
					 WHERE created_at >= ?1 AND endpoint = 'page-view'
					   AND referrer IS NOT NULL AND referrer <> ''
					 GROUP BY referrer ORDER BY n DESC LIMIT 300`,
				)
				.bind(since)
				.all<{ referrer: string; n: number }>();
			const excluded = new Set(excludeHosts.map((host) => host.toLowerCase()));
			const byHost = new Map<string, number>();
			for (const row of results) {
				let host = '';
				try {
					host = new URL(String(row.referrer)).host.toLowerCase();
				} catch {
					continue;
				}
				if (!host || excluded.has(host)) continue;
				byHost.set(host, (byHost.get(host) ?? 0) + Number(row.n));
			}
			return [...byHost.entries()]
				.map(([host, count]) => ({ host, count }))
				.sort((a, b) => b.count - a.count || a.host.localeCompare(b.host))
				.slice(0, Math.min(50, Math.max(1, limit)));
		},
	};
}

/* --- selection ------------------------------------------------------------ */

export function getSecurityStore(env: Record<string, unknown> | undefined): SecurityStore | null {
	const db = env?.BOARD_DB as D1Database | undefined;
	if (db && typeof db.prepare === 'function') return createD1SecurityStore(db);
	return null;
}