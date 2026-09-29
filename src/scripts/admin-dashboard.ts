/**
 * BNJI.NET — admin dashboard behaviour.
 *
 * Five tabs over five endpoints:
 *   /api/admin/config    every public config value + binding/secret presence
 *   /api/admin/security  the security_events log, filterable
 *   /api/admin/board     messages with moderation state + moderation actions
 *   /api/admin/playlist  the music queue: list, add, reorder, remove
 *
 * The page arrives with no data. The token is held in memory by admin.ts and
 * attached to each call; the session cookie rides along automatically. A 401
 * on any call means the session is gone, so the dashboard returns to the
 * login page rather than showing stale, silently-wrong empty tables.
 *
 * Everything is rendered with textContent. The board shows visitor-authored
 * message bodies and the security log shows user-agent strings and referrers
 * — both attacker-influenceable, neither ever treated as markup.
 */
import { adminFetch, coalesce, formatTime, renderFacts, renderTable } from './admin';
import { startAdminPlaylist } from './admin-playlist';

type TabName = 'stats' | 'overview' | 'board' | 'playlist' | 'security' | 'settings' | 'config';

type PaintActivity = {
	id: number;
	createdAt: number;
	revision: number;
	visitorId: string;
	actions: Record<string, number>;
};

type SecurityEvent = {
	id: number;
	surface?: string;
	profileSlug?: string;
	endpoint: string;
	targetId?: string;
	ipAddress: string;
	userAgent?: string;
	cfCountry?: string;
	cfCity?: string;
	cfAsn?: string;
	fingerprint?: string;
	deviceFingerprint?: string;
	sessionKey?: string;
	createdAt: number;
	geoLatitude?: number;
	geoLongitude?: number;
	referrer?: string;
	screenWidth?: number;
	screenHeight?: number;
	screenPixelRatio?: number;
	hardwareConcurrency?: number;
	deviceMemory?: number;
	platform?: string;
	timezone?: string;
	language?: string;
	webglRenderer?: string;
	touchSupport?: boolean;
};

type ModeratedMessage = {
	id: string;
	text: string;
	image?: string;
	hue: number;
	status: string;
	createdAt: number;
	reportCount: number;
	reportedAt?: number;
	statusNote?: string;
	moderatedAt?: number;
};

const MESSAGE_STATUSES = ['visible', 'hidden', 'reported', 'deleted'] as const;

/**
 * Read the trimmed value of a filter control.
 *
 * Typed loosely on purpose: this DOM lib declares HTMLSelectElement#remove()
 * as returning void, which makes HTMLSelectElement structurally
 * incompatible with Element, so querySelector<HTMLSelectElement> does not
 * typecheck. Routing every filter read through one accessor keeps that quirk
 * in a single place instead of scattered casts.
 */
function valueOf(root: HTMLElement, selector: string): string {
	const el = root.querySelector(selector) as { value?: string } | null;
	return (el?.value ?? '').trim();
}

export function startAdminDashboard(): void {
	const rootEl = document.querySelector<HTMLElement>('[data-admin]');
	if (!rootEl) return;
	// Re-bind through the guard: the loader functions below are closures over
	// this name, and control-flow narrowing does not reach into them.
	const root: HTMLElement = rootEl;

	const statusEl = root.querySelector<HTMLElement>('[data-admin-status]');
	const errorEl = root.querySelector<HTMLElement>('[data-admin-error]');
	const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-tab]'));
	const panels = Array.from(root.querySelectorAll<HTMLElement>('[data-panel]'));

	const say = (text: string): void => {
		if (statusEl) statusEl.textContent = text;
	};

	const fail = (message: string): void => {
		if (!errorEl) return;
		errorEl.textContent = message;
		errorEl.hidden = false;
	};

	const clearError = (): void => {
		if (errorEl) errorEl.hidden = true;
	};

	/** Every API call funnels through here so a 401 is handled once. */
	const guard = async <T,>(run: () => Promise<T>): Promise<T | null> => {
		try {
			const result = await run();
			clearError();
			return result;
		} catch (error) {
			const status = (error as { status?: number }).status;
			if (status === 401) {
				window.location.assign('/admin/login');
				return null;
			}
			fail(
				status === 503
					? 'Storage is unavailable on this deployment.'
					: `That request failed (${status ?? 'network'}).`,
			);
			return null;
		}
	};

	/* --- tabs --------------------------------------------------------------- */

	let active: TabName = 'stats';

	/* Sling indicator: one glass capsule that travels between tab labels.
	   Its four edges are separate custom properties; the edge on the side
	   of travel moves on the fast leg and the trailing edge follows on the
	   slow, springy leg, so the capsule stretches toward the target and
	   snaps back around it. All timing comes from motion tokens (collapsed
	   by prefers-reduced-motion) and the Settings store's data-* flags
	   (reduced effects / performance mode), so nothing here hard-codes a
	   duration. */
	const tabList = root.querySelector<HTMLElement>('[data-admin-tabs]');
	const indicator = root.querySelector<HTMLElement>('[data-tab-indicator]');
	let indicatorLeft = -1;

	const placeIndicator = (instant = false): void => {
		if (!tabList || !indicator) return;
		const current = tabs.find((tab) => tab.dataset.tab === active);
		if (!current) return;
		const listBox = tabList.getBoundingClientRect();
		const box = current.getBoundingClientRect();
		const left = box.left - listBox.left;
		const top = box.top - listBox.top;
		const right = listBox.width - (left + box.width);
		const bottom = listBox.height - (top + box.height);

		const forward = indicatorLeft < 0 || left >= indicatorLeft;
		indicator.dataset.direction = forward ? 'forward' : 'back';
		if (instant || indicatorLeft < 0) indicator.dataset.instant = '';
		else delete indicator.dataset.instant;

		indicator.style.setProperty('--tab-l', `${left}px`);
		indicator.style.setProperty('--tab-r', `${right}px`);
		indicator.style.setProperty('--tab-t', `${top}px`);
		indicator.style.setProperty('--tab-b', `${bottom}px`);
		indicator.dataset.ready = '';
		indicatorLeft = left;
		if (indicator.dataset.instant !== undefined) {
			// Re-enable transitions after the instant placement has painted.
			requestAnimationFrame(() => requestAnimationFrame(() => delete indicator.dataset.instant));
		}
	};

	if (tabList && typeof ResizeObserver !== 'undefined') {
		// Wrapping on narrow screens / UI-scale changes moves the labels.
		new ResizeObserver(() => placeIndicator(true)).observe(tabList);
	}
	window.addEventListener('bnji:settingschange', () => placeIndicator(true));

	const show = (name: TabName): void => {
		active = name;
		for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
		for (const panel of panels) panel.hidden = panel.dataset.panel !== name;
		placeIndicator();
	};
	placeIndicator(true);

	for (const tab of tabs) {
		tab.addEventListener('click', () => {
			show(tab.dataset.tab as TabName);
			void refresh();
		});
	}

	/* --- overview ----------------------------------------------------------- */

	async function loadOverview(): Promise<void> {
		const [security, board, config] = await Promise.all([
			guard(() =>
				adminFetch<{ total: number; summary: Record<string, unknown> }>('/api/admin/security?limit=1&summary=1'),
			),
			guard(() => adminFetch<{ summary: Record<string, unknown> }>('/api/admin/board?limit=1')),
			guard(() => adminFetch<Record<string, unknown>>('/api/admin/config')),
		]);
		if (active !== 'overview') return;

		const secSummary = (security?.summary ?? {}) as Record<string, unknown>;
		renderFacts(root.querySelector<HTMLElement>('[data-overview-security]')!, [
			['Total events', secSummary.total],
			['Last 24h', secSummary.last24h],
			['Distinct IPs', secSummary.uniqueIps],
			['Distinct devices', secSummary.uniqueDevices],
			['With device data', secSummary.enriched],
			['Retention', `${security?.summary ? String((secSummary.retentionDays ?? '—')) : '—'} days`],
		]);

		const boardSummary = (board?.summary ?? {}) as { byStatus?: { status: string; count: number }[] };
		const byStatus = new Map((boardSummary.byStatus ?? []).map((s) => [s.status, s.count]));
		renderFacts(root.querySelector<HTMLElement>('[data-overview-board]')!, [
			['Total messages', (board?.summary as Record<string, unknown> | undefined)?.total],
			['Posted (24h)', (board?.summary as Record<string, unknown> | undefined)?.postedLast24h],
			['Reported (24h)', (board?.summary as Record<string, unknown> | undefined)?.reportedLast24h],
			['Visible', byStatus.get('visible')],
			['Reported', byStatus.get('reported')],
			['Hidden', byStatus.get('hidden')],
			['Deleted', byStatus.get('deleted')],
		]);

		const env = (config?.environment ?? {}) as {
			bindings?: Record<string, boolean>;
			secrets?: Record<string, boolean>;
			adminUsable?: boolean;
		};
		const bindingRows = Object.entries(env.bindings ?? {}).map(
			([name, present]) => [name, present ? 'present' : 'missing'] as [string, unknown],
		);
		const secretRows = Object.entries(env.secrets ?? {}).map(
			([name, present]) => [name, present ? 'set' : 'not set'] as [string, unknown],
		);
		renderFacts(root.querySelector<HTMLElement>('[data-overview-env]')!, [
			...bindingRows,
			...secretRows,
		]);
	}

	/* --- security log ------------------------------------------------------- */

	async function loadSecurity(): Promise<void> {
		const params = new URLSearchParams();
		const surface = valueOf(root, '[data-filter-surface]');
		const path = root.querySelector<HTMLInputElement>('[data-filter-path]')?.value.trim();
		const ip = root.querySelector<HTMLInputElement>('[data-filter-ip]')?.value.trim();
		const device = root.querySelector<HTMLInputElement>('[data-filter-device]')?.value.trim();
		const enriched = root.querySelector<HTMLInputElement>('[data-filter-enriched]')?.checked;
		const limit = root.querySelector<HTMLInputElement>('[data-filter-limit]')?.value;

		if (surface) params.set('surface', surface);
		if (path) params.set('profileSlug', path);
		if (ip) params.set('ip', ip);
		if (device) params.set('device', device);
		if (enriched) params.set('enrichedOnly', '1');
		if (limit) params.set('limit', limit);

		const data = await guard(() => adminFetch<{ events: SecurityEvent[]; total: number }>(`/api/admin/security?${params}`));
		if (!data || active !== 'security') return;

		say(`${data.events.length} shown · ${data.total} security events match`);

		renderTable(
			root.querySelector<HTMLElement>('[data-security-table]')!,
			[
				{ label: 'When', get: (r) => formatTime(Number(r.createdAt)), mono: true },
				{ label: 'Surface', get: (r) => r.surface, mono: true },
				{ label: 'Endpoint', get: (r) => r.endpoint, mono: true },
				{ label: 'Profile', get: (r) => r.profileSlug, mono: true },
				{ label: 'Target', get: (r) => r.targetId, mono: true },
				{ label: 'IP', get: (r) => r.ipAddress, mono: true },
				{ label: 'Location', get: (r) => [r.cfCountry, r.cfCity].filter(Boolean).join(' / ') },
				{
					label: 'Geo',
					get: (r) =>
						typeof r.geoLatitude === 'number' && typeof r.geoLongitude === 'number'
							? `${r.geoLatitude.toFixed(3)}, ${r.geoLongitude.toFixed(3)}`
							: undefined,
					mono: true,
				},
				{ label: 'Device', get: (r) => r.deviceFingerprint, mono: true },
				{
					label: 'Screen',
					get: (r) =>
						typeof r.screenWidth === 'number' ? `${r.screenWidth}x${r.screenHeight} @${r.screenPixelRatio ?? '?'}x` : undefined,
					mono: true,
				},
				{
					label: 'Hardware',
					get: (r) =>
						[
							typeof r.hardwareConcurrency === 'number' ? `${r.hardwareConcurrency}c` : undefined,
							typeof r.deviceMemory === 'number' ? `${r.deviceMemory}GB` : undefined,
						]
							.filter(Boolean)
							.join(' ') || undefined,
					mono: true,
				},
				{ label: 'Platform', get: (r) => [r.platform, r.timezone].filter(Boolean).join(' / ') },
				{ label: 'GPU', get: (r) => r.webglRenderer },
				{ label: 'UA', get: (r) => r.userAgent },
				{ label: 'Referrer', get: (r) => r.referrer },
			],
			data.events as unknown as Record<string, unknown>[],
			'No security events match these filters.',
		);
	}

	/* --- board moderation --------------------------------------------------- */

	async function moderate(id: string, status: string, note: string | undefined): Promise<void> {
		const result = await guard(() =>
			adminFetch<{ ok: boolean }>('/api/admin/board', {
				method: 'POST',
				body: JSON.stringify({ id, status, ...(note ? { note } : {}) }),
			}),
		);
		if (result) {
			say(`Message ${id} → ${status}`);
			await loadBoard();
		}
	}

	async function loadBoard(): Promise<void> {
		const params = new URLSearchParams();
		const status = valueOf(root, '[data-board-status]');
		const minReports = root.querySelector<HTMLInputElement>('[data-board-min-reports]')?.value;
		const search = root.querySelector<HTMLInputElement>('[data-board-search]')?.value.trim();
		if (status) params.set('status', status);
		if (minReports && Number(minReports) > 0) params.set('minReports', minReports);
		if (search) params.set('search', search);
		params.set('limit', '50');

		const [data, paintActivity] = await Promise.all([
			guard(() =>
				adminFetch<{ messages: ModeratedMessage[]; summary: { total: number } }>(
					`/api/admin/board?${params}`,
				),
			),
			guard(() => adminFetch<{ events: PaintActivity[]; total: number; retentionDays: number }>('/api/admin/paint-activity?limit=50')),
		]);
		if (!data || active !== 'board') return;

		say(`${data.messages.length} shown · ${data.summary.total} total`);

		if (paintActivity) {
			renderTable(
				root.querySelector<HTMLElement>('[data-paint-activity]')!,
				[
					{ label: 'When', get: (r) => formatTime(Number(r.createdAt)), mono: true },
					{ label: 'Revision', get: (r) => r.revision, mono: true },
					{ label: 'Visitor/session (ephemeral)', get: (r) => r.visitorId, mono: true },
					{
						label: 'Published action counts',
						get: (r) => Object.entries(r.actions ?? {}).map(([type, count]) => `${type.replace(/-/g, ' ')} ×${count}`).join(', ') || '—',
					},
				],
				paintActivity.events as unknown as Record<string, unknown>[],
				'No accepted Paint publishes have been logged.',
			);
		}

		const container = root.querySelector<HTMLElement>('[data-board-table]')!;
		container.textContent = '';
		if (data.messages.length === 0) {
			const p = document.createElement('p');
			p.className = 'admin__empty';
			p.textContent = 'No messages match these filters.';
			container.appendChild(p);
			return;
		}

		const table = document.createElement('table');
		table.className = 'admin__table';
		const thead = document.createElement('thead');
		const headRow = document.createElement('tr');
		for (const label of ['When', 'Message', 'Status', 'Reports', 'Note', 'Moderate']) {
			const th = document.createElement('th');
			th.textContent = label;
			headRow.appendChild(th);
		}
		thead.appendChild(headRow);
		table.appendChild(thead);

		const tbody = document.createElement('tbody');
		for (const message of data.messages) {
			const tr = document.createElement('tr');

			const when = document.createElement('td');
			when.className = 'is-mono';
			when.textContent = formatTime(message.createdAt);
			tr.appendChild(when);

			// Message body: textContent, always. This is attacker-controlled.
			const body = document.createElement('td');
			body.textContent = message.text;
			if (message.image) {
				const img = document.createElement('img');
				img.src = message.image; // server-validated data: URL only
				img.alt = 'Image attached to this message';
				img.loading = 'lazy';
				img.style.maxWidth = '4rem';
				img.style.display = 'block';
				img.style.marginTop = '0.3rem';
				body.appendChild(img);
			}
			tr.appendChild(body);

			const statusCell = document.createElement('td');
			const badge = document.createElement('span');
			const s = message.status;
			badge.className = `admin__badge admin__badge--${s}`;
			const icon = s === 'visible' ? '🟢' : s === 'reported' ? '🟡' : s === 'hidden' ? '🟠' : '🔴';
			badge.textContent = `${icon} ${s}`;
			statusCell.appendChild(badge);
			tr.appendChild(statusCell);

			const reports = document.createElement('td');
			reports.className = 'is-mono';
			reports.textContent = String(message.reportCount);
			if (message.reportedAt) {
				const sub = document.createElement('div');
				sub.style.opacity = '0.7';
				sub.textContent = formatTime(message.reportedAt);
				reports.appendChild(sub);
			}
			tr.appendChild(reports);

			const note = document.createElement('td');
			const input = document.createElement('input');
			input.className = 'admin__note';
			input.type = 'text';
			input.value = message.statusNote ?? '';
			input.placeholder = 'reason…';
			input.setAttribute('aria-label', `Moderator note for message ${message.id}`);
			note.appendChild(input);
			tr.appendChild(note);

			const actions = document.createElement('td');
			const group = document.createElement('div');
			group.className = 'admin__actions';
			for (const next of MESSAGE_STATUSES) {
				const button = document.createElement('button');
				button.type = 'button';
				// Same capsule as every other button on the site (glass.css).
				button.className = 'glass-button glass-button--sm admin__action';
				button.textContent = next;
				if (next === message.status) {
					button.disabled = true;
					button.setAttribute('aria-current', 'true');
				}
				button.addEventListener('click', () => {
					void moderate(message.id, next, input.value.trim() || undefined);
				});
				group.appendChild(button);
			}
			actions.appendChild(group);
			tr.appendChild(actions);

			tbody.appendChild(tr);
		}
		table.appendChild(tbody);
		container.appendChild(table);
	}

	/* --- configuration ------------------------------------------------------ */

	async function loadConfig(): Promise<void> {
		const data = await guard(() => adminFetch<{
			groups?: unknown[];
			retention?: Record<string, unknown>;
			dynamicSettings?: Record<string, unknown>;
		}>('/api/admin/config'));
		if (!data || active !== 'config') return;

		// Populate dynamic settings form inputs
		if (data.dynamicSettings) {
			const form = root.querySelector<HTMLFormElement>('[data-site-settings-form]');
			if (form) {
				const ds = data.dynamicSettings;
				for (const [key, val] of Object.entries(ds)) {
					const input = form.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-setting-input="${key}"]`);
					if (input) {
						if (input.type === 'checkbox') {
							(input as HTMLInputElement).checked = Boolean(val);
						} else {
							input.value = String(val ?? '');
						}
					}
				}
			}
		}

		const container = root.querySelector<HTMLElement>('[data-config-groups]')!;
		container.textContent = '';

		const groups = (data.groups ?? []) as {
			id: string;
			source: string;
			summary: string;
			values: Record<string, unknown>;
		}[];

		for (const group of groups) {
			const section = document.createElement('section');
			section.className = 'admin__config-group';

			const h3 = document.createElement('h3');
			h3.textContent = group.id;
			section.appendChild(h3);

			const source = document.createElement('p');
			source.className = 'admin__config-source';
			source.textContent = group.source;
			section.appendChild(source);

			const summary = document.createElement('p');
			summary.className = 'admin__config-summary';
			summary.textContent = group.summary;
			section.appendChild(summary);

			const dl = document.createElement('dl');
			dl.className = 'admin__facts';
			for (const [key, value] of Object.entries(group.values)) {
				const dt = document.createElement('dt');
				dt.textContent = key;
				const dd = document.createElement('dd');
				dd.textContent = Array.isArray(value)
					? value.length
						? value.join(', ')
						: '—'
					: typeof value === 'object' && value !== null
						? JSON.stringify(value)
						: String(value);
				// dt+dd share one wrapper (valid in <dl>) so each figure is one plate.
				const fact = document.createElement('div');
				fact.className = 'admin__fact';
				fact.appendChild(dt);
				fact.appendChild(dd);
				dl.appendChild(fact);
			}
			section.appendChild(dl);
			container.appendChild(section);
		}

		const retention = (data.retention ?? {}) as Record<string, unknown>;
		const section = document.createElement('section');
		section.className = 'admin__config-group';
		const h3 = document.createElement('h3');
		h3.textContent = 'retention';
		section.appendChild(h3);
		const source = document.createElement('p');
		source.className = 'admin__config-source';
		source.textContent = 'src/server/security-store.ts · src/server/board-store.ts';
		section.appendChild(source);
		const dl = document.createElement('dl');
		dl.className = 'admin__facts';
		for (const [key, value] of Object.entries(retention)) {
			const dt = document.createElement('dt');
			dt.textContent = key;
			const dd = document.createElement('dd');
			dd.textContent = String(value);
			// dt+dd share one wrapper (valid in <dl>) so each figure is one plate.
			const fact = document.createElement('div');
			fact.className = 'admin__fact';
			fact.appendChild(dt);
			fact.appendChild(dd);
			dl.appendChild(fact);
		}
		section.appendChild(dl);
		container.appendChild(section);
	}

	/* --- statistics --------------------------------------------------------- */

	type StatsPayload = {
		generatedAt: number;
		credential: { tokenRotatedAt: number; everRotated: boolean };
		traffic: {
			note: string;
			siteTotal: number;
			profiles: { slug: string; name: string; total: number; today: number; week: number; month: number }[];
		};
		engagement: {
			profiles: {
				slug: string;
				reactionTotal: number;
				clickTotal: number;
				reactions: { reaction: string; count: number }[];
				linkClicks: { linkId: string; label: string; count: number }[];
			}[];
		};
		// Mirrors BoardSummary in src/server/board-store.ts, plus the reported
		// count derived in /api/admin/stats. These are the only board figures
		// the store actually aggregates — no row here is invented, which is
		// why there is no "recent posts" style total: that is not a query the
		// store runs, so the panel does not claim it.
		board: ({
			total: number;
			byStatus: { status: string; count: number }[];
			postedLast24h: number;
			reportedLast24h: number;
		} | null) & { reportedPending?: number; note?: string };
		security: ({
			total: number;
			last24h: number;
			uniqueIps: number;
			uniqueDevices: number;
			enriched: number;
			bySurface: { surface: string; count: number }[];
			byEndpoint: { surface: string; endpoint: string; count: number }[];
			retentionDays: number;
		} | null);
		timeSeries?: { label: string; timestamp: number; count: number }[];
	};

	function renderChart(
		svg: SVGElement,
		tooltip: HTMLElement,
		buckets: { label: string; timestamp: number; count: number }[],
	): void {
		svg.replaceChildren();
		if (!buckets || buckets.length === 0) return;

		const W = 800;
		const H = 240;
		const padX = 50;
		const padY = 30;
		const innerW = W - padX * 2;
		const innerH = H - padY * 2;

		const maxCount = Math.max(1, ...buckets.map((b) => b.count));
		const N = buckets.length;

		// Calculate coordinates
		const pts = buckets.map((b, i) => {
			const x = padX + (i / Math.max(1, N - 1)) * innerW;
			const y = padY + innerH - (b.count / maxCount) * innerH;
			return { x, y, ...b };
		});

		// Gradient definition
		const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
		const grad = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
		grad.id = 'chartGrad';
		grad.setAttribute('x1', '0');
		grad.setAttribute('y1', '0');
		grad.setAttribute('x2', '0');
		grad.setAttribute('y2', '1');

		const stop1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
		stop1.setAttribute('offset', '0%');
		stop1.setAttribute('stop-color', 'var(--accent)');
		stop1.setAttribute('stop-opacity', '0.45');

		const stop2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
		stop2.setAttribute('offset', '100%');
		stop2.setAttribute('stop-color', 'var(--accent)');
		stop2.setAttribute('stop-opacity', '0.02');

		grad.appendChild(stop1);
		grad.appendChild(stop2);
		defs.appendChild(grad);
		svg.appendChild(defs);

		// Grid lines
		const gridGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		for (let step = 0; step <= 4; step++) {
			const gy = padY + (step / 4) * innerH;
			const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
			line.setAttribute('x1', String(padX));
			line.setAttribute('y1', String(gy));
			line.setAttribute('x2', String(W - padX));
			line.setAttribute('y2', String(gy));
			line.setAttribute('stroke', 'var(--glass-border)');
			line.setAttribute('stroke-width', '1');
			line.setAttribute('stroke-dasharray', '4 4');
			gridGroup.appendChild(line);
		}
		svg.appendChild(gridGroup);

		// Generate smooth organic cubic Bezier curve commands
		const bottomY = padY + innerH;
		let lineD = `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;

		if (N === 1) {
			lineD += ` L ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
		} else {
			for (let i = 0; i < N - 1; i++) {
				const p0 = pts[Math.max(0, i - 1)];
				const p1 = pts[i];
				const p2 = pts[i + 1];
				const p3 = pts[Math.min(N - 1, i + 2)];

				const cp1x = p1.x + (p2.x - p0.x) / 6;
				const cp1y = p1.y + (p2.y - p0.y) / 6;
				const cp2x = p2.x - (p3.x - p1.x) / 6;
				const cp2y = p2.y - (p3.y - p1.y) / 6;

				lineD += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
			}
		}

		const areaD = `M ${pts[0].x.toFixed(1)},${bottomY} L ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)} ` +
			lineD.slice(lineD.indexOf('C') > -1 ? lineD.indexOf('C') : lineD.indexOf('L')) +
			` L ${pts[pts.length - 1].x.toFixed(1)},${bottomY} Z`;

		const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		area.setAttribute('d', areaD);
		area.setAttribute('fill', 'url(#chartGrad)');
		svg.appendChild(area);

		const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		line.setAttribute('d', lineD);
		line.setAttribute('fill', 'none');
		line.setAttribute('stroke', 'var(--accent-strong)');
		line.setAttribute('stroke-width', '3');
		line.setAttribute('stroke-linecap', 'round');
		line.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(line);

		// Data Nodes & Axis labels
		const nodesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
		const stepSkip = Math.max(1, Math.floor(N / 7));

		pts.forEach((p, i) => {
			// Dot
			const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
			circle.setAttribute('cx', String(p.x));
			circle.setAttribute('cy', String(p.y));
			circle.setAttribute('r', '4');
			circle.setAttribute('fill', 'var(--accent-strong)');
			circle.setAttribute('stroke', 'var(--bg)');
			circle.setAttribute('stroke-width', '2');
			nodesGroup.appendChild(circle);

			// Axis text
			if (i % stepSkip === 0 || i === N - 1) {
				const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
				text.setAttribute('x', String(p.x));
				text.setAttribute('y', String(H - 8));
				text.setAttribute('text-anchor', 'middle');
				text.setAttribute('fill', 'var(--text-dim)');
				text.setAttribute('font-size', '11');
				text.setAttribute('font-family', 'var(--font-mono)');
				text.textContent = p.label;
				nodesGroup.appendChild(text);
			}
		});
		svg.appendChild(nodesGroup);

		// Hover interaction
		const container = svg.parentElement;
		if (container) {
			container.onpointermove = (e) => {
				const rect = container.getBoundingClientRect();
				const relX = (e.clientX - rect.left) / rect.width;
				const idx = Math.min(N - 1, Math.max(0, Math.round(relX * (N - 1))));
				const pt = pts[idx];

				if (pt) {
					tooltip.textContent = `${pt.label}: ${pt.count} view${pt.count === 1 ? '' : 's'}`;
					tooltip.style.left = `${(pt.x / W) * 100}%`;
					tooltip.style.top = `${(pt.y / H) * 100}%`;
					tooltip.hidden = false;
				}
			};

			container.onpointerleave = () => {
				tooltip.hidden = true;
			};
		}
	}

	/**
	 * Render a group of stat rows, or a plain explanation when the group has
	 * no data behind it.
	 *
	 * The "no data" branch matters: a dashboard that prints a confident 0 for
	 * something the store never recorded is indistinguishable from a real
	 * zero, and the reader cannot tell which one they are looking at. Every
	 * zero printed here came out of a COUNT.
	 */
	const renderStatGroup = (
		selector: string,
		rows: [string, unknown][],
		empty: string,
	): void => {
		const el = root.querySelector<HTMLElement>(selector);
		if (!el) return;
		el.textContent = '';
		const present = rows.filter(([, v]) => v !== undefined && v !== null);
		if (present.length === 0) {
			const p = document.createElement('p');
			p.className = 'admin__hint';
			p.textContent = empty;
			el.appendChild(p);
			return;
		}
		renderFacts(el, rows);
	};

	/** A per-source sub-heading, so every figure is visibly attributable. */
	const renderSourceList = (
		selector: string,
		items: { title: string; rows: [string, unknown][] }[],
		empty: string,
	): void => {
		const el = root.querySelector<HTMLElement>(selector);
		if (!el) return;
		el.textContent = '';
		if (items.length === 0) {
			const p = document.createElement('p');
			p.className = 'admin__hint';
			p.textContent = empty;
			el.appendChild(p);
			return;
		}
		for (const item of items) {
			const wrap = document.createElement('div');
			wrap.className = 'admin__config-group';
			const h3 = document.createElement('h3');
			h3.textContent = item.title;
			wrap.appendChild(h3);
			const dl = document.createElement('dl');
			dl.className = 'admin__facts';
			for (const [key, value] of item.rows) {
				const dt = document.createElement('dt');
				dt.textContent = key;
				const dd = document.createElement('dd');
				dd.textContent = typeof value === 'number' ? value.toLocaleString() : String(value);
				// dt+dd share one wrapper (valid in <dl>) so each figure is one plate.
				const fact = document.createElement('div');
				fact.className = 'admin__fact';
				fact.appendChild(dt);
				fact.appendChild(dd);
				dl.appendChild(fact);
			}
			wrap.appendChild(dl);
			el.appendChild(wrap);
		}
	};

	function applyCredentialState(stats: StatsPayload['credential']): void {
		const el = root.querySelector<HTMLElement>('[data-token-state]');
		if (!el) return;
		el.textContent = stats.everRotated
			? `Token last changed ${formatTime(stats.tokenRotatedAt)}. It is stored as a SHA-256 hash and cannot be read back.`
			: 'This deployment is still using the seeded token from the install. Change it now — only its hash is stored, so nobody can read the current value back.';
	}

	async function loadStats(): Promise<void> {
		const scope = valueOf(root, '[data-stats-scope]') || 'global';
		const timeRange = valueOf(root, '[data-stats-time-range]') || 'day';

		const data = await guard(() => adminFetch<StatsPayload>(`/api/admin/stats?scope=${encodeURIComponent(scope)}&timeRange=${encodeURIComponent(timeRange)}`));
		if (!data || active !== 'stats') return;

		say(`Updated ${formatTime(data.generatedAt)}`);

		// Render interactive SVG Chart
		const svgEl = root.querySelector<SVGElement>('[data-stats-chart-svg]');
		const tooltipEl = root.querySelector<HTMLElement>('[data-stats-chart-tooltip]');
		const chartTotalEl = root.querySelector<HTMLElement>('[data-stats-chart-total]');
		const chartTitleEl = root.querySelector<HTMLElement>('[data-stats-chart-title]');

		if (data.timeSeries && svgEl && tooltipEl) {
			renderChart(svgEl, tooltipEl, data.timeSeries);
			const totalInSeries = data.timeSeries.reduce((s, b) => s + b.count, 0);
			if (chartTotalEl) chartTotalEl.textContent = `${totalInSeries} Views`;
			if (chartTitleEl) chartTitleEl.textContent = `${scope.toUpperCase()} VIEWS (${timeRange.toUpperCase()})`;
		}

		/* traffic — Global site traffic analytics */
		renderFacts(
			root.querySelector<HTMLElement>('[data-stats-traffic-overview]')!,
			[
				['Total Site Views', data.traffic.siteTotal],
				['Pages / Routes Tracked', data.traffic.profiles.length],
			],
		);

		const searchFilter = valueOf(root, '[data-stats-path-search]').toLowerCase();
		const minViewsFilter = Number(valueOf(root, '[data-stats-min-views]')) || 0;

		const filteredProfiles = data.traffic.profiles.filter((p) => {
			const matchesPath = !searchFilter || p.name.toLowerCase().includes(searchFilter) || p.slug.toLowerCase().includes(searchFilter);
			const matchesViews = p.total >= minViewsFilter;
			return matchesPath && matchesViews;
		});

		const totalSiteViews = Math.max(1, data.traffic.siteTotal);

		renderTable(
			root.querySelector<HTMLElement>('[data-stats-traffic-table]')!,
			[
				{ label: 'Page / Route', get: (r) => r.name, mono: true },
				{ label: 'Total Views', get: (r) => r.total, mono: true },
				{ label: 'Today', get: (r) => r.today, mono: true },
				{ label: 'This Week', get: (r) => r.week, mono: true },
				{ label: 'This Month', get: (r) => r.month, mono: true },
				{
					label: 'Traffic Share',
					get: (r) => `${(((Number(r.total) || 0) / totalSiteViews) * 100).toFixed(1)}%`,
					mono: true,
				},
			],
			filteredProfiles as unknown as Record<string, unknown>[],
			'No tracked pages match these filters.',
		);

		/* engagement — reactions and outbound link clicks */
		renderSourceList(
			'[data-stats-engagement]',
			data.engagement.profiles.flatMap((p) => [
				{
					title: `/${p.slug}/ reactions`,
					rows: [
						['Total', p.reactionTotal],
						...p.reactions.map((r) => [r.reaction, r.count] as [string, unknown]),
					],
				},
				{
					title: `/${p.slug}/ link clicks`,
					rows: [
						['Total', p.clickTotal],
						...p.linkClicks.map((c) => [c.label, c.count] as [string, unknown]),
					],
				},
			]),
			'No reactions or link clicks recorded yet.',
		);

		/* board */
		renderSourceList(
			'[data-stats-board]',
			data.board
				? [
						{
							title: 'All messages',
							rows: [
								['Stored', data.board.total],
								...data.board.byStatus.map((s) => [s.status, s.count] as [string, unknown]),
								['Reports awaiting action', data.board.reportedPending],
								['Posted (24h)', data.board.postedLast24h],
								['Reported (24h)', data.board.reportedLast24h],
							],
						},
					]
				: [],
			'Message board store unavailable.',
		);

		/* security */
		renderSourceList(
			'[data-stats-security]',
			data.security
				? [
						{
							title: 'All events',
							rows: [
								['Total', data.security.total],
								['Last 24h', data.security.last24h],
								['Distinct IPs', data.security.uniqueIps],
								['Distinct devices', data.security.uniqueDevices],
								['With device data', data.security.enriched],
								['Retention (days)', data.security.retentionDays],
							],
						},
						{
							title: 'By surface',
							rows: data.security.bySurface.map(
								(s) => [s.surface, s.count] as [string, unknown],
							),
						},
						{
							title: 'By endpoint',
							rows: data.security.byEndpoint.map(
								(e) => [`${e.surface} · ${e.endpoint}`, e.count] as [string, unknown],
							),
						},
					]
				: [],
			'Security store unavailable.',
		);

		applyCredentialState(data.credential);
	}

	/* --- settings: rotate the access token ---------------------------------- */

	function tokenError(message: string | null): void {
		const el = root.querySelector<HTMLElement>('[data-token-error]');
		if (!el) return;
		if (!message) {
			el.hidden = true;
			el.textContent = '';
			return;
		}
		el.textContent = message;
		el.hidden = false;
	}

	async function changeToken(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		tokenError(null);

		const form = root.querySelector<HTMLFormElement>('[data-token-form]');
		if (!form) return;

		const current = root.querySelector<HTMLInputElement>('[data-token-current]')?.value ?? '';
		const next = root.querySelector<HTMLInputElement>('[data-token-new]')?.value ?? '';
		const confirm = root.querySelector<HTMLInputElement>('[data-token-confirm]')?.value ?? '';
		const submit = root.querySelector<HTMLButtonElement>('[data-token-submit]');

		if (next.length < 8) {
			tokenError('The new token must be at least 8 characters.');
			return;
		}
		if (next !== confirm) {
			tokenError('The two new-token entries do not match.');
			return;
		}

		submit?.setAttribute('disabled', '');
		try {
			const result = await adminFetch<{ ok: boolean }>('/api/admin/session', {
				method: 'POST',
				body: JSON.stringify({ token: current, newToken: next }),
			});
			// The new token is correct and stored. Wipe every field so neither
			// the old nor the new value is left sitting in the DOM.
			form.reset();
			say('Token changed. Every previous session has been signed out.');
			if (active === 'settings') await loadStats();
		} catch (error) {
			const status = (error as { status?: number }).status;
			tokenError(
				status === 403
					? 'That is not the current token.'
					: status === 422
						? 'The new token must be at least 8 characters.'
						: status === 401
							? 'Your session expired. Sign in again.'
							: 'The token could not be changed. Try again.',
			);
		} finally {
			submit?.removeAttribute('disabled');
		}
	}

	/* --- wiring -------------------------------------------------------------- */

	const refresh = (): Promise<unknown> =>
		coalesce(async () => {
			if (active === 'stats') return loadStats();
			if (active === 'overview') return loadOverview();
			if (active === 'security') return loadSecurity();
			if (active === 'board') return loadBoard();
			if (active === 'playlist') return playlist.load();
			return loadConfig();
		});

	// The playlist panel owns its own forms; the dashboard only supplies the
	// shared status/error lines so every panel reports through one place, and
	// gets back the loader it needs when the tab is switched to.
	const playlist = startAdminPlaylist(root, { say, fail });

	root.querySelector('[data-admin-refresh]')?.addEventListener('click', () => {
		void refresh();
	});

	root.querySelector('[data-admin-logout]')?.addEventListener('click', () => {
		void adminFetch('/api/admin/session', { method: 'DELETE' }).finally(() => {
			window.location.assign('/admin/login');
		});
	});

	root.querySelector('[data-stats-filters]')?.addEventListener('submit', (event) => {
		event.preventDefault();
		void loadStats();
	});

	root.querySelector('[data-security-filters]')?.addEventListener('submit', (event) => {
		event.preventDefault();
		void loadSecurity();
	});

	root.querySelector('[data-board-filters]')?.addEventListener('submit', (event) => {
		event.preventDefault();
		void loadBoard();
	});

	root.querySelector('[data-token-form]')?.addEventListener('submit', (event) => {
		void changeToken(event as SubmitEvent);
	});

	root.querySelector('[data-site-settings-form]')?.addEventListener('submit', async (event) => {
		event.preventDefault();
		const form = event.target as HTMLFormElement;
		const errorEl = form.querySelector<HTMLElement>('[data-settings-save-error]');
		const statusEl = form.querySelector<HTMLElement>('[data-settings-save-status]');
		const btn = form.querySelector<HTMLButtonElement>('[data-settings-save-btn]');

		if (errorEl) errorEl.hidden = true;
		if (statusEl) statusEl.hidden = true;
		if (btn) btn.disabled = true;

		const payload: Record<string, unknown> = {};
		const formData = new FormData(form);

		// Handle explicit values
		for (const [key, val] of formData.entries()) {
			const input = form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${key}"]`);
			if (input && input.type === 'number') {
				payload[key] = Number(val);
			} else {
				payload[key] = val;
			}
		}

		// Handle checkboxes
		const checkboxes = Array.from(form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
		for (const cb of checkboxes) {
			if (cb.name) {
				payload[cb.name] = cb.checked;
			}
		}

		try {
			const res = await guard(() =>
				adminFetch<{ ok: boolean; dynamicSettings: Record<string, unknown> }>('/api/admin/config', {
					method: 'POST',
					body: JSON.stringify(payload),
				}),
			);

			if (res && res.ok) {
				if (statusEl) {
					statusEl.textContent = 'Configuration saved successfully! Changes are live across server routes.';
					statusEl.hidden = false;
				}
				say('Site configuration saved to D1.');
			} else if (errorEl) {
				errorEl.textContent = 'Failed to save configuration updates.';
				errorEl.hidden = false;
			}
		} catch {
			if (errorEl) {
				errorEl.textContent = 'Network or server error while saving configuration.';
				errorEl.hidden = false;
			}
		} finally {
			if (btn) btn.disabled = false;
		}
	});

	root.querySelector('[data-settings-reset-btn]')?.addEventListener('click', async () => {
		const form = root.querySelector<HTMLFormElement>('[data-site-settings-form]');
		if (!form) return;
		const statusEl = form.querySelector<HTMLElement>('[data-settings-save-status]');
		const errorEl = form.querySelector<HTMLElement>('[data-settings-save-error]');

		if (!confirm('Are you sure you want to reset all dynamic site settings back to default values?')) {
			return;
		}

		try {
			// Import defaults from store defaults
			const defaults = {
				boardProvider: 'd1',
				boardMaxTextLength: 250,
				boardPostCooldownSeconds: 20,
				boardHourlyPostLimit: 20,
				boardPollIntervalMs: 20000,
				boardMaxImageBytes: 1433600,
				dmProvider: 'none',
				dmMaxLength: 1000,
				dmCooldownSeconds: 30,
				siteName: 'BNJI',
				siteTitle: 'BNJI.NET — Personal Digital Hub',
				siteDescription: 'Personal digital hub.',
				authorName: 'BNJI',
				authorLocation: 'Global',
				defaultTheme: 'dark',
				introEnabled: true,
			};

			const res = await guard(() =>
				adminFetch<{ ok: boolean; dynamicSettings: Record<string, unknown> }>('/api/admin/config', {
					method: 'POST',
					body: JSON.stringify(defaults),
				}),
			);

			if (res && res.ok) {
				if (statusEl) {
					statusEl.textContent = 'Settings reset to system defaults!';
					statusEl.hidden = false;
				}
				await loadConfig();
			} else if (errorEl) {
				errorEl.textContent = 'Failed to reset configuration settings.';
				errorEl.hidden = false;
			}
		} catch {
			if (errorEl) {
				errorEl.textContent = 'Error resetting configuration.';
				errorEl.hidden = false;
			}
		}
	});

	// The session cookie is the only credential here, and it survives a page
	// load. Probe the API once on start: if it still works, render; if not,
	// guard() bounces to the login page.
	void guard(async () => {
		await adminFetch('/api/admin/config');
		clearError();
		await refresh();
	});
}
