/**
 * BNJI.NET — admin music playlist mutations.
 *
 *   GET    /api/admin/playlist          -> 200 { items, initialized, count, limits }
 *   POST   /api/admin/playlist          -> 201 { ok, item, count }
 *   DELETE /api/admin/playlist?id=<id>  -> 200 { ok, count } | 404
 *
 * Metadata resolution lives in ./resolve.ts and reordering in ./order.ts: one
 * concern per route, so the panel's three actions cannot share a validation
 * mistake.
 *
 * Admin-only. Every method calls the ONE guard in src/server/admin.ts, the same
 * one the middleware uses, so the page and the endpoint cannot disagree about
 * who may edit the playlist. Cross-site writes are refused by Astro's
 * `checkOrigin` (on by default) and by the SameSite=Strict session cookie.
 *
 * VALIDATION IS THE WHOLE JOB
 * ---------------------------
 * The URL is parsed, not trusted: it must be one https link on an allowlisted
 * provider host naming one valid id, and the stored link is rebuilt from that
 * id. A title is required; artist, album and dates are optional and are the
 * operator's to leave blank. Nothing here accepts an arbitrary URL, a
 * provider-returned embed, or a second link in one request.
 */
import { MUSIC_PLAYLIST } from '../../../config/music.config';
import { cleanMusicText, normalizeMusicDate } from '../../../server/music-metadata';
import { parseMusicLink, type MusicLinkProvider } from '../../../server/music-links';
import { getMusicPlaylistStore, type StoredPlaylistItem } from '../../../server/music-store';
import { adminConfigured, adminNotConfigured, adminUnauthorized, isAdminRequest } from '../../../server/admin';
import { serverEnvironment } from '../../../server/env';
import type { APIContext } from 'astro';

export const prerender = false;

const MAX_ID_LENGTH = 64;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
	});
}

type DraftPayload = {
	url: string;
	title: string;
	artist?: string;
	album?: string;
	publishedAt?: string;
	releaseDate?: string;
};

type Validation =
	| { ok: true; value: DraftPayload; provider: MusicLinkProvider; sourceId: string }
	| { ok: false; error: string; message: string };

/**
 * Turn a submitted draft into a storable one, or explain why it cannot be.
 *
 * The link is re-parsed here even though ./resolve.ts already parsed it: the
 * two requests are separate, and a save that trusted an earlier parse would be
 * a save that trusts the client's word for what it sent.
 */
function validateDraft(body: Record<string, unknown>): Validation {
	const link = parseMusicLink(body.url);
	if (!link.ok) return { ok: false, error: 'invalid_link', message: link.message };

	// A title is the one required field: a link plus a title is a complete,
	// playable playlist entry, and everything else is enrichment the operator
	// can add later (or never).
	const title = cleanMusicText(body.title, MUSIC_PLAYLIST.maxTitleLength);
	if (!title) {
		return { ok: false, error: 'title_required', message: 'A title is required to save this track.' };
	}

	const artist = cleanMusicText(body.artist, MUSIC_PLAYLIST.maxArtistLength);
	const album = cleanMusicText(body.album, MUSIC_PLAYLIST.maxAlbumLength);
	const publishedAt = normalizeMusicDate(body.publishedAt);
	const releaseDate = normalizeMusicDate(body.releaseDate);

	return {
		ok: true,
		provider: link.provider,
		sourceId: link.id,
		value: {
			url: link.canonicalUrl,
			title,
			...(artist ? { artist } : {}),
			...(album ? { album } : {}),
			...(publishedAt ? { publishedAt } : {}),
			...(releaseDate ? { releaseDate } : {}),
		},
	};
}

export async function GET(context: APIContext): Promise<Response> {
	if (!(await adminConfigured())) return adminNotConfigured();
	if (!(await isAdminRequest(context))) return adminUnauthorized();

	const env = await serverEnvironment();
	const store = getMusicPlaylistStore(env);
	if (!store) return json({ error: 'storage_unconfigured' }, 503);

	try {
		const [items, initialized] = await Promise.all([store.list(), store.isInitialized()]);
		return json({
			items,
			initialized,
			count: items.length,
			limits: { ...MUSIC_PLAYLIST },
		});
	} catch (error) {
		console.error('[bnji] admin playlist list failed:', error);
		return json({ error: 'query_failed' }, 500);
	}
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

	const body = (payload ?? {}) as Record<string, unknown>;
	const validated = validateDraft(body);
	if (!validated.ok) return json({ error: validated.error, message: validated.message }, 400);

	const env = await serverEnvironment();
	const store = getMusicPlaylistStore(env);
	if (!store) return json({ error: 'storage_unconfigured' }, 503);

	try {
		// The seed must exist before the first insert, or the new item would
		// land at position 0 and push the seeded track out of first place.
		await store.ensureSeeded();

		const item: StoredPlaylistItem = await store.add({
			id: crypto.randomUUID(),
			...validated.value,
			provider: validated.provider,
			// The provider id the canonical link was built from, so the item can
			// be re-resolved later without re-parsing a pasted URL.
			sourceId: validated.sourceId,
		});

		return json({ ok: true, item, count: (await store.list()).length }, 201);
	} catch (error) {
		// A full playlist is an operator condition, not a server fault: say so
		// plainly rather than returning an opaque 500.
		if (error instanceof Error && error.message === 'playlist_full') {
			return json(
				{ error: 'playlist_full', message: `The playlist already holds ${MUSIC_PLAYLIST.maxItems} items.` },
				422,
			);
		}
		console.error('[bnji] admin playlist add failed:', error);
		return json({ error: 'query_failed' }, 500);
	}
}

export async function DELETE(context: APIContext): Promise<Response> {
	if (!(await adminConfigured())) return adminNotConfigured();
	if (!(await isAdminRequest(context))) return adminUnauthorized();

	const id = context.url.searchParams.get('id') ?? '';
	if (!id || id.length > MAX_ID_LENGTH) return json({ error: 'invalid_id' }, 400);

	const env = await serverEnvironment();
	const store = getMusicPlaylistStore(env);
	if (!store) return json({ error: 'storage_unconfigured' }, 503);

	try {
		const removed = await store.remove(id);
		if (!removed) return json({ error: 'not_found' }, 404);
		return json({ ok: true, count: (await store.list()).length });
	} catch (error) {
		console.error('[bnji] admin playlist remove failed:', error);
		return json({ error: 'query_failed' }, 500);
	}
}
