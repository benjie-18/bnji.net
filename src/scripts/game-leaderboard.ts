/**
 * Leaderboard client: fetch one game's board and the caller's standing, then
 * render. Nothing here is authoritative — the API only ever returns rows a
 * server verifier accepted, and this module draws them as text.
 *
 * Design constraints that shape the code:
 *   - the page itself is prerendered, so every state (loading, empty, error,
 *     rows) is written into the same table body rather than swapped by CSS;
 *   - player labels are untrusted text and land via `textContent` only;
 *   - mode and page live in the query string so a board can be linked
 *     ("the hard minesweeper top 25"), and `replaceState` keeps the back
 *     button for the page rather than for every board flip;
 *   - a failed read never blanks the table: the last rows stay and the status
 *     line says what happened.
 */
import { mountGlassTabs } from './glass-tabs';

type BoardRow = { displayName: string; score: number; tieBreak: number | null; achievedAt: number };
type BoardResponse = { rows?: BoardRow[]; hasMore?: boolean };
type Standing = { best: { score: number } | null; rank: number | null; entries: number };

const PAGE_SIZE = 25;
const numberFormat = new Intl.NumberFormat();
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

async function getJson(url: string): Promise<Record<string, unknown> | null> {
	try {
		const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
		const body = await response.json().catch(() => null);
		return response.ok && body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function noteRow(message: string): HTMLTableRowElement {
	const cell = document.createElement('td');
	cell.colSpan = 4;
	cell.textContent = message;
	const row = document.createElement('tr');
	row.className = 'lb__row-note';
	row.appendChild(cell);
	return row;
}

export function mountLeaderboard(root: HTMLElement): void {
	const gameId = root.dataset.gameId ?? '';
	const modes = (root.dataset.lbModes ?? 'default').split(',').filter(Boolean);
	const rowsBody = root.querySelector<HTMLTableSectionElement>('[data-lb-rows]');
	const standingEl = root.querySelector<HTMLElement>('[data-lb-standing]');
	const pagerNote = root.querySelector<HTMLElement>('[data-lb-pager-note]');
	const prevButton = root.querySelector<HTMLButtonElement>('[data-lb-prev]');
	const nextButton = root.querySelector<HTMLButtonElement>('[data-lb-next]');
	// The board picker is the shared travelling-slab control, and its items are
	// links: without JavaScript a click is a real navigation to ?mode=, and with
	// it the same href is prevented and the rows are refetched in place.
	// A board with one mode has no picker at all, so everything below is optional
	// and reads its items from the list rather than from the whole board.
	const modeList = root.querySelector<HTMLElement>('[data-lb-mode-list]');
	const modeTabs = modeList ? Array.from(modeList.querySelectorAll<HTMLElement>('[data-lb-mode]')) : [];
	if (!gameId || !rowsBody) return;

	const search = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
	let mode = modes.includes(search.get('mode') ?? '') ? String(search.get('mode')) : modes[0] ?? 'default';
	let page = Math.max(0, Math.min(19, Number(search.get('page') ?? '0') || 0));
	/** Which selection the in-flight requests belong to: a stale answer is dropped. */
	let selection = 0;

	function paintMode(): void {
		for (const tab of modeTabs) {
			if (tab.dataset.lbMode === mode) tab.setAttribute('aria-current', 'true');
			else tab.removeAttribute('aria-current');
		}
	}
	paintMode();
	const modeIndicator = root.querySelector<HTMLElement>('[data-lb-mode-indicator]');
	const modeSlab = modeList && modeIndicator && modeTabs.length > 1
		? mountGlassTabs({
			list: modeList,
			indicator: modeIndicator,
			current: () => modeTabs.find((tab) => tab.hasAttribute('aria-current')) ?? null,
		})
		: null;

	function syncUrl(): void {
		try {
			const params = new URLSearchParams(location.search);
			params.set('mode', mode);
			if (page > 0) params.set('page', String(page));
			else params.delete('page');
			history.replaceState(null, '', `${location.pathname}?${params.toString()}`);
		} catch { /* a blocked history write must not break the board */ }
	}

	function setStanding(lead: string, emphasis: string | null): void {
		if (!standingEl) return;
		standingEl.replaceChildren();
		if (!emphasis) { standingEl.textContent = lead; return; }
		const strong = document.createElement('strong');
		strong.textContent = emphasis;
		standingEl.appendChild(document.createTextNode(lead));
		standingEl.appendChild(strong);
	}

	function renderStanding(data: Record<string, unknown> | null): void {
		if (!data) { setStanding('Your standing could not be loaded — the board above is still current.', null); return; }
		const standing = data as unknown as Standing;
		const count = numberFormat.format(standing.entries ?? 0);
		if (!standing.best) {
			setStanding(`No verified run of yours on this board yet (${count} rows). A run that beats your best is submitted for you.`, null);
			return;
		}
		setStanding(
			`Your best here is ${numberFormat.format(standing.best.score)} · rank ${numberFormat.format(standing.rank ?? 0)} of ${count}. `,
			standing.rank === 1 ? 'You hold the top of this board.' : '',
		);
	}

	function renderRows(rows: BoardRow[] | null): void {
		const body = rowsBody;
		if (!body) return;
		if (!rows) { body.replaceChildren(noteRow('The board could not be loaded right now. Try again in a moment.')); return; }
		if (rows.length === 0) { body.replaceChildren(noteRow('No verified runs on this board yet. The first run a server accepts takes it.')); return; }
		const fragment = document.createDocumentFragment();
		rows.forEach((row, index) => {
			const tr = document.createElement('tr');
			const rank = document.createElement('th');
			rank.scope = 'row';
			rank.textContent = String(page * PAGE_SIZE + index + 1);
			const player = document.createElement('td');
			player.textContent = typeof row.displayName === 'string' && row.displayName ? row.displayName : 'Anonymous';
			const score = document.createElement('td');
			score.className = 'lb__cell-score';
			score.textContent = numberFormat.format(Number(row.score) || 0);
			const when = document.createElement('td');
			when.className = 'lb__cell-when';
			const at = Number(row.achievedAt);
			if (Number.isFinite(at) && at > 0) {
				const time = document.createElement('time');
				time.dateTime = new Date(at).toISOString();
				time.textContent = dateFormat.format(new Date(at));
				when.appendChild(time);
			} else when.textContent = '—';
			for (const cell of [rank, player, score, when]) tr.appendChild(cell);
			fragment.appendChild(tr);
		});
		body.replaceChildren(fragment);
	}

	async function load(): Promise<void> {
		const current = ++selection;
		const query = new URLSearchParams({ gameId, mode, page: String(page) });
		if (pagerNote) pagerNote.textContent = `Page ${page + 1} · loading…`;
		const [board, standing] = await Promise.all([
			getJson(`/api/games/leaderboard?${query.toString()}`),
			getJson(`/api/games/scores/my?${new URLSearchParams({ gameId, mode }).toString()}`),
		]);
		if (current !== selection) return; // a newer selection won
		const rows = board && Array.isArray(board.rows) ? (board.rows as BoardRow[]) : null;
		renderRows(rows);
		renderStanding(standing);
		const hasMore = Boolean(board?.hasMore);
		if (pagerNote) pagerNote.textContent = `Page ${page + 1}${hasMore ? '' : ' · end of board'}`;
		if (prevButton) prevButton.disabled = page === 0;
		if (nextButton) nextButton.disabled = !hasMore;
		syncUrl();
	}

	prevButton?.addEventListener('click', () => {
		if (page === 0) return;
		page -= 1;
		void load();
	});
	nextButton?.addEventListener('click', () => {
		page += 1;
		void load();
	});
	modeList?.addEventListener('click', (event) => {
		const tab = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-lb-mode]');
		if (!tab) return;
		event.preventDefault();
		const next = tab.dataset.lbMode ?? '';
		if (!modes.includes(next) || next === mode) return;
		mode = next;
		page = 0;
		paintMode();
		modeSlab?.place();
		void load();
	});
	void load();
}

/** Bind every board on the page (one per leaderboard route). */
export function mountLeaderboards(scope: ParentNode = document): void {
	for (const root of Array.from(scope.querySelectorAll<HTMLElement>('[data-leaderboard]'))) {
		try {
			mountLeaderboard(root);
		} catch { /* a board that cannot render must not take the page with it */ }
	}
}
