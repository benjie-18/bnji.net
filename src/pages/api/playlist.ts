/**
 * BNJI.NET — the public music playlist.
 *
 *   GET /api/playlist  ->  200 { initialized, count, tracks }
 *
 * The one read path the music player uses. It is public because the playlist
 * is public: it is the queue rendered in the pill on every page, and there is
 * nothing in it that is not already visible to a visitor. Everything an
 * operator can change lives behind /api/admin/*.
 *
 * WHY THE PLAYER FETCHES AT ALL
 * -----------------------------
 * The site is statically prerendered, so the markup a visitor receives was
 * built at deploy time from `MUSIC_SOURCE.tracks`. That array is now the SEED
 * and the fallback rather than the playlist, so the player asks this endpoint
 * what the queue actually is and swaps it in before it starts playing. The
 * static copy stays in the HTML as the no-JavaScript and no-D1 fallback.
 *
 * THE EMPTY-PLAYLIST RULE
 * -----------------------
 * `tracks: []` is a valid, meaningful answer: the operator removed everything.
 * It is returned as an empty array and the player shows an empty queue. It is
 * never replaced with the default playlist — only a database that has never
 * been seeded (`ensureSeeded`) copies the static array in, and that happens
 * exactly once (see migrations/0008_music_playlist.sql).
 *
 * If D1 is missing or the query fails, this route says so with a 503/500 and
 * the client keeps the static playlist: a database hiccup must not take the
 * site's music away.
 */
import { serverEnvironment } from '../../server/env';
import { getMusicPlaylistStore, toMusicTrack } from '../../server/music-store';
import type { APIContext } from 'astro';

export const prerender = false;

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
	});
}

export async function GET(): Promise<Response> {
	const env = await serverEnvironment();
	const store = getMusicPlaylistStore(env);
	if (!store) return json({ error: 'storage_unconfigured' }, 503);

	try {
		// Seeds on first read. After that this is a plain ordered SELECT.
		const items = await store.ensureSeeded();
		return json({
			initialized: true,
			count: items.length,
			tracks: items.map(toMusicTrack),
		});
	} catch (error) {
		console.error('[bnji] playlist read failed:', error);
		return json({ error: 'query_failed' }, 500);
	}
}
