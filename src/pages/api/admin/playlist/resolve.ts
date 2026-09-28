/**
 * BNJI.NET — admin playlist metadata resolution.
 *
 *   POST /api/admin/playlist/resolve  { url }
 *         -> 200 { draft: ResolvedMusicMetadata }
 *         -> 400 { error: 'invalid_link', message }
 *         -> 503 { error: 'storage_unconfigured' }
 *
 * Resolves ONE link into an editable draft. This route never writes anything:
 * the panel shows the draft, the operator edits it, and the save goes to
 * POST /api/admin/playlist. Keeping resolution and persistence apart is what
 * makes "the provider is down" a recoverable state instead of a failed save.
 *
 * WHERE THE REQUESTS GO
 * ---------------------
 * Only to the fixed endpoints in MUSIC_PROVIDER_URLS, built from a video id
 * that parseMusicLink() already validated. The submitted URL itself is never
 * fetched — see src/server/music-links.ts for why that matters.
 *
 * WHAT COMES BACK
 * ---------------
 * Draft field values and a description of which lookups ran. Never a
 * credential: the YouTube API key is read from the environment inside
 * src/server/music-metadata.ts and is used for exactly the request it was
 * obtained for.
 *
 * An unusable provider is a NORMAL answer. `status: 'unavailable'` means the
 * panel should say so and offer manual entry, which is why this route answers
 * 200 for it: the request succeeded, the metadata simply did not exist.
 */
import { MUSIC_LOOKUP } from '../../../../config/music.config';
import { resolveMusicMetadata } from '../../../../server/music-metadata';
import { IMPORTABLE_PROVIDER, IMPORTABLE_PROVIDER_MESSAGE, parseMusicLink } from '../../../../server/music-links';
import { adminConfigured, adminNotConfigured, adminUnauthorized, isAdminRequest } from '../../../../server/admin';
import { serverEnvironment } from '../../../../server/env';
import type { APIContext } from 'astro';

export const prerender = false;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

export async function POST(context: APIContext): Promise<Response> {
	if (!(await adminConfigured())) return adminNotConfigured();
	if (!(await isAdminRequest(context))) return adminUnauthorized();

	let payload: unknown;
	try {
		payload = await context.request.json();
	} catch {
		return json({ error: 'invalid_json' }, 400);
	}

	const body = (payload ?? {}) as { url?: unknown };
	const link = parseMusicLink(body.url);
	if (!link.ok) return json({ error: 'invalid_link', message: link.message }, 400);
	// The panel imports YouTube links only — see IMPORTABLE_PROVIDER. Refused
	// here rather than resolved and then half-saved, so the operator never gets
	// a draft whose date field this route cannot carry.
	if (link.provider !== IMPORTABLE_PROVIDER) {
		return json({ error: 'invalid_link', message: IMPORTABLE_PROVIDER_MESSAGE }, 400);
	}

	const env = await serverEnvironment();
	try {
		const draft = await resolveMusicMetadata(link, env);
		return json({ draft, capabilities: { ...MUSIC_LOOKUP } });
	} catch (error) {
		// A throw here is a bug in the lookup path, not a provider refusal —
		// provider refusals are reported inside the draft. It still must not
		// take the feature down with it: the link is valid, so the operator can
		// type the metadata in. Returning an empty manual draft is what keeps
		// that fallback reachable, with the failure left in the Worker log.
		console.error('[bnji] playlist metadata resolution failed:', error);
		return json({
			draft: {
				provider: link.provider,
				id: link.id,
				url: link.canonicalUrl,
				source: 'manual',
				status: 'unavailable',
				message: 'Metadata lookup failed on the server. Enter the title and any details, then save.',
				fields: {},
				artistIsSuggestion: false,
				lookups: [],
			},
			capabilities: { ...MUSIC_LOOKUP },
		});
	}
}
