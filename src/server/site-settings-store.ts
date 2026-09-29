/**
 * BNJI.NET — site settings server store.
 *
 * Provides D1-backed persistence for dynamic site configuration overrides.
 * Falls back to static configuration defaults when D1 is unconfigured or a key
 * is absent.
 */
import { BOARD_CONFIG, type BoardConfig } from '../config/board.config';
import { DM_INTEGRATION, type DmIntegrationConfig } from '../config/integrations.config';
import { THEME_CONFIG, INTRO_CONFIG } from '../config/access.config';
import { SITE } from '../data/site';
import { serverEnvironment } from './env';

export type DynamicSiteSettings = {
	// Board policy
	boardProvider: 'd1' | 'rest';
	boardMaxTextLength: number;
	boardPostCooldownSeconds: number;
	boardHourlyPostLimit: number;
	boardPollIntervalMs: number;
	boardMaxImageBytes: number;

	// DM integration policy
	dmProvider: 'none' | 'discord' | 'ntfy';
	dmMaxLength: number;
	dmCooldownSeconds: number;

	// Identity & Branding
	siteName: string;
	siteTitle: string;
	siteDescription: string;
	authorName: string;
	authorLocation: string;

	// System defaults
	defaultTheme: 'dark' | 'light';
	introEnabled: boolean;
};

export const DYNAMIC_SETTINGS_DEFAULTS: DynamicSiteSettings = {
	boardProvider: BOARD_CONFIG.provider,
	boardMaxTextLength: BOARD_CONFIG.maxTextLength,
	boardPostCooldownSeconds: BOARD_CONFIG.postCooldownSeconds,
	boardHourlyPostLimit: BOARD_CONFIG.hourlyPostLimit,
	boardPollIntervalMs: BOARD_CONFIG.pollIntervalMs,
	boardMaxImageBytes: BOARD_CONFIG.maxImageBytes,

	dmProvider: DM_INTEGRATION.provider,
	dmMaxLength: DM_INTEGRATION.maxLength,
	dmCooldownSeconds: DM_INTEGRATION.cooldownSeconds,

	siteName: SITE.name,
	siteTitle: SITE.title,
	siteDescription: SITE.description,
	authorName: SITE.author.name,
	authorLocation: SITE.author.location,

	defaultTheme: THEME_CONFIG.defaultTheme,
	introEnabled: INTRO_CONFIG.enabled,
};

type D1Database = {
	prepare: (query: string) => {
		bind: (...args: unknown[]) => {
			all: <T = Record<string, unknown>>() => Promise<{ results?: T[] }>;
			run: () => Promise<{ success: boolean }>;
		};
	};
};

function getD1Db(env: Record<string, unknown>): D1Database | null {
	const db = env.BOARD_DB as D1Database | undefined;
	return db && typeof db.prepare === 'function' ? db : null;
}

/** Get all site settings, merging stored D1 overrides over hardcoded defaults. */
export async function getSiteSettings(): Promise<DynamicSiteSettings> {
	const env = await serverEnvironment();
	const db = getD1Db(env);
	if (!db) return { ...DYNAMIC_SETTINGS_DEFAULTS };

	try {
		const res = await db.prepare('SELECT key, value FROM site_settings').bind().all<{ key: string; value: string }>();
		const rows = res.results ?? [];
		const overrides: Partial<Record<keyof DynamicSiteSettings, unknown>> = {};

		for (const row of rows) {
			try {
				overrides[row.key as keyof DynamicSiteSettings] = JSON.parse(row.value);
			} catch {
				overrides[row.key as keyof DynamicSiteSettings] = row.value;
			}
		}

		return sanitizeSettings({ ...DYNAMIC_SETTINGS_DEFAULTS, ...overrides });
	} catch {
		return { ...DYNAMIC_SETTINGS_DEFAULTS };
	}
}

/** Sanitize and validate arbitrary incoming setting updates. */
export function sanitizeSettings(raw: Record<string, unknown>): DynamicSiteSettings {
	const num = (v: unknown, fallback: number, min: number, max: number) => {
		const n = Number(v);
		return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
	};
	const str = (v: unknown, fallback: string, maxLen = 300) =>
		typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, maxLen) : fallback;
	const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

	return {
		boardProvider: raw.boardProvider === 'rest' ? 'rest' : 'd1',
		boardMaxTextLength: Math.round(num(raw.boardMaxTextLength, DYNAMIC_SETTINGS_DEFAULTS.boardMaxTextLength, 10, 1000)),
		boardPostCooldownSeconds: Math.round(num(raw.boardPostCooldownSeconds, DYNAMIC_SETTINGS_DEFAULTS.boardPostCooldownSeconds, 0, 3600)),
		boardHourlyPostLimit: Math.round(num(raw.boardHourlyPostLimit, DYNAMIC_SETTINGS_DEFAULTS.boardHourlyPostLimit, 1, 1000)),
		boardPollIntervalMs: Math.round(num(raw.boardPollIntervalMs, DYNAMIC_SETTINGS_DEFAULTS.boardPollIntervalMs, 0, 120000)),
		boardMaxImageBytes: Math.round(num(raw.boardMaxImageBytes, DYNAMIC_SETTINGS_DEFAULTS.boardMaxImageBytes, 100 * 1024, 1800 * 1024)),

		dmProvider: raw.dmProvider === 'discord' || raw.dmProvider === 'ntfy' ? raw.dmProvider : 'none',
		dmMaxLength: Math.round(num(raw.dmMaxLength, DYNAMIC_SETTINGS_DEFAULTS.dmMaxLength, 50, 5000)),
		dmCooldownSeconds: Math.round(num(raw.dmCooldownSeconds, DYNAMIC_SETTINGS_DEFAULTS.dmCooldownSeconds, 0, 3600)),

		siteName: str(raw.siteName, DYNAMIC_SETTINGS_DEFAULTS.siteName, 50),
		siteTitle: str(raw.siteTitle, DYNAMIC_SETTINGS_DEFAULTS.siteTitle, 100),
		siteDescription: str(raw.siteDescription, DYNAMIC_SETTINGS_DEFAULTS.siteDescription, 300),
		authorName: str(raw.authorName, DYNAMIC_SETTINGS_DEFAULTS.authorName, 100),
		authorLocation: str(raw.authorLocation, DYNAMIC_SETTINGS_DEFAULTS.authorLocation, 100),

		defaultTheme: raw.defaultTheme === 'light' ? 'light' : 'dark',
		introEnabled: bool(raw.introEnabled, DYNAMIC_SETTINGS_DEFAULTS.introEnabled),
	};
}

/** Update site settings in D1. */
export async function updateSiteSettings(
	partial: Partial<DynamicSiteSettings>,
): Promise<{ ok: boolean; settings: DynamicSiteSettings; error?: string }> {
	const env = await serverEnvironment();
	const db = getD1Db(env);
	if (!db) return { ok: false, settings: { ...DYNAMIC_SETTINGS_DEFAULTS }, error: 'storage_unconfigured' };

	const current = await getSiteSettings();
	const next = sanitizeSettings({ ...current, ...partial });
	const now = Date.now();

	try {
		for (const key of Object.keys(partial) as (keyof DynamicSiteSettings)[]) {
			const value = JSON.stringify(next[key]);
			await db.prepare('INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
				.bind(key, value, now)
				.run();
		}
		return { ok: true, settings: next };
	} catch (e) {
		return { ok: false, settings: current, error: String(e) };
	}
}
