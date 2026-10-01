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

	const setStatus = (message: string): void => {
		if (status) status.textContent = message;
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
		let actions = '';
		if (kind === 'incoming') {
			actions = `
				<button type="button" data-friend-action="accept">Accept</button>
				<button type="button" class="friends-btn--muted" data-friend-action="decline">Decline</button>
				<button type="button" class="friends-btn--danger" data-friend-action="block">Block</button>`;
		} else if (kind === 'friends') {
			actions = `
				<a href="/messages/" data-friend-message>Message</a>
				<button type="button" class="friends-btn--muted" data-friend-action="remove">Remove</button>
				<button type="button" class="friends-btn--danger" data-friend-action="block">Block</button>`;
		} else if (kind === 'blocked') {
			actions = `<button type="button" class="friends-btn--muted" data-friend-action="unblock">Unblock</button>`;
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
		const outcome = await apiCall('POST', { action, handle });
		if (outcome.ok) {
			render(outcome.data);
			setStatus(action === 'request' ? `Request sent to ${handle}.` : `Done — ${handle}.`);
			return;
		}
		setStatus(copyFor(outcome.error));
	};

	let socket: WebSocket | null = null;
	let pingTimer: number | undefined;
	let reconnectTimer: number | undefined;
	let reconnectDelay = 1_000;
	let pongSeen = true;

	const stopPresence = (): void => {
		window.clearInterval(pingTimer);
		window.clearTimeout(reconnectTimer);
		pingTimer = undefined;
		reconnectTimer = undefined;
		if (socket) {
			try { socket.close(); } catch { /* no-op */ }
			socket = null;
		}
	};

	const startPresence = (): void => {
		stopPresence();
		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
		try {
			socket = new WebSocket(`${protocol}//${window.location.host}/api/presence`);
		} catch {
			return;
		}
		socket.addEventListener('message', (event) => {
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
		socket.addEventListener('close', () => {
			stopPresence();
			// Client-side detection only — the DO keeps no heartbeat (§8.2);
			// reconnect with backoff and take a fresh snapshot on open.
			reconnectTimer = window.setTimeout(() => { reconnectDelay = Math.min(30_000, reconnectDelay * 2); startPresence(); }, reconnectDelay);
		});
		socket.addEventListener('error', () => { try { socket?.close(); } catch { /* no-op */ } });
		// Keep-alive: ping and require a pong; silent socket → force reconnect.
		pongSeen = true;
		pingTimer = window.setInterval(() => {
			if (!socket || socket.readyState !== WebSocket.OPEN) return;
			if (!pongSeen) { try { socket.close(); } catch { /* no-op */ } return; }
			pongSeen = false;
			try { socket.send(JSON.stringify({ t: 'ping' })); } catch { /* no-op */ }
		}, 30_000);
	};

	form?.addEventListener('submit', (event) => {
		event.preventDefault();
		const handle = (handleInput?.value ?? '').trim().toLowerCase();
		if (!handle) return;
		setStatus('Sending…');
		void run('request', handle).then(() => { if (handleInput) handleInput.value = ''; });
	});

	root.addEventListener('click', (event) => {
		const target = event.target as Element | null;
		const actionButton = target?.closest<HTMLElement>('[data-friend-action]');
		if (!actionButton) return;
		const row = actionButton.closest<HTMLElement>('[data-handle]');
		const action = actionButton.dataset.friendAction;
		if (!row || !action || !row.dataset.handle) return;
		setStatus('Working…');
		void run(action, row.dataset.handle).then(() => {
			if (action === 'block') stopPresence(); // my friend set changed → the socket's view is stale
			else if (action === 'unblock' || action === 'accept') startPresence();
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
			setStatus(copyFor(outcome.error));
		}
	})();
}
