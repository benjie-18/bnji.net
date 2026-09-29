/**
 * BNJI.NET — admin configuration surface.
 *
 *   GET /api/admin/config  ->  200 { config, bindings, secrets, profiles }
 *
 * One place that answers "what is this site actually configured to do?",
 * for the board AND the profile system AND everything else. The values come
 * from the same config modules the application itself imports, so this
 * endpoint can never drift from the running behaviour — there is no second
 * copy of any setting to keep in sync.
 *
 * SECRETS ARE NEVER RETURNED. This endpoint reports only whether each secret
 * is PRESENT (a boolean) and nothing else. The values themselves are never
 * serialised, not even truncated: a config dump that leaks "DISCORD_WEBHOOK_URL
 * is set" is fine, and one that leaks the first eight characters of a webhook
 * is not. src/server/env.ts is the only module that reads secret values, and
 * this route only asks it which names resolved.
 *
 * Admin-only. See src/server/admin.ts for the gate.
 */
import { BOARD_CONFIG } from '../../../config/board.config';
import { PROFILE_CONFIG, ALLOWED_REACTIONS } from '../../../config/profile.config';
import { SESSION_CONFIG } from '../../../config/session.config';
import { DM_INTEGRATION } from '../../../config/integrations.config';
import { MUSIC_LOOKUP, MUSIC_PLAYLIST, MUSIC_SOURCE } from '../../../config/music.config';
import { ACCESS_RULES, THEME_CONFIG, INTRO_CONFIG } from '../../../config/access.config';
import { SITE } from '../../../data/site';
import { getProfileBySlug, PROFILES } from '../../../data/profiles';
import { RETENTION_DAYS, CLEANUP_THRESHOLD } from '../../../server/security-store';
import { REPORT_RETENTION_DAYS } from '../../../server/board-store';
import { adminUnauthorized, isAdminRequest, adminNotConfigured, adminConfigured } from '../../../server/admin';
import { getSiteSettings, updateSiteSettings } from '../../../server/site-settings-store';
import { serverEnvironment } from '../../../server/env';
import type { APIContext } from 'astro';

export const prerender = false;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

/** Which bindings the Worker resolved, as booleans only. */
function bindingStatus(env: Record<string, unknown>): Record<string, boolean> {
	const check = (name: string): boolean => {
		const value = env[name];
		return value !== undefined && value !== null;
	};
	return {
		BOARD_DB: check('BOARD_DB'),
		BOARD_KV: check('BOARD_KV'),
		ASSETS: check('ASSETS'),
	};
}

export async function GET(context: APIContext): Promise<Response> {
	if (!(await adminConfigured())) return adminNotConfigured();
	if (!(await isAdminRequest(context))) return adminUnauthorized();

	const env = await serverEnvironment();

	// Presence only. The values stay in the environment.
	const secretPresence: Record<string, boolean> = {};
	for (const name of [
		// ACCESS_TOKEN is no longer consulted for the admin surface: the
		// access token now lives hashed in D1 (admin_credentials) and is
		// reported separately under `credential`. The generic env path in
		// src/server/access.ts still supports it for non-admin token rules.
		'ACCESS_TOKEN',
		'ACCESS_SECRET',
		'ACCESS_PASSWORD_SHA',
		'DISCORD_WEBHOOK_URL',
		'NTFY_URL',
		'BOARD_REST_URL',
		'BOARD_REST_TOKEN',
		// YouTube metadata lookup. Presence only: the value never leaves the
		// environment, so this reports whether the importer can use the Data
		// API, not what the key is.
		'YOUTUBE_API_KEY',
	]) {
		secretPresence[name] = Boolean(env[name]);
	}

	const dynamicSettings = await getSiteSettings();

	return json({
		generatedAt: new Date().toISOString(),

		site: { ...SITE },
		dynamicSettings,

		// Every public knob, grouped by the module that owns it. Each group
		// names its source file so an operator can go straight to the code.
		groups: [
			{
				id: 'board',
				source: 'src/config/board.config.ts',
				summary: 'Public message board — policy, limits, storage provider.',
				values: {
					provider: BOARD_CONFIG.provider,
					defaultVisible: BOARD_CONFIG.defaultVisible,
					minVisible: BOARD_CONFIG.minVisible,
					maxVisible: BOARD_CONFIG.maxVisible,
					pageSize: BOARD_CONFIG.pageSize,
					archivePageSize: BOARD_CONFIG.archivePageSize,
					maxTextLength: BOARD_CONFIG.maxTextLength,
					maxImageBytes: BOARD_CONFIG.maxImageBytes,
					allowedImageTypes: BOARD_CONFIG.allowedImageTypes,
					postCooldownSeconds: BOARD_CONFIG.postCooldownSeconds,
					hourlyPostLimit: BOARD_CONFIG.hourlyPostLimit,
					pollIntervalMs: BOARD_CONFIG.pollIntervalMs,
				},
			},
			{
				id: 'profile',
				source: 'src/config/profile.config.ts',
				summary: 'Profile pages — reactions, cooldowns, session cookie.',
				values: {
					allowedReactions: PROFILE_CONFIG.allowedReactions,
					reactionCooldownMs: PROFILE_CONFIG.reactionCooldownMs,
				},
			},
			{
				id: 'session',
				source: 'src/config/session.config.ts',
				summary: 'Shared per-visitor session identity (analytics + security correlation).',
				values: { ...SESSION_CONFIG },
			},
			{
				id: 'dm',
				source: 'src/config/integrations.config.ts',
				summary: 'Private direct messages. Provider is public; credentials are secret.',
				values: { ...DM_INTEGRATION },
			},
			{
				id: 'music',
				source: 'src/config/music.config.ts',
				summary:
					'Ordered background music playlist. This array is the seed and the offline fallback; the playlist itself lives in D1 (music_playlist_items) and is edited from /admin → Playlist.',
				values: { ...MUSIC_SOURCE },
			},
			{
				id: 'music-playlist',
				source: 'src/config/music.config.ts',
				summary: 'Admin-managed playlist limits and which metadata lookups are attempted.',
				values: {
					maxItems: MUSIC_PLAYLIST.maxItems,
					maxTitleLength: MUSIC_PLAYLIST.maxTitleLength,
					maxArtistLength: MUSIC_PLAYLIST.maxArtistLength,
					maxAlbumLength: MUSIC_PLAYLIST.maxAlbumLength,
					maxUrlLength: MUSIC_PLAYLIST.maxUrlLength,
					lookupTimeoutMs: MUSIC_PLAYLIST.lookupTimeoutMs,
					lookups: MUSIC_LOOKUP,
				},
			},
			{
				id: 'theme',
				source: 'src/config/access.config.ts',
				summary: 'Theme default, intro sequence, and route access rules.',
				values: {
					defaultTheme: THEME_CONFIG.defaultTheme,
					legacyStorageKey: THEME_CONFIG.storageKey,
					introEnabled: INTRO_CONFIG.enabled,
					introScrollHeights: INTRO_CONFIG.scrollHeights,
					accessRules: ACCESS_RULES,
				},
			},
		],

		// Operational policy that is not a single config value but governs
		// what the admin can see at all.
		retention: {
			securityEventsDays: RETENTION_DAYS,
			boardReportsDays: REPORT_RETENTION_DAYS,
			securityCleanupThreshold: CLEANUP_THRESHOLD,
		},

		environment: {
			bindings: bindingStatus(env),
			secrets: secretPresence,
			adminUsable: await adminConfigured(),
		},

		// What exists to be administered, not just configured.
		profiles: PROFILES.map((p) => ({
			slug: p.slug,
			displayName: p.displayName,
			links: p.links.length,
			hasAvatar: Boolean(p.avatar),
		})),

		// Values an operator would otherwise have to read the code for.
		facts: {
			allowedReactions: ALLOWED_REACTIONS,
			defaultProfileExists: Boolean(getProfileBySlug('gizlyy')),
		},
	});
}

export async function POST(context: APIContext): Promise<Response> {
	if (!(await adminConfigured())) return adminNotConfigured();
	if (!(await isAdminRequest(context))) return adminUnauthorized();

	let body: Record<string, unknown>;
	try {
		body = await context.request.json();
	} catch {
		return json({ error: 'invalid_json' }, 400);
	}

	const result = await updateSiteSettings(body);
	if (!result.ok) {
		return json({ error: result.error ?? 'failed_to_update' }, 500);
	}

	return json({ ok: true, dynamicSettings: result.settings });
}
