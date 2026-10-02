/**
 * BNJI.NET — the people panel on /friends/: search accounts by handle fragment.
 *
 * Mounted by `mountFriends` (friends-ui.ts) next to the exact-handle request
 * form, because the two are one workflow: find someone here, act on them there.
 * That is also why this module holds no mutation logic — it renders rows and
 * hands the chosen handle back to the friends client, so every request/accept/
 * block path keeps its single implementation.
 *
 * Privacy shape (see src/server/people-index.ts for the server half):
 *  - the query is a handle fragment, and the panel refuses to send one shorter
 *    than DIRECTORY_CONFIG.minQueryLength rather than letting the server bounce
 *    it, so keystrokes below the floor never leave the page;
 *  - requests are debounced, which is what keeps "search as you type" from
 *    turning into a keystroke-grained record of who is on the site;
 *  - an abbreviation-bearing response is discarded if a newer keystroke has
 *    already won (the abort + `lastQuery` check), because a stale row that
 *    appears after the next query reads as a result of that query.
 */
import { DIRECTORY_CONFIG } from '../config/directory.config';

export type PeopleRow = {
	handle: string;
	displayName: string;
	/** The caller's own edge to this account — never anyone else's. */
	friendState: 'none' | 'pending_out' | 'pending_in' | 'friends';
};

export type PeoplePanelOptions = {
	/** Send a friend request to this handle (the friends client owns the call). */
	onRequest?: (handle: string) => void;
	/** Open the existing conversation, or start one, with this handle. */
	onMessage?: (handle: string) => void;
};

type PeopleResponse = {
	people?: PeopleRow[];
	truncated?: boolean;
	error?: string;
};

const ERROR_COPY: Record<string, string> = {
	directory_disabled: 'People search is turned off right now.',
	friends_disabled: 'Friends are turned off right now.',
	account_required: 'Sign in from the Games page to search for people.',
	query_too_short: `Type at least ${DIRECTORY_CONFIG.minQueryLength} characters.`,
	invalid_query: 'Handles are lowercase letters, numbers and underscores.',
	rate_limited: 'You have searched a lot — wait a moment and try again.',
	storage_unavailable: 'The server is unavailable right now.',
	origin_not_allowed: 'That search was not valid.',
};

const STATE_ACTION: Record<PeopleRow['friendState'], 'request' | 'wait' | 'respond' | 'message'> = {
	none: 'request',
	pending_out: 'wait',
	pending_in: 'respond',
	friends: 'message',
};

export function mountPeoplePanel(root: HTMLElement, options: PeoplePanelOptions = {}): (() => void) | null {
	const form = root.querySelector<HTMLFormElement>('[data-people-form]');
	const input = root.querySelector<HTMLInputElement>('[data-people-query]');
	const list = root.querySelector<HTMLUListElement>('[data-people-list]');
	const status = root.querySelector<HTMLElement>('[data-people-status]');
	const empty = root.querySelector<HTMLElement>('[data-people-empty]');
	if (!form || !input || !list || !status) return null;

	let controller: AbortController | null = null;
	let debounce = 0;
	let lastQuery = '';

	const say = (message: string, tone: 'error' | null = null): void => {
		status.textContent = message;
		if (tone) status.dataset.tone = tone;
		else delete status.dataset.tone;
	};
	const clearList = (): void => {
		list.replaceChildren();
		if (empty) empty.hidden = true;
	};

	const renderRow = (row: PeopleRow): HTMLLIElement => {
		const item = document.createElement('li');
		item.className = 'glass-item friends-row';
		item.dataset.handle = row.handle;

		const who = document.createElement('span');
		who.className = 'friends-row__who';
		const handle = document.createElement('strong');
		handle.textContent = `@${row.handle}`;
		const name = document.createElement('span');
		name.className = 'friends-row__name';
		name.textContent = row.displayName;
		who.appendChild(handle);
		who.appendChild(name);
		item.appendChild(who);

		const actions = document.createElement('span');
		actions.className = 'friends-row__actions';
		const action = STATE_ACTION[row.friendState];
		if (action === 'request' && options.onRequest) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'glass-button glass-button--quiet glass-button--sm';
			button.dataset.peopleAction = 'request';
			button.setAttribute('aria-label', `Send a friend request to ${row.handle}`);
			button.textContent = 'Send request';
			actions.appendChild(button);
		} else if (action === 'message' && options.onMessage) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'glass-button glass-button--quiet glass-button--sm';
			button.dataset.peopleAction = 'message';
			button.setAttribute('aria-label', `Message ${row.handle}`);
			button.textContent = 'Message';
			actions.appendChild(button);
		} else {
			// No dead control: a state the caller cannot act on is a label, not a
			// disabled button that looks broken.
			const note = document.createElement('span');
			note.className = 'friends-row__name';
			note.textContent = action === 'wait' ? 'Request sent' : 'Reply on the left';
			actions.appendChild(note);
		}
		item.appendChild(actions);
		return item;
	};

	const render = (rows: PeopleRow[], query: string): void => {
		list.replaceChildren();
		if (rows.length === 0) {
			if (empty) {
				empty.textContent = `No accounts match “${query}”.`;
				empty.hidden = false;
			}
			return;
		}
		if (empty) empty.hidden = true;
		const fragment = document.createDocumentFragment();
		for (const row of rows) fragment.appendChild(renderRow(row));
		list.appendChild(fragment);
	};

	const search = async (raw: string): Promise<void> => {
		const query = raw.trim().toLowerCase();
		lastQuery = query;
		if (!query) {
			controller?.abort();
			clearList();
			say('');
			return;
		}
		if (query.length < DIRECTORY_CONFIG.minQueryLength) {
			clearList();
			say(`Type at least ${DIRECTORY_CONFIG.minQueryLength} characters.`);
			return;
		}
		if (query.length > DIRECTORY_CONFIG.maxQueryLength) {
			clearList();
			say(`Handles are at most ${DIRECTORY_CONFIG.maxQueryLength} characters.`, 'error');
			return;
		}

		controller?.abort();
		controller = new AbortController();
		say('Searching…');
		try {
			const response = await fetch(`/api/people?query=${encodeURIComponent(query)}`, {
				headers: { accept: 'application/json' },
				credentials: 'same-origin',
				cache: 'no-store',
				signal: controller.signal,
			});
			const body = await response.json().catch(() => null) as PeopleResponse | null;
			if (query !== lastQuery) return; // A newer keystroke already won.
			if (!response.ok) {
				clearList();
				say((body?.error && ERROR_COPY[body.error]) ?? 'Search failed — try again.', 'error');
				return;
			}
			const rows = body?.people ?? [];
			render(rows, query);
			say(rows.length === 0 ? '' : body?.truncated ? `Showing the first ${rows.length} matches.` : '');
		} catch (error) {
			if ((error as { name?: string })?.name === 'AbortError') return;
			say('Search failed — check your connection and try again.', 'error');
		}
	};

	form.addEventListener('submit', (event) => {
		event.preventDefault();
		window.clearTimeout(debounce);
		void search(input.value);
	});
	input.addEventListener('input', () => {
		window.clearTimeout(debounce);
		debounce = window.setTimeout(() => void search(input.value), DIRECTORY_CONFIG.searchDebounceMs);
	});

	list.addEventListener('click', (event) => {
		const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-people-action]');
		const row = button?.closest<HTMLElement>('[data-handle]');
		const handle = row?.dataset.handle;
		if (!button || !handle) return;
		if (button.dataset.peopleAction === 'request') options.onRequest?.(handle);
		else if (button.dataset.peopleAction === 'message') options.onMessage?.(handle);
	});

	return () => {
		window.clearTimeout(debounce);
		controller?.abort();
	};
}
