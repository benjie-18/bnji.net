/**
 * BNJI.NET — admin playlist panel behaviour.
 *
 * One panel, three endpoints:
 *   POST   /api/admin/playlist/resolve   link -> editable draft
 *   POST   /api/admin/playlist           draft -> stored item
 *   PATCH  /api/admin/playlist/order     move up/down, or a whole new order
 *   DELETE /api/admin/playlist?id=       remove
 *
 * THE FLOW IS DELIBERATELY TWO-STEP. Resolving metadata never saves anything:
 * the panel shows the draft in editable inputs, the operator changes what they
 * want, and only then is the item written. That is what makes an unavailable
 * or incomplete provider a recoverable state instead of a failed save — the
 * same form works when the lookup returned everything and when it returned
 * nothing at all.
 *
 * Everything rendered here is textContent. Titles and artist names are
 * provider-returned strings, so they are treated as attacker-influenceable
 * text exactly like a message body, and never as markup.
 */
import { adminFetch } from './admin';

type PlaylistProvider = 'spotify' | 'youtube';

/** Mirrors ResolvedMusicMetadata in src/server/music-metadata.ts. */
type ResolvedDraft = {
	provider: PlaylistProvider;
	id: string;
	url: string;
	source: string;
	status: 'ok' | 'partial' | 'unavailable';
	message: string;
	fields: {
		title?: string;
		artist?: string;
		album?: string;
		publishedAt?: string;
		releaseDate?: string;
	};
	artistIsSuggestion: boolean;
	lookups: { lookup: string; outcome: string; detail?: string }[];
};

/** Mirrors StoredPlaylistItem in src/server/music-store.ts. */
type PlaylistItem = {
	id: string;
	position: number;
	title: string;
	artist?: string;
	album?: string;
	publishedAt?: string;
	releaseDate?: string;
	provider: string;
	url: string;
	sourceId?: string;
};

/** The panel's own state: what the operator is currently editing. */
type Draft = {
	provider: PlaylistProvider;
	url: string;
	title: string;
	artist: string;
	album: string;
	date: string;
	dateField: 'publishedAt' | 'releaseDate';
};

/**
 * What the dashboard hands the panel: one status line, one error line.
 *
 * The panel never writes to the dashboard's elements directly — it is handed
 * the two writers, so there is exactly one place that renders a status and one
 * place that renders an error, whichever panel they came from.
 */
export type AdminPlaylistHost = {
	say: (text: string) => void;
	fail: (message: string) => void;
};

/** The panel's actions, so the dashboard can reload it on a tab switch. */
export type AdminPlaylistActions = {
	load: () => Promise<void>;
	move: (id: string, direction: 'up' | 'down') => Promise<void>;
	remove: (id: string, title: string) => Promise<void>;
};

/** The date line for a stored item, with the verb that matches its provider. */
function itemDateLabel(item: PlaylistItem): string {
	if (item.publishedAt?.trim()) return `Published ${item.publishedAt.trim()}`;
	if (item.releaseDate?.trim()) return `Released ${item.releaseDate.trim()}`;
	return '';
}

function inputValue(root: HTMLElement, selector: string): string {
	const element = root.querySelector<HTMLInputElement>(selector);
	return (element?.value ?? '').trim();
}

function setText(root: HTMLElement, selector: string, text: string): void {
	const element = root.querySelector<HTMLElement>(selector);
	if (element) element.textContent = text;
}

function setHidden(root: HTMLElement, selector: string, hidden: boolean): void {
	const element = root.querySelector<HTMLElement>(selector);
	if (element) element.hidden = hidden;
}

/**
 * Load the stored playlist into the panel's table.
 *
 * The table is rebuilt from scratch on every load rather than patched: the list
 * is small, and a diffing pass that can leave a stale row behind is worse than
 * a rebuild that cannot.
 */
async function loadAdminPlaylist(
	root: HTMLElement,
	host: AdminPlaylistHost,
	actions: AdminPlaylistActions,
): Promise<void> {
	let data: { items: PlaylistItem[]; count: number; initialized: boolean };
	try {
		data = await adminFetch<{ items: PlaylistItem[]; count: number; initialized: boolean }>(
			'/api/admin/playlist',
		);
	} catch {
		return;
	}

	const container = root.querySelector<HTMLElement>('[data-playlist-table]');
	if (!container) return;
	container.textContent = '';

	if (data.items.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'admin__empty';
		empty.textContent = data.initialized
			? 'The playlist is empty. The music player shows no songs until one is added.'
			: 'The playlist has not been seeded yet; the first save seeds it from the configured playlist.';
		container.appendChild(empty);
		host.say('Playlist is empty');
		return;
	}

	const table = document.createElement('table');
	table.className = 'admin__table';

	const headRow = document.createElement('tr');
	for (const label of ['#', 'Title', 'Artist', 'Album', 'Date', 'Provider', 'Link', 'Order']) {
		const th = document.createElement('th');
		th.textContent = label;
		headRow.appendChild(th);
	}
	const thead = document.createElement('thead');
	thead.appendChild(headRow);
	table.appendChild(thead);

	const tbody = document.createElement('tbody');
	data.items.forEach((item, index) => {
		const row = document.createElement('tr');

		const position = document.createElement('td');
		position.className = 'is-mono';
		position.textContent = String(index + 1);
		row.appendChild(position);

		const title = document.createElement('td');
		title.textContent = item.title;
		row.appendChild(title);

		for (const value of [item.artist, item.album, itemDateLabel(item)]) {
			const cell = document.createElement('td');
			cell.textContent = value || '—';
			row.appendChild(cell);
		}

		const provider = document.createElement('td');
		provider.className = 'is-mono';
		provider.textContent = item.provider;
		row.appendChild(provider);

		// The stored link is a canonical https provider URL rebuilt from a
		// validated id, so it is safe as text — and it stays text, never an
		// anchor, so nothing in this table is clickable by accident.
		const link = document.createElement('td');
		link.className = 'is-mono';
		link.textContent = item.url;
		row.appendChild(link);

		const orderCell = document.createElement('td');
		const group = document.createElement('div');
		group.className = 'admin__actions';

		const moveButton = (direction: 'up' | 'down'): HTMLButtonElement => {
			const label = direction === 'up' ? 'Move up' : 'Move down';
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'glass-button glass-button--sm admin__action admin__action--icon';
			button.textContent = direction === 'up' ? '↑' : '↓';
			button.setAttribute('aria-label', `${label} ${item.title}`);
			button.title = label;
			const disabled = direction === 'up' ? index === 0 : index === data.items.length - 1;
			button.disabled = disabled;
			// A disabled control with no explanation reads as a bug, so the
			// title says why: there is nothing beyond that end to swap with.
			if (disabled) {
				button.title = `${label} — already at the ${direction === 'up' ? 'top' : 'end'}`;
			}
			button.addEventListener('click', () => void actions.move(item.id, direction));
			return button;
		};

		group.appendChild(moveButton('up'));
		group.appendChild(moveButton('down'));

		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'glass-button glass-button--sm admin__action';
		remove.textContent = 'Remove';
		remove.setAttribute('aria-label', `Remove ${item.title} from the playlist`);
		remove.addEventListener('click', () => void actions.remove(item.id, item.title));
		group.appendChild(remove);

		orderCell.appendChild(group);
		row.appendChild(orderCell);
		tbody.appendChild(row);
	});
	table.appendChild(tbody);
	container.appendChild(table);
	host.say(`${data.items.length} in the playlist`);
}

/** Wire the panel's forms. Called once from startAdminDashboard(). */
export function startAdminPlaylist(root: HTMLElement, host: AdminPlaylistHost): AdminPlaylistActions {
	let current: Draft | null = null;

	const showDraft = (next: Draft | null): void => {
		current = next;
		setHidden(root, '[data-playlist-draft]', next === null);
		if (!next) return;

		const setField = (selector: string, value: string): void => {
			const element = root.querySelector<HTMLInputElement>(selector);
			if (element) element.value = value;
		};
		setField('[data-playlist-draft-provider]', next.provider);
		setField('[data-playlist-draft-url]', next.url);
		setField('[data-playlist-draft-title]', next.title);
		setField('[data-playlist-draft-artist]', next.artist);
		setField('[data-playlist-draft-album]', next.album);
		setField('[data-playlist-draft-date]', next.date);

		// The date column depends on the provider, and the label says which one
		// it is: a YouTube upload date is not a Spotify release date, and
		// storing one in the other's field would print the wrong verb.
		const isSpotify = next.provider === 'spotify';
		setText(
			root,
			'[data-playlist-date-label]',
			isSpotify ? 'Release date (optional)' : 'Publication date (optional)',
		);
		setText(
			root,
			'[data-playlist-date-hint]',
			isSpotify
				? 'The day the album was released, as reported by Spotify. Shown as “Released …”.'
				: 'The day the video was uploaded, as reported by YouTube. Shown as “Published …”.',
		);
		playlistError(null);
	};

	const playlistError = (message: string | null): void => {
		const element = root.querySelector<HTMLElement>('[data-playlist-error]');
		if (!element) return;
		if (!message) {
			element.hidden = true;
			element.textContent = '';
			return;
		}
		element.textContent = message;
		element.hidden = false;
	};

	/* --- resolve: link -> editable draft ------------------------------------ */

	root.querySelector<HTMLFormElement>('[data-playlist-import]')?.addEventListener('submit', (event) => {
		event.preventDefault();
		void resolve();
	});

	const resolve = async (): Promise<void> => {
		const url = inputValue(root, '[data-playlist-url]');
		const button = root.querySelector<HTMLButtonElement>('[data-playlist-resolve]');
		const note = root.querySelector<HTMLElement>('[data-playlist-lookup]');
		button?.setAttribute('disabled', '');
		playlistError(null);
		if (note) {
			note.hidden = false;
			note.textContent = 'Resolving metadata…';
		}

		try {
			const data = await adminFetch<{ draft: ResolvedDraft | null }>('/api/admin/playlist/resolve', {
				method: 'POST',
				body: JSON.stringify({ url }),
			});
			const resolved = data.draft;
			if (!resolved) {
				// Only reachable if the endpoint could not say anything at all
				// about the link. The manual form still opens, because a link
				// plus a title is a complete item.
				if (note) {
					note.hidden = false;
					note.textContent =
						'Metadata could not be resolved. Enter the title and any details below, then save.';
				}
				return;
			}

			const date = resolved.fields.publishedAt?.trim() || resolved.fields.releaseDate?.trim() || '';
			// A channel name is who uploaded the video, which is not always who
			// made the music. The panel says so rather than presenting it as
			// credited metadata.
			const suggestion = resolved.artistIsSuggestion
				? ' The artist is the channel name — a suggestion, not credited metadata — so check it.'
				: '';
			if (note) {
				note.hidden = false;
				note.textContent = `${resolved.message}${suggestion}`;
			}
			showDraft({
				provider: resolved.provider,
				url: resolved.url,
				title: resolved.fields.title?.trim() ?? '',
				artist: resolved.fields.artist?.trim() ?? '',
				album: resolved.fields.album?.trim() ?? '',
				date,
				dateField: resolved.provider === 'spotify' ? 'releaseDate' : 'publishedAt',
			});
			root.querySelector<HTMLInputElement>('[data-playlist-draft-title]')?.focus();
		} catch (error) {
			const status = (error as { status?: number }).status;
			// A rejected link is this panel's own validation failing, not a
			// provider problem: say the URL was the problem.
			if (status === 400) {
				playlistError('That link is not a supported Spotify track or YouTube video URL.');
				if (note) note.hidden = true;
			} else {
				host.fail(`Metadata resolution failed (${status ?? 'network'}).`);
			}
		} finally {
			button?.removeAttribute('disabled');
		}
	};

	/* --- save: draft -> stored item ----------------------------------------- */

	root.querySelector<HTMLFormElement>('[data-playlist-draft]')?.addEventListener('submit', (event) => {
		event.preventDefault();
		void save();
	});

	// One reload path for every mutation. It reads `actions`, which is created
	// at the end of this function, so it must not be called before then — and
	// nothing does: the first call comes from a click.
	const load = (): Promise<void> => loadAdminPlaylist(root, host, actions);

	const save = async (): Promise<void> => {
		if (!current) return;

		const title = inputValue(root, '[data-playlist-draft-title]');
		if (!title) {
			playlistError('A title is required to save this track.');
			return;
		}

		const date = inputValue(root, '[data-playlist-draft-date]');
		const button = root.querySelector<HTMLButtonElement>('[data-playlist-save]');
		button?.setAttribute('disabled', '');
		playlistError(null);
		try {
			await adminFetch<{ ok: boolean }>('/api/admin/playlist', {
				method: 'POST',
				body: JSON.stringify({
					url: current.url,
					title,
					artist: inputValue(root, '[data-playlist-draft-artist]'),
					album: inputValue(root, '[data-playlist-draft-album]'),
					// The provider decides which column the date belongs in.
					...(current.dateField === 'releaseDate' ? { releaseDate: date } : { publishedAt: date }),
				}),
			});
			showDraft(null);
			setHidden(root, '[data-playlist-lookup]', true);
			root.querySelector<HTMLFormElement>('[data-playlist-import]')?.reset();
			host.say(`Saved “${title}”`);
			await load();
		} catch (error) {
			const status = (error as { status?: number }).status;
			playlistError(
				status === 422
					? 'The playlist is full. Remove an item before adding another.'
					: status === 400
						? 'That link or title was rejected. Check the URL and try again.'
						: `The track could not be saved (${status ?? 'network'}).`,
			);
		} finally {
			button?.removeAttribute('disabled');
		}
	};

	root.querySelector('[data-playlist-discard]')?.addEventListener('click', () => {
		showDraft(null);
		setHidden(root, '[data-playlist-lookup]', true);
	});

	/* --- move and remove ---------------------------------------------------- */

	const moveItem = async (id: string, direction: 'up' | 'down'): Promise<void> => {
		try {
			await adminFetch<{ ok: boolean }>('/api/admin/playlist/order', {
				method: 'PATCH',
				body: JSON.stringify({ id, direction }),
			});
			await load();
		} catch (error) {
			const status = (error as { status?: number }).status;
			host.fail(
				status === 409
					? 'The playlist changed while you were looking at it; it has been reloaded.'
					: `That move was rejected (${status ?? 'network'}).`,
			);
		}
	};

	const removeItem = async (id: string, title: string): Promise<void> => {
		try {
			await adminFetch<{ ok: boolean }>(`/api/admin/playlist?id=${encodeURIComponent(id)}`, {
				method: 'DELETE',
			});
			host.say(`Removed “${title}”`);
			await load();
		} catch (error) {
			const status = (error as { status?: number }).status;
			host.fail(`That item could not be removed (${status ?? 'network'}).`);
		}
	};

	const actions: AdminPlaylistActions = {
		load: () => loadAdminPlaylist(root, host, actions),
		move: moveItem,
		remove: removeItem,
	};
	return actions;
}
