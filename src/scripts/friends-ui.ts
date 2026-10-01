/**
 * BNJI.NET — chat plan Phase E: /friends/ client (plan §8.1, §8.2, §8.3).
 *
 * One mount per page: loads the account's own lists from GET /api/friends,
 * renders request/accept/decline/block/remove/unblock actions straight from
 * the returned lists (the API never exposes anyone else's data), and opens
 * the Presence socket for online dots — visible only to accepted friends,
 * because the server mints that visibility, not this script. The client's
 * only protocol messages are `ping` (keep-alive detection, no server
 * heartbeat) and `pong`.
 */
type Entry = { handle: string; displayName: string; since: number };
type Lists = {
	friends: Entry[];
	incoming: Entry[];
	outgoing: Entry[];
	blocked: Entry[];
	config?: { maxFriends: number; maxPendingOutgoing: number };
};

const FRIEND_ERROR_COPY: Record<string, string> = {
	authentication_required: 'Sign in from the Games page first.',
	friends_disabled: 'Friends are turned off right now.',
	invalid_payload: 'That request was not valid.',
	invalid_handle: 'Handles are lowercase letters, numbers and underscores (3–20).',
	self_friend: 'That is your own handle.',
	already_friends: 'You are already friends.',
	already_pending: 'That request is already waiting.',
	not_found: 'No account uses that handle — or that request is gone.',
	blocked: 'You cannot be friends with that account.',
	friends_limit: 'Friend limit reached.',
	pending_limit: 'Too many outgoing requests — wait for replies first.',
	rate_limited: 'Slow down a little and try again.',
	storage_unavailable: 'The server is unavailable right now.',
	origin_not_allowed: 'That request was not valid.',
};

function copyFor(error: unknown): string {
	if (typeof error === 'string' && FRIEND_ERROR_COPY[error]) return FRIEND_ERROR_COPY[error];
	return 'Something went wrong — try again.';
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

/**
 * The route's vocabulary: POST mutates friendships, DELETE removes them
 * (unfriend / cancel own pending / unblock). Sending a DELETE action over
 * POST is a 400 — the method is part of the contract (plan §10).
 */
const METHOD_BY_ACTION: Record<string, 'POST' | 'DELETE'> = {
	request: 'POST', accept: 'POST', decline: 'POST', block: 'POST',
	remove: 'DELETE', unblock: 'DELETE',
};

const CHANGED_COPY: Record<string, (handle: string) => string> = {
	requested: (handle) => `Request sent to ${handle}.`,
	friends: (handle) => `You and ${handle} are friends now.`,
	declined: (handle) => `Request from ${handle} declined.`,
	blocked: (handle) => `${handle} is blocked.`,
	removed: (handle) => `${handle} removed from your friends.`,
	cancelled: (handle) => `Request to ${handle} cancelled.`,
	unblocked: (handle) => `${handle} unblocked.`,
};

async function apiCall(method: 'GET' | 'POST' | 'DELETE', body?: { action: string; handle: string }): Promise<{ ok: true; data: Lists } | { ok: false; error: unknown; status: number }> {
	const response = await fetch('/api/friends', {
		method,
		credentials: 'same-origin',
		headers: body ? { 'content-type': 'application/json', accept: 'application/json' } : { accept: 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});
	let data: unknown = null;
	try { data = await response.json(); } catch { /* fall through */ }
	const payload = data as Record<string, unknown> | null;
	if (response.ok && payload && typeof payload === 'object') return { ok: true, data: payload as unknown as Lists };
	return { ok: false, error: payload && typeof payload.error !== 'undefined' ? payload.error : `status_${response.status}`, status: response.status };
}

export function mountFriends(root: HTMLElement): void {
	if (root.dataset.friendsBound === '1') return;
	root.dataset.friendsBound = '1';

	const status = root.querySelector<HTMLElement>('[data-friends-status]');
	const signin = root.querySelector<HTMLElement>('[data-friends-signin]');
	const signedIn = root.querySelector<HTMLElement>('[data-friends-signed-in]');
	const form = root.querySelector<HTMLFormElement>('[data-friends-request-form]');
	const handleInput = root.querySelector<HTMLInputElement>('[data-friends-request-handle]');
	const lists = {
		incoming: root.querySelector<HTMLElement>('[data-friends-list="incoming"]'),
		friends: root.querySelector<HTMLElement>('[data-friends-list="friends"]'),
		outgoing: root.querySelector<HTMLElement>('[data-friends-list="outgoing"]'),
		blocked: root.querySelector<HTMLElement>('[data-friends-list="blocked"]'),
	};
	const empty = {
		incoming: root.querySelector<HTMLElement>('[data-friends-empty="incoming"]'),
		friends: root.querySelector<HTMLElement>('[data-friends-empty="friends"]'),
		outgoing: root.querySelector<HTMLElement>('[data-friends-empty="outgoing"]'),
		blocked: root.querySelector<HTMLElement>('[data-friends-empty="blocked"]'),
	};

	const setStatus = (message: string, tone: 'error' | null = null): void => {
		if (!status) return;
		status.textContent = message;
		if (tone) status.dataset.tone = tone;
		else delete status.dataset.tone;
	};
	const setOnline = (handle: string, online: boolean): void => {
		for (const dot of root.querySelectorAll<HTMLElement>(`[data-friend-online="${CSS.escape(handle)}"]`)) {
			dot.hidden = !online;
			dot.setAttribute('aria-label', online ? `${handle} is online` : `${handle} is offline`);
		}
	};
	const applySnapshot = (handles: string[]): void => {
		const online = new Set(handles);
		for (const dot of root.querySelectorAll<HTMLElement>('[data-friend-online]')) {
			const handle = dot.dataset.friendOnline ?? '';
			setOnline(handle, online.has(handle));
		}
	};

	const rowHtml = (entry: Entry, kind: 'incoming' | 'friends' | 'outgoing' | 'blocked'): string => {
		const handle = escapeHtml(entry.handle);
		const label = escapeHtml(entry.displayName);
		const online = kind === 'friends'
			? `<span class="friends-online" data-friend-online="${handle}" hidden aria-label="${handle} is offline" role="img">●</span>`
			: '';
		// Same visual language as GlassButton (glass.css): class + data-glass.
		// Every control carries a handle-scoped aria-label — "Accept" alone is
		// ambiguous when a page lists several rows (a11y).
		const btn = (action: string, label: string, aria: string, extra = ''): string =>
			`<button type="button" class="glass-button glass-button--quiet glass-button--sm${extra ? ` ${extra}` : ''}" data-glass="" data-friend-action="${action}" aria-label="${escapeHtml(aria)}">${label}</button>`;
		let actions = '';
		if (kind === 'incoming') {
			actions = [
				`<button type="button" class="glass-button glass-button--primary glass-button--sm" data-glass="" data-friend-action="accept" aria-label="${escapeHtml(`Accept friend request from ${handle}`)}">Accept</button>`,
				btn('decline', 'Decline', `Decline friend request from ${handle}`, 'friends-btn--muted'),
				btn('block', 'Block', `Block ${handle}`, 'friends-btn--danger'),
			].join('');
		} else if (kind === 'friends') {
			actions = [
				`<a class="glass-button glass-button--quiet glass-button--sm" data-glass="" href="/messages/?handle=${encodeURIComponent(entry.handle)}" data-friend-message aria-label="Message ${escapeHtml(handle)}">Message</a>`,
				btn('remove', 'Remove', `Remove ${handle} from your friends`, 'friends-btn--muted'),
				btn('block', 'Block', `Block ${handle}`, 'friends-btn--danger'),
			].join('');
		} else if (kind === 'outgoing') {
			actions = btn('remove', 'Cancel', `Cancel friend request to ${handle}`, 'friends-btn--muted');
		} else if (kind === 'blocked') {
			actions = btn('unblock', 'Unblock', `Unblock ${handle}`, 'friends-btn--muted');
		}
		return `<li class="friends-row" data-handle="${handle}">
			<span class="friends-row__who">${online}<strong>${handle}</strong> <span class="friends-row__name">${label}</span></span>
			<span class="friends-row__actions">${actions}</span>
		</li>`;
	};

	const render = (data: Lists): void => {
		for (const kind of ['incoming', 'friends', 'outgoing', 'blocked'] as const) {
			const items = data[kind] ?? [];
			if (lists[kind]) lists[kind]!.innerHTML = items.map((entry) => rowHtml(entry, kind)).join('');
			if (empty[kind]) empty[kind]!.hidden = items.length > 0;
		}
	};

	const run = async (action: string, handle: string): Promise<void> => {
		const method = METHOD_BY_ACTION[action];
		if (!method) return;
		const outcome = await apiCall(method, { action, handle });
		if (outcome.ok) {
			render(outcome.data);
			const changed = (outcome.data as { changed?: string }).changed;
			const describe = changed ? CHANGED_COPY[changed] : undefined;
			setStatus(describe ? describe(handle) : `Done — ${handle}.`);
			return;
		}
		setStatus(copyFor(outcome.error), 'error');
	};

	let socket: WebSocket | null = null;
	let pingTimer: number | undefined;
	let reconnectTimer: number | undefined;
	let reconnectDelay = 1_000;
	let pongSeen = true;
	// Generation token: a restarted socket's stale `close` must not tear down
	// (or schedule a rival reconnect for) the socket that replaced it.
	let presenceGeneration = 0;

	const stopPresence = (): void => {
		presenceGeneration += 1;
		window.clearInterval(pingTimer);
		window.clearTimeout(reconnectTimer);
		pingTimer = undefined;
		reconnectTimer = undefined;
		if (socket) {
			const stale = socket;
			socket = null;
			try { stale.close(); } catch { /* no-op */ }
		}
	};

	const startPresence = (): void => {
		stopPresence();
		const generation = presenceGeneration;
		const stale = (): boolean => generation !== presenceGeneration;
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		let ws: WebSocket;
		try {
			ws = new WebSocket(`${protocol}//${window.location.host}/api/presence`);
		} catch {
			return;
		}
		socket = ws;
		ws.addEventListener('message', (event) => {
			if (stale()) return;
			let frame: unknown;
			try { frame = JSON.parse(String(event.data)); } catch { return; }
			const message = frame as { t?: string; handles?: unknown };
			if (message?.t === 'presence_snapshot' && Array.isArray(message.handles)) {
				applySnapshot(message.handles.filter((item): item is string => typeof item === 'string'));
				reconnectDelay = 1_000;
			} else if (message?.t === 'presence_change') {
				const change = frame as { handle?: unknown; online?: unknown };
				if (typeof change.handle === 'string' && typeof change.online === 'boolean') setOnline(change.handle, change.online);
			} else if (message?.t === 'pong') {
				pongSeen = true;
			}
		});
		ws.addEventListener('close', () => {
			if (stale()) return;
			stopPresence();
			// Client-side detection only — the DO keeps no heartbeat (§8.2);
			// reconnect with backoff and take a fresh snapshot on open.
			reconnectTimer = window.setTimeout(() => { if (stale()) return; reconnectDelay = Math.min(30_000, reconnectDelay * 2); startPresence(); }, reconnectDelay);
		});
		ws.addEventListener('error', () => { if (!stale()) { try { ws.close(); } catch { /* no-op */ } } });
		// Keep-alive: ping and require a pong; silent socket → force reconnect.
		pongSeen = true;
		pingTimer = window.setInterval(() => {
			if (stale() || !socket || socket !== ws || ws.readyState !== WebSocket.OPEN) return;
			if (!pongSeen) { try { ws.close(); } catch { /* no-op */ } return; }
			pongSeen = false;
			try { ws.send(JSON.stringify({ t: 'ping' })); } catch { /* no-op */ }
		}, 30_000);
	};

	// One mutation at a time: double-clicks must not burn the rate budget.
	let busy = false;
	const withBusy = (work: () => Promise<void>): void => {
		if (busy) return;
		busy = true;
		root.setAttribute('aria-busy', 'true');
		void work().finally(() => {
			busy = false;
			root.removeAttribute('aria-busy');
		});
	};

	form?.addEventListener('submit', (event) => {
		event.preventDefault();
		const handle = (handleInput?.value ?? '').trim().toLowerCase();
		if (!handle) return;
		setStatus('Sending…');
		withBusy(async () => {
			await run('request', handle);
			if (handleInput) handleInput.value = '';
		});
	});

	root.addEventListener('click', (event) => {
		const target = event.target as Element | null;
		const actionButton = target?.closest<HTMLElement>('[data-friend-action]');
		if (!actionButton) return;
		const row = actionButton.closest<HTMLElement>('[data-handle]');
		const action = actionButton.dataset.friendAction;
		if (!row || !action || !row.dataset.handle) return;
		const handle = row.dataset.handle;
		setStatus('Working…');
		withBusy(async () => {
			await run(action, handle);
			// The Presence header carries my accepted-friend handles: any action
			// that can change that set (accept, remove, block) gets a fresh
			// socket so both the snapshot and my visibility to others stay honest.
			if (action === 'accept' || action === 'remove' || action === 'block') startPresence();
		});
	});

	// Load the lists, then bring up presence for friends.
	void (async () => {
		const outcome = await apiCall('GET');
		if (outcome.ok) {
			render(outcome.data);
			if (status) status.textContent = '';
			if (signin) signin.hidden = true;
			if (signedIn) signedIn.hidden = false;
			startPresence();
			return;
		}
		if (status) status.textContent = '';
		if (outcome.status === 401) {
			if (signin) signin.hidden = false;
			if (signedIn) signedIn.hidden = true;
		} else {
			if (signin) signin.hidden = true;
			if (signedIn) signedIn.hidden = false;
			setStatus(copyFor(outcome.error), 'error');
		}
	})();
}
