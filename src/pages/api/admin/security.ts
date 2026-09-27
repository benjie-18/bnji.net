/**
 * BNJI.NET — admin security events endpoint.
 *
 *   GET /api/admin/security?limit=50
 *       [&surface=profile|board|dm]
 *       [&profileSlug=gizlyy]
 *       [&enrichedOnly=1]
 *       [&ip=203.0.113.45]
 *       [&device=af72f9024f60a24e]
 *       [&since=<epoch ms>]
 *       [&summary=1]
 *       Authorization: Bearer <ACCESS_TOKEN>      (or an admin session cookie)
 *   -> 200 { events, total, retentionDays, ... }
 *
 * Returns recent security events (newest first) from the security_events
 * table — the same table the profile pages and the message board write to,
 * tagged by surface.
 *
 * The filters exist so the common investigation is one request, not a
 * spreadsheet: `?device=<fingerprint>` answers "everything this device did,
 * across every surface", which is the question an abuse report actually
 * asks. `?enrichedOnly=1` narrows to rows that carry client device data.
 *
 * ⚠️ STOPGAP AUTH — a single shared secret, not a user system. No roles, no
 * operator identity, no audit trail of who used the token. It exists so the
 * table holding IP addresses, precise geolocation and device fingerprints is
 * unreachable without a secret that never lives in the repository. See
 * src/server/admin.ts and src/server/access.ts.
 *
 * SECURITY: the response is full of personal information under Quebec Law 25
 * and PIPEDA. It is gated, `no-store`, and must never be linked from a public
 * page. Retention (60 days, lazily purged here) bounds the exposure.
 */
import {
	SECURITY_SURFACES,
	getSecurityStore,
	type SecuritySurface,
} from '../../../server/security-store';
import { adminConfigured, adminNotConfigured, adminUnauthorized, isAdminRequest } from '../../../server/admin';
import { serverEnvironment } from '../../../server/env';
import type { APIContext } from 'astro';

export const prerender = false;

const MAX_LIMIT = 500;
const MAX_FILTER_LENGTH = 128;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

export async function GET(context: APIContext): Promise<Response> {
	if (!(await adminConfigured())) return adminNotConfigured();
	if (!(await isAdminRequest(context))) return adminUnauthorized();

	const env = await serverEnvironment();
	const store = getSecurityStore(env);
	if (!store) return json({ error: 'storage_unavailable' }, 503);

	const params = context.url.searchParams;

	// Reject an unknown surface instead of silently ignoring it: an operator
	// who types ?surface=biard should be told, not handed a full unfiltered
	// dump that looks like their filter worked.
	const surfaceParam = params.get('surface');
	if (surfaceParam && !(SECURITY_SURFACES as readonly string[]).includes(surfaceParam)) {
		return json({ error: 'invalid_surface', allowed: SECURITY_SURFACES }, 400);
	}
	const surface = (surfaceParam ?? undefined) as SecuritySurface | undefined;

	const sinceParam = params.get('since');
	const since = sinceParam === null ? undefined : Number(sinceParam);
	if (since !== undefined && !Number.isFinite(since)) {
		return json({ error: 'invalid_since' }, 400);
	}

	const ip = params.get('ip')?.slice(0, MAX_FILTER_LENGTH) || undefined;
	const device = params.get('device')?.slice(0, MAX_FILTER_LENGTH) || undefined;
	const profileSlug = params.get('profileSlug')?.slice(0, MAX_FILTER_LENGTH) || undefined;
	const enrichedOnly = params.get('enrichedOnly') === '1';
	const wantsSummary = params.get('summary') === '1';
	const limit = Math.min(Math.max(1, Number(params.get('limit')) || 50), MAX_LIMIT);

	const filters = {
		...(surface ? { surface } : {}),
		...(profileSlug ? { profileSlug } : {}),
		...(ip ? { ipAddress: ip } : {}),
		...(device ? { deviceFingerprint: device } : {}),
		...(enrichedOnly ? { enrichedOnly: true } : {}),
		...(since !== undefined ? { since } : {}),
	};

	try {
		// Sequential, not Promise.all: listRecent triggers the retention purge,
		// so a parallel count would report pre-purge totals on the read that
		// actually deleted rows.
		const events = await store.listRecent({ ...filters, limit });
		const payload: Record<string, unknown> = {
			events,
			total: await store.countMatching(filters),
			retentionDays: 60,
			filters: {
				surface: surface ?? null,
				profileSlug: profileSlug ?? null,
				ip: ip ?? null,
				device: device ?? null,
				enrichedOnly,
				since: since ?? null,
			},
		};
		if (wantsSummary) {
			payload.summary = await store.summarize();
		}
		return json(payload);
	} catch (error) {
		console.warn('[bnji] admin security query failed:', error);
		return json({ error: 'query_failed' }, 500);
	}
}
