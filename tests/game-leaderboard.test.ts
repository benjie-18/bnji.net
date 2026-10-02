/**
 * Per-game leaderboards: the catalog side, the page's static-route rule, the
 * component's hook contract, and the client's rendering.
 *
 * The load-bearing rule here is the LAST one: a leaderboard renders other
 * people's labels, so every row is built with `textContent`. A test that feeds
 * a hostile display name through the real client and reads the DOM back is the
 * only kind of test that can hold that line.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { getGame, getStandaloneGames, GAMES } from '../src/data/games';
import { hasLeaderboard, hasScoreVerifier, leaderboardHref, leaderboardModes, MODE_LABEL, SCORE_VERIFIER_GAMES } from '../src/data/game-adapters';
import { mountGameLeaderboard } from '../src/scripts/game-leaderboard';

const ORIGIN = 'https://bnji.test';
const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------- catalog rule */

test('every scored standalone game has a leaderboard; lab games and unscored games do not', () => {
	const boardGames = getStandaloneGames().filter(hasLeaderboard).map((game) => game.id).sort();
	assert.deepEqual(boardGames, ['bnji.chess', 'bnji.isometric-stack', 'bnji.pvp-minesweeper']);
	// The catalog is a union of shapes (lab cards carry `labHref`, standalone
	// games carry `href`), so read the route fields through the shared subset.
	const route = (game: (typeof GAMES)[number]): { href?: string; labHref?: string } => game as { href?: string; labHref?: string };
	for (const game of GAMES) {
		const { href, labHref } = route(game);
		if (labHref || !href || game.status !== 'available') assert.equal(hasLeaderboard(game), false, game.id);
	}
	// An unscored standalone game must not publish an empty board.
	const unscored = GAMES.filter((game) => route(game).href && !route(game).labHref && !hasScoreVerifier(game.id));
	for (const game of unscored) assert.equal(hasLeaderboard(game), false, game.id);
});

test('leaderboardHref is the game route with a /leaderboard/ sibling', () => {
	assert.equal(leaderboardHref(getGame('bnji.isometric-stack')!), '/games/stack/leaderboard/');
	assert.equal(leaderboardHref(getGame('bnji.pvp-minesweeper')!), '/games/pvp-minesweeper/leaderboard/');
	assert.equal(leaderboardHref(getGame('bnji.memory-pairs')!), null, 'lab games have no page of their own');
});

test('leaderboardModes mirrors the catalog, and every mode has a label', () => {
	for (const game of GAMES.filter(hasLeaderboard)) {
		const modes = leaderboardModes(game);
		assert.deepEqual(modes, game.modes ?? ['default']);
		for (const mode of modes) assert.ok(MODE_LABEL[mode], `${game.id} mode ${mode} has no label`);
	}
	assert.deepEqual(leaderboardModes({ modes: [] } as never), ['default']);
});

/* ------------------------------------------------------- page + component */

test('the leaderboard page prerenders one route per scored game and the component carries every hook the client uses', () => {
	const page = readFileSync(new URL('../src/pages/games/[game]/leaderboard.astro', import.meta.url), 'utf8');
	assert.match(page, /export function getStaticPaths\(\)/);
	assert.match(page, /getStandaloneGames\(\)/);
	assert.match(page, /\.filter\(hasLeaderboard\)/);
	assert.match(page, /<GameLeaderboard game=\{game\}/);

	const component = readFileSync(new URL('../src/components/GameLeaderboard.astro', import.meta.url), 'utf8');
	for (const hook of ['data-board', 'data-game-id', 'data-board-rows', 'data-board-status', 'data-board-more', 'data-board-you', 'data-board-you-value', 'data-board-tabs', 'data-board-indicator', 'data-board-mode']) {
		assert.ok(component.includes(hook), `GameLeaderboard.astro must carry ${hook}`);
	}
	assert.match(component, /modes\.length > 1/, 'the tab bar is only rendered when a game has more than one board');

	// Every scored game page links its board from the shell's fixed tool row,
	// and GameShell only renders the link when it is given one.
	const shell = readFileSync(new URL('../src/components/GameShell.astro', import.meta.url), 'utf8');
	assert.match(shell, /\{boardHref && <a class="game-shell__link game-shell__board" href=\{boardHref\}>Leaderboard<\/a>\}/);
	for (const slug of ['stack', 'chess', 'pvp-minesweeper']) {
		const page = readFileSync(new URL(`../src/pages/games/${slug}.astro`, import.meta.url), 'utf8');
		assert.match(page, /const boardHref = leaderboardHref\(getGame\('bnji\.[a-z.-]+'\)!\);/ , `${slug} computes its board route`);
		assert.match(page, /boardHref=\{boardHref\}/, `${slug} passes the board route to GameShell`);
	}
});

/* ------------------------------------------------------------------ client */

const CLIENT_DIR = new URL('../src/scripts/game-leaderboard.ts', import.meta.url);
void CLIENT_DIR; // keeps the path close to the other file reads, no runtime use

function boardDom(search = ''): JSDOM {
	const tabs = `<div class="glass-tabs" role="tablist"><div data-board-tabs>
		<button type="button" class="glass-tabs__item" data-board-mode="quick" aria-selected="true">Quick</button>
		<button type="button" class="glass-tabs__item" data-board-mode="normal" aria-selected="false">Normal</button>
		<span class="glass-tabs__indicator" data-board-indicator aria-hidden="true"></span>
	</div></div>`;
	return new JSDOM(`<!doctype html><html><body>
	<section class="leaderboard" data-board data-game-id="bnji.pvp-minesweeper">
		<p class="glass-note" data-board-you hidden><span data-board-you-value></span></p>
		${tabs}
		<ol data-board-rows></ol>
		<p data-board-status role="status"></p>
		<button type="button" data-board-more hidden>Load more</button>
	</section>
	</body></html>`, { url: `${ORIGIN}/games/pvp-minesweeper/leaderboard/${search}` });
}

type FetchCall = { url: string };
function install(dom: JSDOM, handler: (url: string) => unknown): FetchCall[] {
	const calls: FetchCall[] = [];
	const g = globalThis as Record<string, unknown>;
	g.window = dom.window;
	g.document = dom.window.document;
	g.location = dom.window.location;
	// jsdom without `pretendToBeVisual` has no animation frames; the shared
	// glass-tabs primitive uses one to re-enable its transition after an
	// instant placement.
	g.requestAnimationFrame = (callback: FrameRequestCallback) => Number(setTimeout(() => callback(0), 0));
	g.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
	g.fetch = (async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		calls.push({ url });
		return new Response(JSON.stringify(handler(url)), { status: 200, headers: { 'content-type': 'application/json' } });
	}) as unknown as typeof fetch;
	return calls;
}

function root(dom: JSDOM): HTMLElement {
	const element = dom.window.document.querySelector('[data-board]');
	assert.ok(element);
	return element as unknown as HTMLElement;
}

test('the client renders fetched rows with ranks and scores', async () => {
	const dom = boardDom();
	install(dom, (url) => url.startsWith('/api/games/leaderboard')
		? { rows: [{ displayName: '@ada · Ada Lovelace', score: 1200, tieBreak: null, achievedAt: Date.now() }, { displayName: '@bob · Bob', score: 900, tieBreak: 30, achievedAt: Date.now() }], hasMore: true }
		: { best: { score: 700 }, rank: 9, entries: 40, scope: 'account' });
	mountGameLeaderboard(root(dom));
	await tick(10);

	const rows = dom.window.document.querySelectorAll('[data-board-rows] > li');
	assert.equal(rows.length, 2);
	assert.equal(rows[0]!.querySelector('.leaderboard-row__rank')!.textContent, '#1');
	assert.equal(rows[0]!.querySelector('strong')!.textContent, '@ada · Ada Lovelace');
	assert.equal(rows[0]!.querySelector('.leaderboard-row__score')!.textContent, '1,200');
	assert.match(rows[1]!.querySelector('.leaderboard-row__meta')!.textContent ?? '', /tie-break 30/);
	const more = dom.window.document.querySelector<HTMLButtonElement>('[data-board-more]')!;
	assert.equal(more.hidden, false);
	assert.equal(dom.window.document.querySelector('[data-board-you]')!.hasAttribute('hidden'), false);
	assert.match(dom.window.document.querySelector('[data-board-you-value]')!.textContent ?? '', /Your best: 700 · rank #9 of 40\./);
});

test('another player’s label is inserted as TEXT, never as markup', async () => {
	const hostile = '<img src=x onerror="window.__pwned=1"> · Ada';
	const dom = boardDom();
	install(dom, (url) => url.startsWith('/api/games/leaderboard')
		? { rows: [{ displayName: hostile, score: 1, tieBreak: null, achievedAt: Date.now() }], hasMore: false }
		: { best: null, rank: null, entries: 0, scope: 'guest' });
	mountGameLeaderboard(root(dom));
	await tick(10);

	const cell = dom.window.document.querySelector('[data-board-rows] strong')!;
	assert.equal(cell.textContent, hostile);
	assert.equal(cell.querySelector('img'), null, 'a leaderboard must never build a row with innerHTML');
	assert.equal((dom.window as unknown as { __pwned?: number }).__pwned, undefined);
});

test('mode and page live in the query string, and a tab click refetches that board', async () => {
	const dom = boardDom('');
	const calls = install(dom, () => ({ rows: [], hasMore: false }));
	mountGameLeaderboard(root(dom));
	await tick(10);
	assert.equal(new URL(dom.window.location.href).searchParams.get('mode'), null, 'the first mode is the default and stays out of the URL');

	dom.window.document.querySelector<HTMLButtonElement>('[data-board-mode="normal"]')!.click();
	await tick(10);
	assert.equal(new URL(dom.window.location.href).searchParams.get('mode'), 'normal');
	assert.equal(dom.window.document.querySelector('[data-board-mode="normal"]')!.getAttribute('aria-selected'), 'true');
	assert.equal(dom.window.document.querySelector('[data-board-mode="quick"]')!.getAttribute('aria-selected'), 'false');
	assert.ok(calls.some((call) => call.url.includes('mode=normal&page=0')), 'switching modes loads page 0 of that mode');

	// "Load more" advances the page and keeps it shareable.
	install(dom, (url) => url.startsWith('/api/games/leaderboard') ? { rows: [{ displayName: '@zig · Zig', score: 5, tieBreak: null, achievedAt: Date.now() }], hasMore: false } : { best: null, rank: null, entries: 0 });
	dom.window.document.querySelector<HTMLButtonElement>('[data-board-more]')!.hidden = false;
	(dom.window.document.querySelector('[data-board-more]') as unknown as HTMLElement).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
	await tick(10);
	assert.equal(new URL(dom.window.location.href).searchParams.get('page'), '1');
});

test('an initial ?mode= wins, and the client says so when a board is empty', async () => {
	const dom = boardDom('?mode=normal');
	const calls = install(dom, (url) => url.startsWith('/api/games/leaderboard') ? { rows: [], hasMore: false } : { best: null, rank: null, entries: 0 });
	mountGameLeaderboard(root(dom));
	await tick(10);
	assert.ok(calls.some((call) => call.url.includes('mode=normal')), 'a shared link opens the mode it names');
	const empty = dom.window.document.querySelector('[data-board-rows]')!.textContent ?? '';
	assert.match(empty, /No verified runs on this board yet/);
});

test('a rate-limited board explains itself and a guest sees guest framing', async () => {
	const dom = boardDom();
	const g = globalThis as Record<string, unknown>;
	g.window = dom.window;
	g.document = dom.window.document;
	g.location = dom.window.location;
	// jsdom without `pretendToBeVisual` has no animation frames; the shared
	// glass-tabs primitive uses one to re-enable its transition after an
	// instant placement.
	g.requestAnimationFrame = (callback: FrameRequestCallback) => Number(setTimeout(() => callback(0), 0));
	g.cancelAnimationFrame = (handle: number) => clearTimeout(handle);
	g.fetch = (async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		if (url.startsWith('/api/games/leaderboard')) return new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 });
		return new Response(JSON.stringify({ best: { score: 3 }, rank: null, entries: 2, scope: 'guest' }), { status: 200 });
	}) as unknown as typeof fetch;
	mountGameLeaderboard(root(dom));
	await tick(10);
	assert.match(dom.window.document.querySelector('[data-board-status]')!.textContent ?? '', /Too many board reads/);
	assert.match(dom.window.document.querySelector('[data-board-you-value]')!.textContent ?? '', /among 2 runs \(guest session\)/);
});
