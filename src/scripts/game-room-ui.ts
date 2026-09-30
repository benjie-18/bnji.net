import { connectGameRoom, createGameRoom, type RoomNotice } from './game-rooms';

export function mountGameRooms(root: HTMLElement): void {
	const live = root.querySelector<HTMLElement>('[data-room-live]');
	const codePanel = root.querySelector<HTMLElement>('[data-room-code-panel]');
	const codeOutput = root.querySelector<HTMLOutputElement>('[data-room-code]');
	const codeInput = root.querySelector<HTMLInputElement>('[name="roomCode"]');
	const leaveButton = root.querySelector<HTMLButtonElement>('[data-room-leave]');
	let activeSocket: WebSocket | null = null;
	let roomCode = '';
	function say(message: string): void { if (live) live.textContent = message; }
	function connect(code: string): void {
		if (activeSocket && activeSocket.readyState < WebSocket.CLOSING) activeSocket.close(1000, 'Switching rooms');
		roomCode = code;
		if (codeInput) codeInput.value = code;
		if (codePanel) codePanel.hidden = false;
		if (codeOutput) codeOutput.value = code;
		activeSocket = connectGameRoom(code, (message: RoomNotice) => {
			if (message.type === 'snapshot') say(`Connected to ${message.gameId ?? 'room'} · version ${message.revision ?? 0} · ${message.connectedMembers ?? 1} member${message.connectedMembers === 1 ? '' : 's'}. ${message.isHost ? 'You are the room host.' : message.hasHost ? 'Another member is the room host.' : 'The room has no connected host.'} No game adapter is registered, so game-state updates are disabled.`);
			else if (message.type === 'presence') say(`Room connected · ${message.connectedMembers ?? 0} member${message.connectedMembers === 1 ? '' : 's'}. ${message.isHost ? 'You are the room host.' : message.hasHost ? 'Another member is the room host.' : 'The room has no connected host.'}`);
			else if (message.type === 'conflict') say(`Room state changed to version ${message.revision ?? 0}; reconnecting clients receive the latest snapshot.`);
			else if (message.type === 'state_rejected') say(message.error === 'game_adapter_unavailable' ? 'No game adapter is registered; state changes are refused.' : 'The game authority rejected that state change.');
		}, (state) => {
			if (state === 'connecting') { if (leaveButton) leaveButton.disabled = true; say('Connecting to room…'); }
			else if (state === 'connected') { if (leaveButton) leaveButton.disabled = false; say('Connected. Waiting for the room snapshot…'); }
			else if (state === 'closed') { if (leaveButton) leaveButton.disabled = true; say('Room connection closed. Re-enter the code to reconnect while the room is active.'); }
			else if (state === 'error') { if (leaveButton) leaveButton.disabled = true; say('Room connection failed. Check the code and connection, then try again.'); }
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
