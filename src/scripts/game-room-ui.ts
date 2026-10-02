import { connectGameRoom, createGameRoom, type RoomNotice, type RoomCloseInfo } from './game-rooms';
import { NAMES_CONFIG } from '../config/names.config';
import { CHAT_CONFIG } from '../config/chat.config';
import { LOBBY_CONFIG } from '../config/lobby.config';
import { hasRegisteredAdapter } from '../data/game-adapters';
import { getGame } from '../data/games';
import type { LobbyList, LobbyRow } from '../server/game-lobby';

/** Optional bridge so a game page can observe/send on the SAME room socket. */
export type RoomObserver = {
	onFrame?: (message: RoomNotice) => void;
	onSocket?: (socket: WebSocket | null) => void;
};

type ChatFrame = { n: number; label: string; text: string; at: number; mine?: boolean; removed?: 'host' | 'self' | 'admin' };
type MemberFrame = { memberId: string; label: string; isHost: boolean; isSelf: boolean; muted: boolean };

export function mountGameRooms(root: HTMLElement, observer: RoomObserver = {}): void {
	const live = root.querySelector<HTMLElement>('[data-room-live]');
	const codePanel = root.querySelector<HTMLElement>('[data-room-code-panel]');
	const codeOutput = root.querySelector<HTMLOutputElement>('[data-room-code]');
	const codeInput = root.querySelector<HTMLInputElement>('[name="roomCode"]');
	const leaveButton = root.querySelector<HTMLButtonElement>('[data-room-leave]');
	let activeSocket: WebSocket | null = null;
	let roomCode = '';
	function say(message: string): void { if (live) live.textContent = message; }

	// ------------------------------------------------------------- chat panel
	const chatPanel = root.querySelector<HTMLElement>('[data-chat-panel]');
	const chatList = root.querySelector<HTMLOListElement>('[data-chat-messages]');
	const chatStatus = root.querySelector<HTMLElement>('[data-chat-status]');
	const chatForm = root.querySelector<HTMLFormElement>('[data-chat-form]');
	const chatInput = chatForm?.querySelector<HTMLInputElement>('[name="text"]') ?? null;
	const chatSend = chatForm?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null;
	const roster = root.querySelector<HTMLUListElement>('[data-chat-roster]');
	const seenChat = new Map<number, HTMLElement>();
	let isHost = false;

	// --------------------------------------------------- profile name (plan §4)
	// GET the current label so the form reflects the server's truth; POST edits
	// with a plain-language status — never a raw error code.
	const nameForm = root.querySelector<HTMLFormElement>('[data-profile-name]');
	const nameInput = nameForm?.querySelector<HTMLInputElement>('[name="displayName"]') ?? null;
	const nameStatus = root.querySelector<HTMLElement>('[data-profile-name-status]');
	const scopeLabel = (scope: unknown): string => (scope === 'account' ? 'account name' : 'guest name');
	const paintNameStatus = (displayName: string | null, scope: unknown): void => {
		if (nameInput && displayName) nameInput.value = displayName;
		if (nameStatus && displayName) nameStatus.textContent = `Current name: ${displayName} · ${scopeLabel(scope)}`;
	};
	if (nameForm) {
		void (async () => {
			try {
				const response = await fetch('/api/profile/name', { credentials: 'same-origin', cache: 'no-store' });
				if (!response.ok) throw new Error('load_failed');
				const data = await response.json() as { displayName?: string | null; scope?: string };
				paintNameStatus(typeof data.displayName === 'string' && data.displayName ? data.displayName : null, data.scope);
			} catch {
				if (nameStatus) nameStatus.textContent = 'Your current name could not be loaded.';
			}
		})();
		nameForm.addEventListener('submit', async (event) => {
			event.preventDefault();
			if (!nameInput || !nameStatus) return;
			const displayName = nameInput.value.trim();
			if (!displayName) { nameStatus.textContent = 'Type a name first.'; return; }
			const submit = nameForm.querySelector<HTMLButtonElement>('button[type="submit"]');
			if (submit) submit.disabled = true;
			nameInput.disabled = true;
			try {
				const response = await fetch('/api/profile/name', {
					method: 'POST', credentials: 'same-origin', cache: 'no-store',
					headers: { 'content-type': 'application/json' }, body: JSON.stringify({ displayName }),
				});
				const data = await response.json().catch(() => ({})) as { displayName?: string; scope?: string; error?: string; retryAfter?: number };
				if (!response.ok) {
					nameStatus.textContent = data.error === 'display_name_reserved' ? 'That name is reserved — pick another.'
						: data.error === 'display_name_too_long' ? `That name is too long — ${NAMES_CONFIG.displayName.maxLength} characters maximum.`
						: data.error === 'invalid_display_name' ? `That name can't be used — pick another.`
						: data.error === 'rate_limited' ? `Too many attempts. Try again in ${Math.ceil(Number(data.retryAfter ?? 60) / 60)} minutes.`
						: 'Could not save the name. Try again when online.';
					return;
				}
				const saved = typeof data.displayName === 'string' && data.displayName ? data.displayName : displayName;
				nameStatus.textContent = scopeLabel(data.scope) === 'guest name'
					? `Name saved: ${saved} · guest name, kept ${NAMES_CONFIG.guestProfiles.retentionDays} days`
					: `Name saved: ${saved} · account name`;
				nameInput.value = saved;
			} catch {
				nameStatus.textContent = 'Could not reach the server. Try again when online.';
			} finally {
				nameInput.disabled = false;
				if (submit) submit.disabled = false;
			}
		});
	}
	function chatSay(message: string): void { if (chatStatus) chatStatus.textContent = message; }
	function setChatEnabled(enabled: boolean): void {
		if (chatInput) chatInput.disabled = !enabled;
		if (chatSend) chatSend.disabled = !enabled;
	}
	function clock(at: number): string {
		return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	}
	function renderChat(frame: ChatFrame): void {
		if (!chatList || seenChat.has(frame.n)) return;
		const item = document.createElement('li');
		// JS-created rows carry the global primitive: an Astro-scoped rule can never
		// reach a node that did not exist when the page compiled.
		item.className = 'glass-item room-tools__chat-item';
		item.dataset.chatN = String(frame.n);
		const meta = document.createElement('span');
		meta.className = 'room-tools__chat-meta';
		const body = document.createElement('span');
		body.className = 'room-tools__chat-text';
		const actions = document.createElement('span');
		actions.className = 'room-tools__chat-actions';
		item.appendChild(meta);
		item.appendChild(body);
		item.appendChild(actions);
		chatList.appendChild(item);
		seenChat.set(frame.n, item);
		paintChat(item, frame);
		chatList.scrollTop = chatList.scrollHeight;
	}
	function paintChat(item: HTMLElement, frame: ChatFrame): void {
		const meta = item.querySelector<HTMLElement>(':scope > .room-tools__chat-meta');
		const body = item.querySelector<HTMLElement>(':scope > .room-tools__chat-text');
		const actions = item.querySelector<HTMLElement>(':scope > .room-tools__chat-actions');
		if (!meta || !body || !actions) return;
		actions.replaceChildren();
		if (frame.removed) {
			meta.textContent = frame.removed === 'admin' ? 'An administrator removed a message'
				: frame.removed === 'host' ? 'Room host removed a message' : 'Message deleted';
			body.textContent = 'message removed';
			item.classList.add('room-tools__chat-item--removed');
			return;
		}
		meta.textContent = `${frame.label} · ${clock(frame.at)}`;
		body.textContent = frame.text;
		item.classList.remove('room-tools__chat-item--removed');
		if (frame.mine) actions.appendChild(chatAction('Delete', () => sendChatFrame({ v: 1, type: 'chat_delete', n: frame.n })));
		else {
			if (isHost) actions.appendChild(chatAction('Remove', () => sendChatFrame({ v: 1, type: 'chat_delete', n: frame.n })));
			actions.appendChild(chatAction('Report', (button) => reportMessage(frame.n, button)));
		}
	}
	function chatAction(label: string, run: (button: HTMLButtonElement) => void): HTMLButtonElement {
		const button = document.createElement('button');
		button.type = 'button';
		// Row material + control primitive, both global: a button built here has to
		// look right on the Games page and inside a game page's RoomPanel, and
		// neither page's scoped CSS can style it.
		button.className = 'glass-button glass-button--quiet glass-button--sm room-tools__chat-action';
		button.textContent = label;
		button.addEventListener('click', () => run(button));
		return button;
	}
	/** Plan §6.4 — POST /api/chat/report; the room snapshots the message, D1 keeps the evidence. */
	async function reportMessage(n: number, button: HTMLButtonElement): Promise<void> {
		if (!roomCode) return;
		button.disabled = true;
		try {
			const response = await fetch('/api/chat/report', {
				method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ code: roomCode, n }),
			});
			const body = await response.json().catch(() => ({})) as { error?: string };
			if (response.ok) chatSay('Thanks — the message was sent to the moderators for review.');
			else if (body.error === 'rate_limited') chatSay('You have reported a lot of messages lately — try again in a few minutes.');
			else if (body.error === 'not_member') chatSay('You need to be in the room to report one of its messages.');
			else if (body.error === 'message_not_found') chatSay('That message is no longer available to report.');
			else if (body.error === 'chat_disabled') chatSay('Chat is turned off right now.');
			else chatSay('The report could not be sent. Try again in a moment.');
		} catch {
			chatSay('The report could not be sent. Check your connection and try again.');
		} finally {
			button.disabled = false;
		}
	}
	function sendChatFrame(frame: Record<string, unknown>): boolean {
		if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) { chatSay('Not connected to a room.'); return false; }
		activeSocket.send(JSON.stringify(frame));
		return true;
	}
	function renderRoster(members: MemberFrame[]): void {
		if (!roster) return;
		roster.replaceChildren();
		for (const member of members) {
			const item = document.createElement('li');
			item.className = 'glass-item room-tools__roster-item';
			const name = document.createElement('span');
			name.textContent = `${member.label}${member.isHost ? ' · host' : ''}${member.muted ? ' · muted' : ''}`;
			item.appendChild(name);
			if (isHost && !member.isSelf) {
				const kick = chatAction('Kick', () => sendChatFrame({ v: 1, type: 'kick', member: member.memberId }));
				kick.setAttribute('aria-label', `Remove ${member.label} from the room`);
				item.appendChild(kick);
				if (!member.muted) {
					const mute = chatAction('Mute', () => sendChatFrame({ v: 1, type: 'mute', member: member.memberId }));
					mute.setAttribute('aria-label', `Mute ${member.label} for the rest of this room's life`);
					item.appendChild(mute);
				}
			}
			roster.appendChild(item);
		}
		roster.hidden = members.length === 0;
	}
	function handleChatNotice(message: RoomNotice): boolean {
		if (message.type === 'chat' && typeof message.n === 'number' && typeof message.text === 'string' && typeof message.label === 'string') {
			renderChat({ n: message.n, label: message.label, text: message.text, at: message.at ?? Date.now(), mine: message.mine, removed: message.removed });
			return true;
		}
		if (message.type === 'chat_history' && Array.isArray(message.messages)) {
			for (const frame of message.messages) renderChat(frame);
			return true;
		}
		if (message.type === 'chat_delete' && typeof message.n === 'number') {
			const item = seenChat.get(message.n);
			const removed: 'self' | 'admin' | 'host' = message.source === 'self' || message.source === 'admin' ? message.source : 'host';
			if (item) paintChat(item, { n: message.n, label: '', text: '', at: 0, removed });
			return true;
		}
		if (message.type === 'chat_rejected') {
			const error = message.error;
			chatSay(error === 'rate_limited' ? `Slow down — try again in ${Math.max(1, Math.ceil(Number(message.retryAfterMs ?? 1_000) / 1_000))} seconds.`
				: error === 'muted' ? 'You are muted in this room for its remaining lifetime.'
				: error === 'chat_disabled' ? 'Chat is turned off right now.'
				: error === 'invalid_text' ? `Messages are plain text up to ${CHAT_CONFIG.maxTextLength} characters.`
			: error === 'blocked' ? `That message was blocked by this room's word filter.`
				: error === 'invalid_target' ? 'That member cannot be controlled.'
				: 'That action is not allowed in this room.');
			return true;
		}
		if (message.type === 'members' && Array.isArray(message.members)) {
			renderRoster(message.members as MemberFrame[]);
			return true;
		}
		return false;
	}
	chatForm?.addEventListener('submit', (event) => {
		event.preventDefault();
		if (!chatInput) return;
		const text = chatInput.value;
		if (!sendChatFrame({ v: 1, type: 'chat', text })) return;
		chatInput.value = '';
	});
	if (!CHAT_CONFIG.enabled && chatPanel) chatPanel.hidden = true;

	// ---------------------------------------------------------- open lobbies
	// The list is a read of /api/games/lobbies, not a registry this panel keeps:
	// a room that is full, gone or too slow to answer is absent rather than
	// listed and broken. `data-lobby-scope` on the section is the game this page
	// hosts; a page with no fixed game (the catalog) lists every game.
	const lobbyPanel = root.querySelector<HTMLElement>('[data-room-lobbies]');
	const lobbyList = root.querySelector<HTMLUListElement>('[data-lobby-list]');
	const lobbyStatus = root.querySelector<HTMLElement>('[data-lobby-status]');
	const lobbyRefresh = root.querySelector<HTMLButtonElement>('[data-lobby-refresh]');
	const lobbyScope = lobbyPanel?.dataset.lobbyScope ?? '';
	let lobbyTimer: number | undefined;
	let lobbyCooldownUntil = 0;
	const lobbySay = (message: string): void => { if (lobbyStatus) lobbyStatus.textContent = message; };

	function minutesLeft(expiresAt: number): string {
		const left = expiresAt - Date.now();
		if (!Number.isFinite(left) || left <= 0) return 'closing now';
		if (left < 90_000) return 'under a minute left';
		return `${Math.round(left / 60_000)} min left`;
	}

	function lobbyRow(row: LobbyRow): HTMLLIElement {
		const item = document.createElement('li');
		item.className = 'glass-item room-lobby';
		const who = document.createElement('span');
		who.className = 'room-lobby__who';
		const title = document.createElement('strong');
		title.textContent = getGame(row.gameId)?.title ?? row.gameId;
		const meta = document.createElement('span');
		meta.className = 'room-lobby__meta';
		meta.textContent = `${row.players}/${row.capacity} players · ${minutesLeft(row.expiresAt)}`;
		who.appendChild(title);
		who.appendChild(meta);
		const join = document.createElement('button');
		join.type = 'button';
		join.className = 'glass-button glass-button--primary glass-button--sm';
		join.textContent = 'Join';
		join.setAttribute('aria-label', `Join the ${title.textContent} room — ${row.players} of ${row.capacity} players`);
		join.addEventListener('click', () => { connect(row.roomCode); lobbySay('Joining…'); });
		item.appendChild(who);
		item.appendChild(join);
		return item;
	}

	function renderLobbies(body: LobbyList & { cached?: boolean }): void {
		if (!lobbyList) return;
		lobbyList.replaceChildren();
		const rows = body.lobbies ?? [];
		lobbyList.hidden = rows.length === 0;
		if (rows.length === 0) {
			lobbySay('No open rooms right now. Create one — it will be listed here for anyone to join.');
			return;
		}
		for (const row of rows) lobbyList.appendChild(lobbyRow(row));
		lobbySay(`${rows.length} open room${rows.length === 1 ? '' : 's'}${body.stale ? ' — some rooms did not answer and are not shown' : ''}.`);
	}

	async function refreshLobbies(force = false): Promise<void> {
		if (!lobbyPanel) return;
		if (!force && Date.now() < lobbyCooldownUntil) return;
		lobbyCooldownUntil = Date.now() + LOBBY_CONFIG.minRefreshSeconds * 1_000;
		window.clearTimeout(lobbyTimer);
		if (lobbyRefresh) lobbyRefresh.disabled = true;
		try {
			const query = lobbyScope ? `?gameId=${encodeURIComponent(lobbyScope)}` : '';
			const response = await fetch(`/api/games/lobbies${query}`, {
				headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store',
			});
			const body = await response.json().catch(() => null) as (LobbyList & { error?: string }) | null;
			if (!response.ok) {
				lobbySay(body?.error === 'lobby_disabled' ? 'Open lobbies are turned off right now.'
					: body?.error === 'rate_limited' ? 'Slow down a moment, then refresh again.'
					: 'Open rooms could not be loaded.');
				return;
			}
			if (body) renderLobbies(body);
			const wait = Math.max(LOBBY_CONFIG.minRefreshSeconds, Number(body?.refreshAfterSeconds ?? LOBBY_CONFIG.cacheTtlSeconds));
			lobbyTimer = window.setTimeout(() => void refreshLobbies(true), wait * 1_000);
		} catch {
			lobbySay('Open rooms could not be loaded — check your connection.');
		} finally {
			window.setTimeout(() => { if (lobbyRefresh) lobbyRefresh.disabled = false; }, LOBBY_CONFIG.minRefreshSeconds * 1_000);
		}
	}
	if (lobbyPanel) {
		lobbyRefresh?.addEventListener('click', () => void refreshLobbies());
		void refreshLobbies();
	}

	function connect(code: string): void {
		if (activeSocket && activeSocket.readyState < WebSocket.CLOSING) activeSocket.close(1000, 'Switching rooms');
		roomCode = code;
		// Games (e.g. PvP Minesweeper claims) read the active room code from the panel root.
		root.dataset.roomCode = code;
		if (codeInput) codeInput.value = code;
		if (codePanel) codePanel.hidden = false;
		if (codeOutput) codeOutput.value = code;
		// Fresh room, fresh chat: history will repopulate from the snapshot burst.
		seenChat.clear();
		chatList?.replaceChildren();
		roster?.replaceChildren();
		if (roster) roster.hidden = true;
		chatSay('Connecting to the room chat…');
		activeSocket = connectGameRoom(code, (message: RoomNotice) => {
			observer.onFrame?.(message);
			if (message.type === 'snapshot') {
				isHost = Boolean(message.isHost);
				say(`Connected to ${message.gameId ?? 'room'} · version ${message.revision ?? 0} · ${message.connectedMembers ?? 1} member${message.connectedMembers === 1 ? '' : 's'}. ${message.isHost ? 'You are the room host.' : message.hasHost ? 'Another member is the room host.' : 'The room has no connected host.'} ${hasRegisteredAdapter(message.gameId) ? 'Game rules are validated on the server.' : 'No game adapter is registered, so game-state updates are disabled.'}`);
				chatSay(CHAT_CONFIG.enabled ? 'Connected to chat. Messages are stored only while this room exists.' : 'Chat is turned off right now.');
			}
			else if (message.type === 'presence') {
				isHost = Boolean(message.isHost);
				say(`Room connected · ${message.connectedMembers ?? 0} member${message.connectedMembers === 1 ? '' : 's'}. ${message.isHost ? 'You are the room host.' : message.hasHost ? 'Another member is the room host.' : 'The room has no connected host.'}`);
			}
			else if (message.type === 'conflict') say(`Room state changed to version ${message.revision ?? 0}; reconnecting clients receive the latest snapshot.`);
			else if (message.type === 'state_rejected') say(message.error === 'game_adapter_unavailable' ? 'No game adapter is registered; state changes are refused.' : 'The game authority rejected that state change.');
			else handleChatNotice(message);
		}, (state, close) => {
			observer.onSocket?.(state === 'connected' ? activeSocket : null);
			if (state === 'connecting') { if (leaveButton) leaveButton.disabled = true; setChatEnabled(false); say('Connecting to room…'); }
			else if (state === 'connected') { if (leaveButton) leaveButton.disabled = false; setChatEnabled(CHAT_CONFIG.enabled); }
			else if (state === 'closed') {
				if (leaveButton) leaveButton.disabled = true;
				setChatEnabled(false);
				// The close code is the only thing that distinguishes "the host removed
				// you" from "the room is gone", so it picks the sentence here.
				const removed = close?.code === 4003;
				const ended = close?.code === 4002;
				const message = removed
					? 'The room host removed you. That room will not let you rejoin; you can create or join another one.'
					: ended
						? 'The room ended, and everything in it was deleted.'
						: 'Room connection closed. Re-enter the code to reconnect while the room is active.';
				if (removed || ended) {
					// The code is dead to this visitor: keeping it on screen only invites
					// the rejoin the server will refuse.
					roomCode = '';
					root.dataset.roomCode = '';
					if (codePanel) codePanel.hidden = true;
					roster?.replaceChildren();
					if (roster) roster.hidden = true;
					void refreshLobbies(true);
				}
				chatSay(message);
				say(message);
			}
			else if (state === 'error') { if (leaveButton) leaveButton.disabled = true; setChatEnabled(false); chatSay('Room connection failed. Check the code and connection, then try again.'); say('Room connection failed. Check the code and connection, then try again.'); }
		});
	}
	root.querySelector<HTMLFormElement>('[data-room-create]')?.addEventListener('submit', async (event) => {
		event.preventDefault();
		const form = event.currentTarget as HTMLFormElement;
		const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
		if (submit) submit.disabled = true;
		say('Creating a temporary room…');
		try {
			const gameId = String(new FormData(form).get('gameId') ?? '');
			const room = await createGameRoom(gameId);
			connect(room.roomCode);
			const expiry = new Date(room.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
			say(`Room created. It expires at ${expiry}; up to ${room.capacity} members. Connecting…`);
		} catch (error) {
			const message = error instanceof Error && error.message === 'rate_limited' ? 'Room creation is temporarily rate-limited.' : 'Room service is unavailable. You can still play and keep local progress.';
			say(message);
		} finally { if (submit) submit.disabled = false; }
	});
	root.querySelector<HTMLFormElement>('[data-room-join]')?.addEventListener('submit', (event) => {
		event.preventDefault();
		const code = codeInput?.value.trim() ?? '';
		if (!/^[A-Za-z0-9_-]{22}$/.test(code)) { say('Enter the 22-character room code.'); return; }
		connect(code);
	});
	root.querySelector<HTMLButtonElement>('[data-room-copy]')?.addEventListener('click', async () => {
		if (!roomCode) return;
		try { await navigator.clipboard.writeText(roomCode); say('Room code copied. Share it privately; anyone with it may join.'); }
		catch { say('Copy was blocked. Select the room code and copy it manually.'); }
	});
	leaveButton?.addEventListener('click', () => {
		if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) return;
		leaveButton.disabled = true;
		activeSocket.send(JSON.stringify({ v: 1, type: 'leave' }));
		say('Leaving the room…');
	});
}
