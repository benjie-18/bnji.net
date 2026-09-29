/**
 * BNJI.NET — site-wide statistics.
 *
 *   GET /api/admin/stats -> 200 { generatedAt, traffic, engagement, board, security }
 *
 * Everything here is read through the SAME store methods the public features
 * already use. That is the point: `getViewStats()` is the one definition of
 * what a "view" is on this site, and the public profile page renders the very
 * same number. A dashboard that re-derived traffic from a different query
 * would eventually disagree with the page it is supposed to explain.
 *
 * Nothing is invented. Every figure below is backed by a column that exists
 * in the schema, and the panel labels each group with where it came from. If
 * a number has no underlying data it is absent rather than zeroed, because a
 * dashboard full of convincing zeroes is worse than an empty one.
 *
 * Admin-only. See src/server/admin.ts for the gate.
 */
import { adminUnauthorized, isAdminRequest, adminNotConfigured, adminConfigured, adminTokenUpdatedAt } from '../../../server/admin';
import { getProfileStore, type TimeSeriesScope, type TimeSeriesRange } from '../../../server/profile-store';
import { getBoardStore } from '../../../server/board-store';
import { getSecurityStore } from '../../../server/security-store';
import { getSecretCodeStore } from '../../../server/secret-code-store';
import { getProfileBySlug, PROFILES } from '../../../data/profiles';
import { serverEnvironment } from '../../../server/env';
import { clientIp } from '../../../server/security-helpers';
import { rateLimit, type KvRateLimitStore } from '../../../server/ratelimit';
import type { APIContext } from 'astro';

export const prerender = false;

/**
 * This endpoint runs a handful of aggregate COUNTs across four tables. It is
 * admin-only already, but a cheap ceiling costs nothing and keeps a stray
 * loop of dashboard refreshes from turning into a scan. Fails open on KV
 * trouble — see src/server/ratelimit.ts.
 */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_HITS = 30;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

const DAY_MS = 86_400_000;

export async function GET(context: APIContext): Promise<Response> {
	if (!(await adminConfigured())) return adminNotConfigured();
	if (!(await isAdminRequest(context))) return adminUnauthorized();

	const env = await serverEnvironment();
	const kv = env.BOARD_KV as KvRateLimitStore | undefined;
	const limit = await rateLimit(kv, `admin:stats:${clientIp(context.request)}`, RATE_WINDOW_MS, RATE_MAX_HITS);
	if (!limit.allowed) {
		return json({ error: 'rate_limited', retryAfter: limit.retryAfter }, 429);
	}

	const now = Date.now();
	const profileStore = getProfileStore(env);
	const boardStore = getBoardStore(env);
	const securityStore = getSecurityStore(env);
	const secretCodeStore = getSecretCodeStore(env);

	const params = context.url.searchParams;
	const scope = (params.get('scope') ?? 'global') as TimeSeriesScope;
	const timeRange = (params.get('timeRange') ?? 'day') as TimeSeriesRange;

	/* --- traffic: profile views ------------------------------------------- */
	// Per profile, from getViewStats() — the same call the public profile page
	// makes, so the dashboard and the public number are the same number.
	// `total` there is the count of distinct (session, day) pairs, i.e.
	// one view per session per day, which is what "views" means on this site.
	const traffic: {
		profiles: { slug: string; name: string; total: number; today: number; week: number; month: number }[];
		siteTotal: number;
		note: string;
	} = { profiles: [], siteTotal: 0, note: 'One view per session per day, counted by the profile analytics store.' };

	let timeSeries: unknown[] = [];

	if (profileStore) {
		try {
			const trackedPages = await profileStore.getAllTrackedPages();
			for (const p of trackedPages) {
				traffic.profiles.push(p);
				traffic.siteTotal += p.total;
			}
			timeSeries = await profileStore.getTimeSeriesViews(scope, timeRange);
		} catch (error) {
			console.warn('[bnji] stats: view stats failed', error);
		}
	}

	/* --- engagement: reactions + link clicks ------------------------------ */
	// Only reported for profiles that define links/reactions, and only when
	// the store answers. A profile with no links gets no clicks group rather
	// than a misleading "0 clicks" row.
	const engagement: {
		profiles: {
			slug: string;
			reactions: { reaction: string; count: number }[];
			reactionTotal: number;
			linkClicks: { linkId: string; label: string; count: number }[];
			clickTotal: number;
		}[];
	} = { profiles: [] };

	if (profileStore) {
		for (const profile of PROFILES) {
			try {
				const [reactions, clicks] = await Promise.all([
					profileStore.getReactionCounts(profile.slug),
					profileStore.getLinkClicks(profile.slug),
				]);
				const reactionTotal = Object.values(reactions).reduce((s, n) => s + n, 0);
				const clickTotal = Object.values(clicks).reduce((s, n) => s + n, 0);
				if (reactionTotal === 0 && clickTotal === 0) continue;
				// Labels come from the profile data so the dashboard speaks the
				// same words as the public page ("Reddit", not "reddit").
				const linkLabels = new Map(profile.links.map((l) => [l.id, l.label] as const));
				engagement.profiles.push({
					slug: profile.slug,
					reactions: Object.entries(reactions)
						.map(([reaction, count]) => ({ reaction, count: Number(count) }))
						.sort((a, b) => b.count - a.count),
					reactionTotal,
					linkClicks: Object.entries(clicks)
						.map(([linkId, count]) => ({
							linkId,
							label: linkLabels.get(linkId) ?? linkId,
							count: Number(count),
						}))
						.sort((a, b) => b.count - a.count),
					clickTotal,
				});
			} catch (error) {
				console.warn('[bnji] stats: engagement failed for', profile.slug, error);
			}
		}
	}

	/* --- board ------------------------------------------------------------ */
	// summarize() is the store's own aggregate; the per-status breakdown is
	// what the moderation tab filters on, so the two agree by construction.
	const board = boardStore
		? await boardStore
				.summarize()
				.then((s) => ({
					...s,
					reportedPending: s.byStatus.find((x) => x.status === 'reported')?.count ?? 0,
					note: 'Messages currently in the store, by moderation status.',
				}))
				.catch((error) => {
					console.warn('[bnji] stats: board summary failed', error);
					return null;
				})
		: null;

	/* --- security --------------------------------------------------------- */
	// The security_events log. `enriched` and `uniqueDevices` depend on the
	// client fingerprint beacon having fired, so they read 0 until devices
	// send it — that is real, not missing.
	const security = securityStore
		? await securityStore
				.summarize()
				.catch((error) => {
					console.warn('[bnji] stats: security summary failed', error);
					return null;
				})
		: null;

	/* --- secret codes ----------------------------------------------------- */
	const secretCodes = secretCodeStore
		? await secretCodeStore.getCodeStats().catch((error) => {
				console.warn('[bnji] stats: secret codes summary failed', error);
				return [];
		  })
		: [];

	/* --- credential ------------------------------------------------------- */
	// When the access token was last rotated. 0 means the seeded value is
	// still in place, which the panel surfaces as a prompt to change it.
	const tokenRotatedAt = await adminTokenUpdatedAt();

	return json({
		generatedAt: now,
		traffic,
		timeSeries,
		engagement,
		board,
		security,
		secretCodes,
		credential: { tokenRotatedAt, everRotated: tokenRotatedAt > 0 },
		generatedAtIso: new Date(now).toISOString(),
		dayMs: DAY_MS,
	});
}
