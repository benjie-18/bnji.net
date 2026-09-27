/**
 * BNJI.NET — admin dashboard client runtime.
 *
 * Holds the operator's access token in a module-scoped variable for the
 * lifetime of the page and sends it as a Bearer header on every admin API
 * call. It is never written to localStorage, sessionStorage, the DOM, or a
 * cookie: a token readable by any script on the page is a token that any XSS
 * can exfiltrate, and this page renders strings that came from a database.
 *
 * NO TOKEN IS RETAINED. The login form sends the token once, to
 * /api/admin/session, which answers with an HttpOnly session cookie. From
 * then on the cookie alone authenticates both the page (via the middleware)
 * and the data (via /api/admin/*). That is deliberate: a token held in a
 * module variable for the life of a page that renders attacker-influenceable
 * database content is a token one XSS away from being exfiltrated. Keeping
 * it in memory bought nothing — the cookie was already doing the work.
 *
 * adminFetch still ACCEPTS a bearer token, because curl and scripts need one
 * and it costs nothing to support.
 *
 * Everything rendered here is textContent. The board shows visitor-authored
 * message bodies and the security log shows user-agent strings, referrers
 * and device fingerprints — all attacker-influenceable. None of it is ever
 * interpolated as HTML.
 */

/** One in-flight refresh so several panels don't each fire their own first load. */
let inflight: Promise<unknown> | null = null;

/**
 * Fetch JSON from an admin endpoint with the credential attached.
 *
 * A 401 is surfaced as a thrown error carrying `status`, so callers can
 * distinguish "your session expired" from "the query failed" instead of
 * rendering an empty table and letting the operator think the data is gone.
 */
export async function adminFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
	const headers = new Headers(init.headers);
	headers.set('accept', 'application/json');
	if (init.body && !headers.has('content-type')) {
		headers.set('content-type', 'application/json');
	}
	const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });

	if (response.status === 401) {
		const error = new Error('unauthorized') as Error & { status: number };
		error.status = 401;
		throw error;
	}
	if (!response.ok) {
		const error = new Error(`admin request failed: ${response.status}`) as Error & { status: number };
		error.status = response.status;
		throw error;
	}
	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

/* --- login form ---------------------------------------------------------- */

export function startAdminLogin(): void {
	const form = document.querySelector<HTMLFormElement>('[data-admin-login]');
	if (!form) return;

	const input = form.querySelector<HTMLInputElement>('[data-admin-token]');
	const submit = form.querySelector<HTMLButtonElement>('[data-admin-submit]');
	const status = form.querySelector<HTMLElement>('[data-admin-login-status]');
	if (!input || !submit || !status) return;

	const say = (text: string, isError: boolean): void => {
		status.textContent = text;
		status.hidden = false;
		status.classList.toggle('is-error', isError);
	};

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		const token = input.value.trim();
		// 4, not 8: the seeded token is five characters, so a stricter client
		// check would refuse to submit a perfectly valid credential and lock
		// the owner out of their own site. This mirrors
		// MIN_LOGIN_TOKEN_LENGTH in src/server/admin.ts — the client check is
		// a fast-fail for typos, never the authority on length. New tokens
		// chosen in Settings are held to 8 by the server.
		if (token.length < 4) {
			say('That token looks too short.', true);
			return;
		}

		submit.disabled = true;
		say('Checking…', false);
		try {
			await adminFetch<{ ok: boolean }>('/api/admin/session', {
				method: 'POST',
				body: JSON.stringify({ token }),
			});
			// The session cookie is set. The token is dropped on the floor
			// here: the cookie authenticates the dashboard page AND its API
			// calls, so nothing needs to keep holding the secret.
			window.location.assign('/admin');
		} catch (error) {
			const status_ = (error as { status?: number }).status;
			if (status_ === 429) {
				say('Too many attempts. Wait a few minutes and try again.', true);
			} else if (status_ === 503) {
				say('The admin surface is not configured on this deployment.', true);
			} else {
				// One message for every wrong-token case: length, content and
				// "nearly right" are not distinguishable from here.
				say('That token was not accepted.', true);
			}
			input.select();
		} finally {
			submit.disabled = false;
		}
	});

	input.focus();
}

/* --- shared formatting ---------------------------------------------------- */

export function formatTime(epochMs: number | undefined): string {
	if (!epochMs) return '—';
	return new Date(epochMs).toLocaleString();
}

export function formatBytes(bytes: number | undefined): string {
	if (!bytes && bytes !== 0) return '—';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Render a value into a cell as text, never as markup. */
export function cell(value: unknown): string {
	if (value === undefined || value === null || value === '') return '—';
	if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
	if (typeof value === 'boolean') return value ? 'yes' : 'no';
	return String(value);
}

/**
 * Replace a container's children with a plain table.
 *
 * Building the table through the DOM (rather than assigning innerHTML) is
 * what makes the admin view safe against a visitor who posted `<img onerror>`
 * as a message body.
 */
export function renderTable(
	container: HTMLElement,
	columns: { label: string; get: (row: Record<string, unknown>) => unknown; mono?: boolean }[],
	rows: Record<string, unknown>[],
	emptyMessage = 'Nothing to show.',
): void {
	container.textContent = '';

	if (rows.length === 0) {
		const p = document.createElement('p');
		p.className = 'admin__empty';
		p.textContent = emptyMessage;
		container.appendChild(p);
		return;
	}

	const table = document.createElement('table');
	table.className = 'admin__table';

	const thead = document.createElement('thead');
	const headRow = document.createElement('tr');
	for (const column of columns) {
		const th = document.createElement('th');
		th.textContent = column.label;
		headRow.appendChild(th);
	}
	thead.appendChild(headRow);
	table.appendChild(thead);

	const tbody = document.createElement('tbody');
	for (const row of rows) {
		const tr = document.createElement('tr');
		for (const column of columns) {
			const td = document.createElement('td');
			td.textContent = cell(column.get(row));
			if (column.mono) td.classList.add('is-mono');
			tr.appendChild(td);
		}
		tbody.appendChild(tr);
	}
	table.appendChild(tbody);
	container.appendChild(table);
}

/** Render a definition-style key/value grid. */
export function renderFacts(container: HTMLElement, facts: [string, unknown][]): void {
	container.textContent = '';
	const dl = document.createElement('dl');
	dl.className = 'admin__facts';
	for (const [key, value] of facts) {
		const dt = document.createElement('dt');
		dt.textContent = key;
		const dd = document.createElement('dd');
		dd.textContent = cell(value);
		// dt+dd share one wrapper (valid in <dl>) so each figure is one plate.
		const fact = document.createElement('div');
		fact.className = 'admin__fact';
		fact.appendChild(dt);
		fact.appendChild(dd);
		dl.appendChild(fact);
	}
	container.appendChild(dl);
}

/**
 * Share one in-flight load across callers.
 *
 * Returns the existing promise when a load is already running, so a tab
 * switch that fires three panel loads produces one request, not three. The
 * slot clears when the load settles, so it never serves a stale result to a
 * later caller.
 */
export function coalesce<T>(factory: () => Promise<T>): Promise<T> {
	if (inflight) return inflight as Promise<T>;
	inflight = factory().finally(() => {
		inflight = null;
	});
	return inflight as Promise<T>;
}
