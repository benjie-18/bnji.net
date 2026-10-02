/**
 * BNJI.NET — chat plan Phase D: the /messages/ browser surface (plan §7.1).
 *
 * Wiring contract (this is what the e2e spec asserts):
 *   - account gate: unauthenticated visitors get the sign-in panel, nothing else;
 *   - conversation list + exact-handle start (D8 — no directory);
 *   - history over REST (`after`/`before`/default-last-page), live frames over
 *     the DO socket (dm_ready / dm_new / dm_hide / dm_read), reconnect catch-up
 *     with `after` — the DO never carries history (§7.3);
 *   - send: text, or one image the CLIENT normalises through <canvas> first
 *     (bounds the longest edge, re-encodes → EXIF/GPS never leave the
 *     browser, §7.4 step 1), then base64 upload → claim → send;
 *   - delete-for-me (D12), report (§12.5 — status copy mirrors the room flow),
 *     read watermark (§7.1), seen indicator;
 *   - rendering is textContent-only for authored content (§12.1); images are
 *     same-origin <img> to the authenticated media route (nosniff, no-store);
 *   - the disclosure line says plainly what is stored, who can read it, and
 *     that there is no end-to-end encryption (§12.6, owner answer D10).
 */

type Conversation = {
	id: string;
	partner: { handle: string | null; displayName: string };
	mySide: 'lo' | 'hi';
	lastSeq: number;
	myReadSeq: number;
	partnerReadSeq: number;
	unread: number;
	updatedAt: number | null;
	preview: { body: string; hasImage: boolean; fromMe: boolean; at: number } | null;
};

type Message = { n: number; from: 'me' | 'them'; body: string; imageId: string | null; at: number };

type DmConfig = {
	retentionDays: number;
	maxTextLength: number;
	images: { enabled: boolean; maxEdge: number; maxDecodedBytes?: number; allowedTypes: readonly string[] };
};

type ServerFrame =
	| { t: 'dm_ready' }
	| { t: 'dm_new'; m: { n: number; senderSide: 'lo' | 'hi'; body: string; imageId: string | null; at: number } }
	| { t: 'dm_hide'; n: number; bit: number }
	| { t: 'dm_read'; side: 'lo' | 'hi'; seq: number }
	| { t: 'pong' };

const SIDE_BIT: Record<'lo' | 'hi', number> = { lo: 1, hi: 2 };

const ERROR_COPY: Record<string, string> = {
	authentication_required: 'Sign in from the Games page first.',
	dm_disabled: 'Messaging is turned off right now.',
	images_disabled: 'Image attachments are turned off right now.',
	chat_banned: 'A moderator has blocked you from chatting for now.',
	rate_limited: 'Slow down a little and try again.',
	invalid_payload: 'That request was not valid.',
	invalid_json: 'That request was not valid.',
	empty_message: 'Write something first.',
	message_too_long: 'That message is too long.',
	invalid_handle: 'Handles are lowercase letters, numbers and underscores (3–20).',
	handle_not_found: 'No account uses that handle.',
	self_conversation: 'That is your own handle.',
	not_a_member: 'That conversation is not yours.',
	conversation_not_found: 'That conversation no longer exists.',
	message_not_found: 'That message no longer exists.',
	attachment_not_available: 'That image could not be attached — pick it again.',
	unsupported_image_type: 'Use a PNG, JPEG or WebP image.',
	image_too_large: 'That image is too large.',
	invalid_base64: 'That image could not be read.',
	report_own_message: 'You can only report messages you received.',
	storage_unavailable: 'The server is unavailable right now.',
	storage_unconfigured: 'The server is unavailable right now.',
	dm_service_unavailable: 'Live messaging is unavailable — refresh in a moment.',
	not_friends: 'You can only message friends — send a friend request from the Friends page first.',
	blocked: 'You cannot message this account.',
};

function copyFor(error: unknown): string {
	if (typeof error === 'string' && ERROR_COPY[error]) return ERROR_COPY[error];
	return 'Something went wrong — try again.';
}

class ApiError extends Error {
	readonly status: number;
	constructor(status: number, error: string) {
		super(error);
		this.status = status;
	}
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, init);
	let body: unknown = null;
	try { body = await response.json(); } catch { /* non-JSON failure */ }
	const payload = (body ?? {}) as { error?: string };
	if (!response.ok) throw new ApiError(response.status, payload.error ?? 'request_failed');
	return payload as T;
}

function post(path: string, data: unknown): RequestInit {
	return {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(data),
	};
}

function timeLabel(at: number): string {
	try { return new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
	catch { return ''; }
}

/** Exact byte count for padded base64, without allocating a decoded buffer. */
export function decodedBase64ByteLength(value: string): number {
	const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
	return Math.max(0, Math.floor((value.length * 3) / 4) - padding);
}

/** Client-side image normalisation (§7.4 step 1): canvas re-encode = EXIF stripped. */
async function normaliseImage(file: File, maxEdge: number): Promise<{ base64: string; mime: string }> {
	const bitmap = await createImageBitmap(file);
	try {
		const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('canvas_unavailable');
		context.drawImage(bitmap, 0, 0, width, height);
		const blob = await new Promise<Blob | null>((resolve) => {
			canvas.toBlob((value) => resolve(value), 'image/webp', 0.92);
		}) ?? await new Promise<Blob | null>((resolve) => {
			canvas.toBlob((value) => resolve(value), 'image/jpeg', 0.92);
		});
		if (!blob) throw new Error('encode_failed');
		const buffer = await blob.arrayBuffer();
		const bytes = new Uint8Array(buffer);
		let binary = '';
		const chunk = 0x8000;
		for (let index = 0; index < bytes.length; index += chunk) {
			binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
		}
		return { base64: btoa(binary), mime: blob.type };
	} finally {
		bitmap.close();
	}
}

export async function mountMessages(root: HTMLElement): Promise<void> {
	const byAttr = <T extends HTMLElement>(name: string): T => root.querySelector<T>(`[data-${name}]`)!;
	const status = byAttr('dm-status');
	const newStatus = byAttr('dm-new-status');
	const signin = byAttr('dm-signin');
	const signedIn = byAttr('dm-signed-in');
	const disclosure = byAttr('dm-disclosure');
	const list = byAttr<HTMLUListElement>('dm-list');
	const listEmpty = byAttr('dm-list-empty');
	const newForm = byAttr<HTMLFormElement>('dm-new-form');
	const newHandle = byAttr<HTMLInputElement>('dm-new-handle');
	const threadHead = byAttr('dm-thread-head');
	const partnerLabel = byAttr('dm-partner');
	const conn = byAttr('dm-conn');
	const thread = byAttr<HTMLOListElement>('dm-thread');
	const threadEmpty = byAttr('dm-thread-empty');
	const composer = byAttr<HTMLFormElement>('dm-composer');
	const textInput = byAttr<HTMLTextAreaElement>('dm-text');
	const imageInput = byAttr<HTMLInputElement>('dm-image-input');
	const imageChip = byAttr('dm-image-chip');
	const imageName = byAttr('dm-image-name');
	const imageRemove = byAttr<HTMLButtonElement>('dm-image-remove');

	let config: DmConfig = { retentionDays: 60, maxTextLength: 2000, images: { enabled: true, maxEdge: 1600, allowedTypes: ['image/png', 'image/jpeg', 'image/webp'] } };
	let conversations: Conversation[] = [];
	let active: Conversation | null = null;
	let socket: WebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let pendingImage: { id: string; name: string } | null = null;
	let earlierLoaded = false;
	const mountedNs = new Set<number>();

	// Keep composer feedback independent from the exact-handle/open flow: an
	// unsuccessful open must not overwrite a send error (or vice versa).
	const say = (message: string): void => { status.textContent = message; };
	const newSay = (message: string): void => { newStatus.textContent = message; };
	const connSay = (message: string): void => { conn.textContent = message; };

	function renderDisclosure(): void {
		disclosure.textContent =
			`Messages are stored on this site for ${config.retentionDays} days so you can catch up when you come back. ` +
			'The two people in a conversation can read them. Moderators only read a message if it is reported, ' +
			'and this site does not use end-to-end encryption.';
	}

	function fail(error: unknown, target: HTMLElement = status): void {
		target.textContent = error instanceof ApiError ? copyFor(error.message) : copyFor(error);
	}

	/* ------------------------------------------------------------- list */

	function renderList(): void {
		list.textContent = '';
		listEmpty.hidden = conversations.length > 0;
		for (const conversation of conversations) {
			const item = document.createElement('li');
			const button = document.createElement('button');
			button.type = 'button';
			button.dataset.dmOpen = conversation.id;
			if (active?.id === conversation.id) button.setAttribute('aria-current', 'true');
			const name = document.createElement('span');
			name.className = 'dm-list__name';
			const who = document.createElement('span');
			who.textContent = conversation.partner.handle ? `${conversation.partner.displayName} @${conversation.partner.handle}` : conversation.partner.displayName;
			name.appendChild(who);
			if (conversation.unread > 0) {
				const badge = document.createElement('span');
				badge.className = 'dm-list__badge';
				badge.dataset.dmUnread = String(conversation.unread);
				badge.textContent = String(conversation.unread);
				name.appendChild(badge);
			}
			button.appendChild(name);
			if (conversation.preview) {
				const preview = document.createElement('span');
				preview.className = 'dm-list__preview';
				preview.textContent = conversation.preview.hasImage && !conversation.preview.body ? '[image]' : `${conversation.preview.fromMe ? 'You: ' : ''}${conversation.preview.body}`;
				button.appendChild(preview);
			}
			item.appendChild(button);
			list.appendChild(item);
		}
	}

	async function refreshConversations(): Promise<void> {
		const data = await api<{ conversations: Conversation[]; config: DmConfig }>('/api/dm/conversations');
		conversations = data.conversations;
		config = { ...config, ...data.config };
		renderDisclosure();
		renderList();
	}

	/* ------------------------------------------------------------ thread */

	function appendMessage(message: Message, options: { prepend?: boolean } = {}): void {
		if (mountedNs.has(message.n)) return;
		mountedNs.add(message.n);
		const item = document.createElement('li');
		item.className = `dm-msg${message.from === 'me' ? ' dm-msg--me' : ''}`;
		item.dataset.dmN = String(message.n);
		item.dataset.dmFrom = message.from;
		if (message.body) {
			const body = document.createElement('p');
			body.className = 'dm-msg__body';
			body.textContent = message.body;
			item.appendChild(body);
		}
		if (message.imageId) {
			const image = document.createElement('img');
			image.src = `/api/dm/media/${message.imageId}`;
			image.alt = '';
			image.loading = 'lazy';
			item.appendChild(image);
		}
		const meta = document.createElement('div');
		meta.className = 'dm-msg__meta';
		const time = document.createElement('span');
		time.textContent = timeLabel(message.at);
		meta.appendChild(time);
		if (message.from === 'me') {
			const seen = document.createElement('span');
			seen.dataset.dmSeen = String(message.n);
			seen.hidden = true;
			seen.textContent = 'seen';
			meta.appendChild(seen);
		} else {
			const report = document.createElement('button');
			report.type = 'button';
			report.dataset.dmReport = String(message.n);
			report.textContent = 'report';
			meta.appendChild(report);
		}
		const hide = document.createElement('button');
		hide.type = 'button';
		hide.dataset.dmHide = String(message.n);
		hide.textContent = 'delete for me';
		meta.appendChild(hide);
		item.appendChild(meta);
		// insertBefore, not prepend: worker-configuration.d.ts merges Cloudflare's
		// HTMLRewriter Element.prepend into the global Element type and it shadows
		// ParentNode.prepend for DOM nodes.
		if (options.prepend) thread.insertBefore(item, thread.firstChild);
		else thread.appendChild(item);
	}

	function isNearThreadBottom(): boolean {
		return thread.scrollHeight - thread.scrollTop - thread.clientHeight <= 80;
	}

	function scrollThreadToBottom(): void { thread.scrollTop = thread.scrollHeight; }

	function updateSeen(partnerReadSeq: number): void {
		for (const marker of thread.querySelectorAll<HTMLElement>('[data-dm-seen]')) {
			const n = Number(marker.dataset.dmSeen);
			marker.hidden = !(active && n <= partnerReadSeq);
		}
	}

	function setThread(conversation: Conversation, messages: Message[], partnerReadSeq: number): void {
		say('');
		thread.textContent = '';
		mountedNs.clear();
		for (const message of messages) appendMessage(message);
		threadEmpty.hidden = true;
		threadHead.hidden = false;
		composer.hidden = false;
		partnerLabel.textContent = conversation.partner.handle
			? `${conversation.partner.displayName} @${conversation.partner.handle}`
			: conversation.partner.displayName;
		updateSeen(partnerReadSeq);
		thread.scrollTop = thread.scrollHeight;
	}

	async function openConversation(id: string): Promise<void> {
		const conversation = conversations.find((item) => item.id === id);
		if (!conversation) { newSay(copyFor('conversation_not_found')); return; }
		active = conversation;
		earlierLoaded = false;
		renderList();
		newSay('Opening conversation…');
		closeSocket();
		try {
			const data = await api<{ messages: Message[]; myReadSeq: number; partnerReadSeq: number }>(
				`/api/dm/messages?conversation=${encodeURIComponent(id)}`,
			);
			setThread(conversation, data.messages, data.partnerReadSeq);
			conversation.myReadSeq = data.myReadSeq;
			conversation.partnerReadSeq = data.partnerReadSeq;
			renderList();
			await markRead();
			await connectSocket();
			newSay(`Conversation with ${conversation.partner.displayName} open.`);
		} catch (error) {
			fail(error, newStatus);
		}
	}

	async function loadEarlier(): Promise<void> {
		if (!active || earlierLoaded || thread.children.length === 0) return;
		const first = Number((thread.firstElementChild as HTMLElement | null)?.dataset.dmN ?? 0);
		if (!first) return;
		try {
			const data = await api<{ messages: Message[] }>(`/api/dm/messages?conversation=${encodeURIComponent(active.id)}&before=${first}`);
			if (data.messages.length === 0) { earlierLoaded = true; return; }
			const scrollTop = thread.scrollHeight - thread.scrollTop;
			for (const message of [...data.messages].reverse()) appendMessage(message, { prepend: true });
			thread.scrollTop = thread.scrollHeight - scrollTop;
			if (data.messages.length < 50) earlierLoaded = true;
		} catch (error) { fail(error); }
	}

	async function markRead(): Promise<void> {
		const conversationId = active?.id;
		if (!conversationId) return;
		try {
			const result = await api<{ readSeq: number }>('/api/dm/read', post('/api/dm/read', { conversation: conversationId }));
			const conversation = conversations.find((item) => item.id === conversationId);
			if (!conversation) return;
			conversation.myReadSeq = Math.max(conversation.myReadSeq, result.readSeq);
			if (conversation.unread > 0) { conversation.unread = 0; renderList(); }
		} catch { /* watermark is opportunistic; keep the unread badge until it succeeds */ }
	}

	/* --------------------------------------------------------- websocket */

	function closeSocket(): void {
		if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
		if (socket) {
			const closing = socket;
			socket = null;
			closing.onclose = null;
			closing.onmessage = null;
			try { closing.close(); } catch { /* already closed */ }
		}
	}

	async function handleFrame(frame: ServerFrame): Promise<void> {
		if (frame.t === 'dm_ready') {
			connSay('Connected.');
			// Catch-up (§7.3): the DO never carried history, so pull anything the
			// REST read might have missed while the socket was down.
			if (active) {
				const last = Number(thread.lastElementChild?.getAttribute('data-dm-n') ?? 0);
				const data = await api<{ messages: Message[] }>(`/api/dm/messages?conversation=${encodeURIComponent(active.id)}&after=${last}`);
				const followTail = isNearThreadBottom();
				for (const message of data.messages) appendMessage(message);
				if (data.messages.length > 0 && followTail) scrollThreadToBottom();
			}
			return;
		}
		if (frame.t === 'dm_new' && active) {
			const from = frame.m.senderSide === active.mySide ? 'me' : 'them';
			const followTail = isNearThreadBottom();
			appendMessage({ n: frame.m.n, from, body: frame.m.body, imageId: frame.m.imageId, at: frame.m.at });
			if (followTail) scrollThreadToBottom();
			if (from === 'them') {
				await markRead();
				await refreshConversations();
			}
			return;
		}
		if (frame.t === 'dm_hide') {
			const mine = active ? SIDE_BIT[active.mySide] : 0;
			if (frame.bit === mine) {
				thread.querySelector(`[data-dm-n="${frame.n}"]`)?.remove();
				mountedNs.delete(frame.n);
			}
			return;
		}
		if (frame.t === 'dm_read' && active && frame.side !== active.mySide) {
			active.partnerReadSeq = frame.seq;
			updateSeen(frame.seq);
		}
	}

	function connectSocket(): Promise<void> {
		const conversation = active;
		if (!conversation) return Promise.resolve();
		const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
		return new Promise((resolve) => {
			try {
				socket = new WebSocket(`${scheme}://${location.host}/api/dm/ws?conversation=${encodeURIComponent(conversation.id)}`);
			} catch {
				connSay('Live updates unavailable.');
				resolve();
				return;
			}
			const current = conversation.id;
			socket.onopen = () => { connSay('Connecting…'); };
			socket.onmessage = (event) => {
				if (typeof event.data !== 'string') return;
				try {
					const frame = JSON.parse(event.data) as ServerFrame;
					void handleFrame(frame).catch(() => { /* frames are best-effort */ });
				} catch { /* non-JSON */ }
			};
			socket.onclose = () => {
				if (active?.id !== current) return;
				connSay('Disconnected — retrying…');
				if (!reconnectTimer) {
					reconnectTimer = setTimeout(() => {
						reconnectTimer = null;
						if (active?.id === current) void connectSocket().then(resolve);
					}, 3_000);
				} else { resolve(); }
			};
			socket.onerror = () => { /* onclose follows */ };
			resolve();
		});
	}

	/* ------------------------------------------------------------- send */

	function appendSent(message: Message): void {
		appendMessage(message);
		thread.scrollTop = thread.scrollHeight;
	}

	async function sendMessage(): Promise<void> {
		if (!active) return;
		const body = textInput.value;
		if (!body.trim() && !pendingImage) { say(copyFor('empty_message')); return; }
		const buttons = composer.querySelectorAll('button');
		buttons.forEach((button) => { button.disabled = true; });
		try {
			let imageId: string | null = null;
			if (pendingImage) {
				imageId = pendingImage.id;
			}
			const data = await api<{ message: Message }>('/api/dm/messages', post('/api/dm/messages', {
				conversation: active.id,
				...(body.trim() ? { body } : {}),
				...(imageId ? { imageId } : {}),
			}));
			textInput.value = '';
			clearPendingImage();
			appendSent(data.message);
			say('Message sent.');
			void refreshConversations();
		} catch (error) {
			fail(error);
		} finally {
			buttons.forEach((button) => { button.disabled = false; });
		}
	}

	function clearPendingImage(): void {
		pendingImage = null;
		imageInput.value = '';
		imageChip.hidden = true;
		imageName.textContent = '';
	}

	async function attachImage(file: File): Promise<void> {
		if (!active || !config.images.enabled) return;
		const cap = config.images.maxDecodedBytes ?? 1_400_000;
		try {
			say('Preparing image…');
			const { base64 } = await normaliseImage(file, config.images.maxEdge);
			// The source may be larger if canvas normalization shrinks it; enforce
			// the D1 ceiling on the exact normalized payload that will be uploaded.
			const decodedBytes = decodedBase64ByteLength(base64);
			if (decodedBytes > cap) { say(copyFor('image_too_large')); return; }
			const data = await api<{ attachment: { id: string; mime: string } }>('/api/dm/attachments', post('/api/dm/attachments', {
				conversation: active.id,
				data: base64,
			}));
			pendingImage = { id: data.attachment.id, name: file.name };
			imageName.textContent = file.name;
			imageChip.hidden = false;
			say('Image ready — add a note and send.');
		} catch (error) {
			clearPendingImage();
			fail(error);
		}
	}

	/* ------------------------------------------------------------- wiring */

	async function startConversation(handle: string): Promise<void> {
		newSay('Opening conversation…');
		try {
			const data = await api<{ conversation: { id: string; mySide: 'lo' | 'hi'; partner: { handle: string | null; displayName: string }; exists: boolean } }>(
				'/api/dm/conversations',
				post('/api/dm/conversations', { handle }),
			);
			await refreshConversations();
			// The list only shows conversations with a first message (§7.1), so a
			// just-opened thread is absent from the refresh — merge the POST
			// response in locally or openConversation can never find it.
			if (!conversations.some((item) => item.id === data.conversation.id)) {
				conversations.unshift({
					id: data.conversation.id,
					partner: data.conversation.partner,
					mySide: data.conversation.mySide,
					lastSeq: 0,
					myReadSeq: 0,
					partnerReadSeq: 0,
					unread: 0,
					updatedAt: null,
					preview: null,
				});
				renderList();
			}
			await openConversation(data.conversation.id);
			newHandle.value = '';
		} catch (error) {
			fail(error, newStatus);
		}
	}

	newForm.addEventListener('submit', (event) => {
		event.preventDefault();
		const handle = newHandle.value.trim();
		if (handle) void startConversation(handle);
	});

	list.addEventListener('click', (event) => {
		const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-dm-open]');
		if (button?.dataset.dmOpen) void openConversation(button.dataset.dmOpen);
	});

	thread.addEventListener('click', (event) => {
		const target = event.target as HTMLElement;
		const hide = target.closest<HTMLButtonElement>('[data-dm-hide]');
		if (hide && active && hide.dataset.dmHide) {
			const n = Number(hide.dataset.dmHide);
			void (async () => {
				try {
					await api('/api/dm/hide', post('/api/dm/hide', { conversation: active!.id, n }));
					thread.querySelector(`[data-dm-n="${n}"]`)?.remove();
					mountedNs.delete(n);
					say('Removed from your view.');
				} catch (error) { fail(error); }
			})();
			return;
		}
		const report = target.closest<HTMLButtonElement>('[data-dm-report]');
		if (report && active && report.dataset.dmReport) {
			const n = Number(report.dataset.dmReport);
			void (async () => {
				try {
					await api('/api/dm/report', post('/api/dm/report', { conversation: active!.id, n }));
					report.disabled = true;
					say('Report sent to the moderators for review.');
				} catch (error) { fail(error); }
		 })();
		}
	});

	// Scrollback: explicit control instead of scroll magic.
	thread.addEventListener('scroll', () => { if (thread.scrollTop < 24) void loadEarlier(); });

	composer.addEventListener('submit', (event) => {
		event.preventDefault();
		void sendMessage();
	});

	textInput.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			void sendMessage();
		}
	});

	imageInput.addEventListener('change', () => {
		const file = imageInput.files?.[0];
		if (file) void attachImage(file);
	});
	imageRemove.addEventListener('click', () => clearPendingImage());

	window.addEventListener('focus', () => { if (active) { void markRead(); void refreshConversations(); } });
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible' && active) { void markRead(); void refreshConversations(); }
	});

	/* -------------------------------------------------------------- boot */

	try {
		const account = await api<{ authenticated: boolean; displayName?: string }>('/api/games/account');
		if (!account.authenticated || !account.displayName) {
			status.textContent = 'Sign in to see your messages.';
			signin.hidden = false;
			return;
		}
		await refreshConversations();
		signedIn.hidden = false;
		status.textContent = conversations.length
			? `Signed in as ${account.displayName}. ${conversations.length} conversation(s).`
			: `Signed in as ${account.displayName}. No conversations yet.`;

		// Deep link from the Friends page (/messages/?handle=x): open that
		// conversation once, then clean the URL so a refresh does not re-fire
		// it. The D7 gate answers 403 not_friends below the handle field if
		// the pair stopped being friends meanwhile.
		const requestedHandle = new URL(window.location.href).searchParams.get('handle');
		if (requestedHandle && /^[a-z0-9_]{3,20}$/.test(requestedHandle)) {
			window.history.replaceState(null, '', window.location.pathname + window.location.hash);
			void startConversation(requestedHandle);
		}
	} catch (error) {
		signin.hidden = false;
		fail(error);
	}
}
