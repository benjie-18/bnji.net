/**
 * Board moderation — the admin-only half of the full list.
 *
 * WHY THIS IS A SEPARATE MODULE
 * -----------------------------
 * The full list renders from fetched data, so its rows — and the Delete
 * control on them — have to be built in the browser. The obvious
 * implementation is a few lines inside scripts/board.ts, guarded by a flag
 * the server put on the root element.
 *
 * That guard is sufficient for correctness and NOT sufficient for the
 * requirement it was written to meet. A runtime `if` still puts the delete
 * code, its class name and the admin endpoint URL in the bundle that EVERY
 * visitor downloads. Anyone can read it in a network tab. It grants no
 * capability — the endpoint independently rejects them — but shipping it
 * says "this site has a delete button, and here is how it calls it", which
 * is the disclosure the requirement exists to prevent.
 *
 * So the code lives here and is reached only through a dynamic import, which
 * the bundler emits as its own chunk. A non-admin's network tab shows no
 * request for it at all, and their payload contains none of it. An admin
 * fetches exactly one extra file, once, the first time they open the list.
 *
 * The same reasoning applies to the control's STYLES, which is why they are
 * injected here rather than living in board.css: a stylesheet is fetched
 * unconditionally, so a rule naming the delete button would put that name in
 * every visitor's payload for no reason. The button cannot exist in a
 * browser that has not already loaded this chunk, so its CSS can arrive
 * with it. Tokens only — the design system is not extended to make room for
 * an admin affordance.
 *
 * The server-side flag decides whether this module is ever imported. The
 * server-side check on POST /api/admin/board decides whether a delete
 * actually happens. Neither one trusts the other.
 */

type DeleteOutcome =
	| { kind: 'deleted' }
	| { kind: 'gone' }
	| { kind: 'unauthorised' }
	| { kind: 'failed' };

const STYLE_ID = 'board-list-delete-styles';

const CSS = `
.board-list__delete {
	align-self: start;
	justify-self: end;
	padding: 0.3rem 0.6rem;
	font-size: var(--text-micro);
	letter-spacing: var(--tracking-mono);
	text-transform: uppercase;
	color: var(--text-muted);
	background: transparent;
	border: 1px solid var(--glass-border);
	border-radius: var(--radius-pill);
	cursor: pointer;
	transition: color var(--dur-fast) var(--ease-out),
		border-color var(--dur-fast) var(--ease-out),
		background-color var(--dur-fast) var(--ease-out);
}
.board-list__delete:hover:not(:disabled) {
	color: var(--text-strong);
	border-color: var(--glass-border-strong);
	background: var(--glass-bg);
}
.board-list__delete:focus-visible {
	outline: 2px solid var(--accent-strong);
	outline-offset: 2px;
}
.board-list__delete:disabled {
	opacity: 0.55;
	cursor: default;
}
@media (max-width: 560px) {
	.board-list__delete {
		justify-self: start;
	}
}
@media (prefers-reduced-motion: reduce) {
	.board-list__delete {
		transition: none;
	}
}
`;

function ensureStyles(): void {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = CSS;
	document.head.appendChild(style);
}

/**
 * Ask the server to delete one message.
 *
 * The response is interpreted into an outcome rather than returned raw, so
 * the caller — which owns the list DOM — never has to read a status code or
 * decide what a 403 means.
 */
async function requestDelete(id: string): Promise<DeleteOutcome> {
	let response: Response;
	try {
		response = await fetch('/api/admin/board', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id, status: 'deleted' }),
		});
	} catch {
		return { kind: 'failed' };
	}

	if (response.ok) return { kind: 'deleted' };
	// 401/403: the session expired or was revoked under us. Worth saying
	// plainly, because retrying will never succeed.
	if (response.status === 401 || response.status === 403) return { kind: 'unauthorised' };
	if (response.status === 404) return { kind: 'gone' };
	return { kind: 'failed' };
}

/**
 * Attach a Delete control to a row.
 *
 * Default export on purpose: the call site in board.ts is the only other
 * place this module is named, and `mod.default` tells a reader of that
 * bundle nothing about what is behind it.
 */
export default function attachDeleteButton(
	row: HTMLElement,
	id: string,
	onOutcome: (outcome: DeleteOutcome, id: string) => void,
): void {
	ensureStyles();

	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'board-list__delete mono';
	button.dataset.deleteFor = id;
	button.setAttribute('aria-label', 'Delete this message');
	button.textContent = 'Delete';

	// Own the busy state so a double-click cannot fire two requests; the
	// control is restored before the callback, because every outcome except
	// a real delete leaves something for the admin to read.
	let busy = false;
	button.addEventListener('click', (event) => {
		event.preventDefault();
		if (busy) return;
		busy = true;
		button.disabled = true;
		button.textContent = '…';
		void requestDelete(id).then((outcome) => {
			busy = false;
			button.disabled = false;
			button.textContent = 'Delete';
			onOutcome(outcome, id);
		});
	});

	row.appendChild(button);
}
