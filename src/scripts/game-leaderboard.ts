/**
 * `/games/<game>/leaderboard/` client: mode tabs, one board at a time, paged.
 *
 * The page is static (mode and page are query parameters), so this module owns
 * every piece of state the board has: which mode is showing, which page is
 * loaded, and the caller's own standing. Mode/page live in the URL via
 * `replaceState` — sharing a link to a mode must not push a history entry per
 * tab click, and a reload must land on the tab the player was reading.
 *
 * Labels arrive pre-composed from the server (`@handle · Display Name`); they
 * are inserted with `textContent` and never as markup, because a leaderboard is
 * a page where other people's text reaches the DOM.
 */
import { mountGlassTabs } from './glass-tabs';

export type BoardRow = { displayName: string; score: number; tieBreak: number | null; achievedAt: number };

const PAGE_SIZE = 25;

function formatScore(score: number): string {
	return score.toLocaleString();
}
function formatWhen(at: number): string {
	if (!at) return '';
	const days = Math.floor((Date.now() - at) / 86_400_000);
	if (days <= 0) return 'today';
	if (days === 1) return 'yesterday';
	if (days < 30) return `${days} days ago`;
	return new Date(at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function mountGameLeaderboard(root: HTMLElement): void {
	const gameId = root.dataset.gameId ?? '';
	if (!gameId) return;
	const list = root.querySelector<HTMLElement>('[data-board-rows]');
	const status = root.querySelector<HTMLElement>('[data-board-status]');
	const more = root.querySelector<HTMLButtonElement>('[data-board-more]');
	const you = root.querySelector<HTMLElement>('[data-board-you]');
	const youValue = root.querySelector<HTMLElement>('[data-board-you-value]');
	const tabsList = root.querySelector<HTMLElement>('[data-board-tabs]');
	const indicator = root.querySelector<HTMLElement>('[data-board-indicator]');
	const modes = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-board-mode]')).map((button) => button.dataset.boardMode ?? 'default');
	const url = new URL(window.location.href);
	let mode: string = url.searchParams.get('mode') ?? '';
	if (!modes.includes(mode)) mode = modes[0] ?? 'default';
	let page = Number(url.searchParams.get('page') ?? '0');
	if (!Number.isInteger(page) || page < 0 || page > 19) page = 0;
	let loading = false;

	function say(message: string): void { if (status) status.textContent = message; }

	/** Mode and page belong in the URL: a reload (or a shared link) keeps the view. */
	function writeUrl(): void {
		const next = new URL(window.location.href);
		if (mode && mode !== modes[0]) next.searchParams.set('mode', mode);
		else next.searchParams.delete('mode');
		if (page > 0) next.searchParams.set('page', String(page));
		else next.searchParams.delete('page');
		window.history.replaceState(window.history.state, '', next);
	}

	function paintRow(index: number, row: BoardRow): HTMLLIElement {
		const item = document.createElement('li');
		item.className = 'glass-item glass-row leaderboard-row';
		const rank = document.createElement('span');
		rank.className = 'leaderboard-row__rank mono';
		rank.textContent = `#${page * PAGE_SIZE + index + 1}`;
		const main = document.createElement('span');
		main.className = 'leaderboard-row__main';
		const label = document.createElement('strong');
		// The one rule that matters here: another player's text is inserted as
		// TEXT. `innerHTML` on a leaderboard is a stored-XSS delivery route.
		label.textContent = row.displayName;
		const meta = document.createElement('span');
		meta.className = 'leaderboard-row__meta';
		meta.textContent = row.tieBreak === null ? formatWhen(row.achievedAt) : `tie-break ${row.tieBreak} · ${formatWhen(row.achievedAt)}`;
		main.appendChild(label);
		main.appendChild(meta);
		const score = document.createElement('span');
		score.className = 'leaderboard-row__score mono';
		score.textContent = formatScore(row.score);
		item.appendChild(rank);
		item.appendChild(main);
		item.appendChild(score);
		return item;
	}

	async function load(): Promise<void> {
		if (loading) return;
		loading = true;
		if (more) more.disabled = true;
		say(page === 0 ? 'Loading the board…' : 'Loading more rows…');
		try {
			const response = await fetch(`/api/games/leaderboard?gameId=${encodeURIComponent(gameId)}&mode=${encodeURIComponent(mode)}&page=${page}`, {
				credentials: 'same-origin', cache: 'no-store',
			});
			const body = await response.json().catch(() => ({})) as { rows?: BoardRow[]; hasMore?: boolean; error?: string; pageSize?: number };
			if (!response.ok) {
				say(body.error === 'rate_limited' ? 'Too many board reads right now — try again shortly.' : 'The leaderboard is unavailable right now.');
				return;
			}
			const rows = Array.isArray(body.rows) ? body.rows : [];
			if (list) {
				if (page === 0) list.replaceChildren();
				rows.forEach((row, index) => list.appendChild(paintRow(index, row)));
				if (page === 0 && rows.length === 0) {
					const empty = document.createElement('li');
					empty.className = 'glass-item leaderboard-row--empty';
					empty.textContent = 'No scores on this board yet. Be the first.';
					list.appendChild(empty);
				}
			}
			if (more) more.hidden = !body.hasMore;
			say(rows.length === 0 && page > 0 ? 'That is the end of the board.' : '');
		} catch {
			say('Could not reach the leaderboard. Check your connection and try again.');
		} finally {
			loading = false;
			if (more) more.disabled = false;
		}
	}

	async function loadYou(): Promise<void> {
		if (!you || !youValue) return;
		try {
			const response = await fetch(`/api/games/scores/my?gameId=${encodeURIComponent(gameId)}&mode=${encodeURIComponent(mode)}`, {
				credentials: 'same-origin', cache: 'no-store',
			});
			if (!response.ok) { you.hidden = true; return; }
			const body = await response.json() as { best?: { score: number } | null; rank?: number | null; entries?: number; scope?: string };
			you.hidden = false;
			if (!body.best) {
				youValue.textContent = 'No score yet — your first scored run appears here.';
				return;
			}
			const rank = typeof body.rank === 'number' ? `rank #${body.rank} of ${body.entries ?? '?'}` : `among ${body.entries ?? '?'} runs`;
			youValue.textContent = `Your best: ${formatScore(body.best.score)} · ${rank}${body.scope === 'guest' ? ' (guest session)' : ''}.`;
		} catch {
			you.hidden = true;
		}
	}

	function setMode(next: string): void {
		if (!modes.includes(next) || next === mode) return;
		mode = next;
		page = 0;
		writeUrl();
		if (list) list.replaceChildren();
		for (const button of root.querySelectorAll<HTMLButtonElement>('[data-board-mode]')) {
			button.setAttribute('aria-selected', button.dataset.boardMode === mode ? 'true' : 'false');
		}
		tabs?.place();
		void load();
		void loadYou();
	}

	// Tabs: the shared indicator primitive owns the motion, we own the state.
	const tabButton = (): HTMLElement | null => root.querySelector<HTMLElement>(`[data-board-mode="${mode}"]`);
	const tabs = tabsList && indicator ? mountGlassTabs({ list: tabsList, indicator, current: tabButton }) : null;
	for (const button of root.querySelectorAll<HTMLButtonElement>('[data-board-mode]')) {
		button.addEventListener('click', () => setMode(button.dataset.boardMode ?? modes[0] ?? 'default'));
	}
	more?.addEventListener('click', () => { page += 1; writeUrl(); void load(); });
	// A back/forward navigation or an edited URL re-reads the board.
	window.addEventListener('popstate', () => {
		const params = new URL(window.location.href).searchParams;
		const nextMode = params.get('mode') ?? modes[0] ?? 'default';
		const nextPage = Number(params.get('page') ?? '0');
		if (nextMode === mode && (!Number.isInteger(nextPage) || nextPage === page)) return;
		mode = modes.includes(nextMode) ? nextMode : modes[0] ?? 'default';
		page = Number.isInteger(nextPage) && nextPage >= 0 && nextPage <= 19 ? nextPage : 0;
		void load();
		void loadYou();
	});

	writeUrl();
	void load();
	void loadYou();
	// The page never unmounts this module, so the tabs controller is only held
	// to keep its ResizeObserver alive for the lifetime of the document.
	void tabs;
}
