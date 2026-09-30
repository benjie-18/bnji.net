/**
 * BNJI.NET — a just-big-enough DOM for the music player tests.
 *
 * WHY THIS EXISTS
 * ---------------
 * `scripts/music.ts` owns the only code that decides what a visitor hears, and
 * its interesting behaviour is exactly the part a pure-function test cannot
 * reach: switching from a file track to a YouTube video, stopping the previous
 * source cleanly, and hiding the controls a provider cannot support. There is no browser in this sandbox and the project forbids
 * new dependencies, so this module implements the small slice of the DOM that
 * module actually touches.
 *
 * THE RULE THAT KEEPS IT HONEST
 * ------------------------------
 * An unsupported selector THROWS. A shim that quietly matched nothing would
 * turn every assertion below into a pass, which is worse than no test at all —
 * so `querySelector`/`querySelectorAll` accept only the grammar listed in
 * `compileSelector` and refuse anything else.
 *
 * WHAT IS FAKED, AND WHAT IS NOT
 * ------------------------------
 * Real: the tree, attributes, events (including `signal`/`once` options),
 * `dataset`, `textContent`, `hidden`, `disabled`, `style`.
 * Faked: `Audio`, the YouTube IFrame API, timers and `requestAnimationFrame`
 * (a virtual clock, so a 4-second abort or a 1.6-second autoplay probe is
 * deterministic instead of slow), `localStorage`, `sessionStorage`, `fetch`.
 *
 * Everything is installed on `globalThis` by `installTestDom()` and removed by
 * `uninstall()`, because `music.ts` and `settings.ts` read these globals at
 * import time and at call time alike.
 */

/** Timers and frames, driven by the test rather than by the event loop. */
class VirtualClock {
	constructor() {
		this.now = 0;
		this.nextId = 1;
		this.timers = new Map();
		this.frames = new Map();
	}

	setTimeout(fn, ms = 0) {
		const id = this.nextId++;
		this.timers.set(id, { fn, at: this.now + Math.max(0, Number(ms) || 0) });
		return id;
	}

	clearTimeout(id) {
		this.timers.delete(id);
	}

	setInterval(fn, ms = 0) {
		// A timer entry with `interval !== undefined` re-arms itself after
		// firing, at its ORIGINAL schedule plus one period (the browser keeps
		// the period from first scheduling, so long overruns do not cascade).
		const id = this.nextId++;
		this.timers.set(id, { fn, at: this.now + Math.max(0, Number(ms) || 0), interval: Math.max(0, Number(ms) || 0) });
		return id;
	}

	clearInterval(id) {
		this.timers.delete(id);
	}

	/**
	 * How many timers are still scheduled. A teardown path that forgets a
	 * timer is invisible to every other assertion here, so the player tests
	 * count them directly: a pending timer is a callback that will still fire
	 * against a shell that no longer owns it.
	 */
	pending() {
		return this.timers.size;
	}

	requestAnimationFrame(fn) {
		const id = this.nextId++;
		this.frames.set(id, fn);
		return id;
	}

	cancelAnimationFrame(id) {
		this.frames.delete(id);
	}

	/** Run every timer due within `ms`, then every queued frame once. */
	advance(ms) {
		const target = this.now + ms;
		for (;;) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= target)
				.sort((a, b) => a[1].at - b[1].at);
			if (due.length === 0) break;
			const entry = due[0];
			if (!entry) break;
			const [id, timer] = entry;
			this.timers.delete(id);
			this.now = Math.max(this.now, timer.at);
			if (timer.interval !== undefined) this.timers.set(id, { ...timer, at: timer.at + timer.interval });
			timer.fn();
		}
		this.now = target;
		const pending = [...this.frames.values()];
		this.frames.clear();
		for (const frame of pending) frame(this.now);
	}
}

/** `musicTrackIndex` -> `data-music-track-index`, the way the DOM derives it. */
function attributeName(key) {
	return `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
}

/** One node. Deliberately not a spec-complete Element. */
class TestElement {
	constructor(tagName) {
		this.tagName = String(tagName).toUpperCase();
		this.childNodes = [];
		this.parentNode = null;
		this.attributes = new Map();
		this.style = { transform: '', setProperty: () => {} };
		// `dataset` IS the attribute map in a real DOM: writing
		// `dataset.musicTrackIndex` must produce `data-music-track-index`, or
		// every `[data-…]` query the player makes would silently match nothing.
		this.dataset = /** @type {Record<string, string>} */ (
			new Proxy(
				{},
				{
					get: (cache, key) =>
						typeof key === 'string' && key in cache
							? cache[key]
							: (this.getAttribute(attributeName(key)) ?? undefined),
					set: (cache, key, value) => {
						cache[key] = value;
						this.setAttribute(attributeName(key), value);
						return true;
					},
				},
			)
		);
		this.listeners = new Map();
		this._text = '';
		this.hidden = false;
		this.disabled = false;
		// A checkbox's own state, which the settings overlay binds to its store.
		this.checked = false;
		this.title = '';
		this.className = '';
		this.type = '';
		this.value = '';
		this.src = '';
		this.allow = '';
		this.async = false;
		this.loop = false;
		this.preload = '';
		this.volume = 1;
		this.muted = false;
		this.currentTime = 0;
		this.duration = Number.NaN;
		this.ended = false;
	}

	get textContent() {
		return this.childNodes.length === 0 ? this._text : this.childNodes.map((child) => child.textContent).join('');
	}

	set textContent(value) {
		this._text = String(value);
		// Assigning textContent replaces the children, which is how the panel
		// rebuilds its table: it clears the container and appends a new one.
		this.replaceChildren();
	}

	/** `HTMLFormElement.reset()` for the two inputs this suite uses. */
	reset() {
		const clear = (node) => {
			for (const child of node.childNodes) {
				if ('value' in child) child.value = '';
				clear(child);
			}
		};
		clear(this);
	}

	/**
	 * A live class list over `className`. The settings overlay toggles classes on
	 * `<html>` (`settings-is-open`) and on the gear (`is-spinning`), so a
	 * class-based assertion needs a real list rather than a set-once string.
	 * Reads and writes go through `className` so the existing `.class` selector
	 * grammar and any direct `className` assignment stay consistent.
	 */
	get classList() {
		const read = () => String(this.className).split(/\s+/).filter(Boolean);
		const write = (names) => {
			this.className = names.join(' ');
		};
		return {
			add: (...names) => {
				const current = read();
				for (const name of names) if (name && !current.includes(name)) current.push(name);
				write(current);
			},
			remove: (...names) => {
				write(read().filter((name) => !names.includes(name)));
			},
			toggle: (name, force) => {
				const next = force === undefined ? !read().includes(name) : Boolean(force);
				if (next) this.classList.add(name);
				else this.classList.remove(name);
				return next;
			},
			contains: (name) => read().includes(name),
		};
	}

	/** `Node.contains()` — the focus trap asks it about `document.activeElement`. */
	contains(node) {
		let current = node;
		while (current) {
			if (current === this) return true;
			current = current.parentNode;
		}
		return false;
	}

	/**
	 * `Element.closest()` — the lab games delegate their grid/canvas events and
	 * resolve the acted-on element with it. Like the real DOM it tests the
	 * node itself before climbing the ancestors; an unsupported selector throws.
	 */
	closest(selector) {
		const test = compileSelector(selector);
		let node = this;
		while (node) {
			if (test(node)) return node;
			node = node.parentNode;
		}
		return null;
	}

	/** Connected to the document tree, the way `isConnected` means it. */
	get isConnected() {
		let node = this;
		while (node.parentNode) node = node.parentNode;
		return node.tagName === 'HTML' || node.tagName === 'BODY';
	}

	/* --- tree --- */

	appendChild(child) {
		if (child.parentNode) child.parentNode.removeChild(child);
		child.parentNode = this;
		this.childNodes.push(child);
		return child;
	}

	removeChild(child) {
		const index = this.childNodes.indexOf(child);
		if (index >= 0) this.childNodes.splice(index, 1);
		child.parentNode = null;
		return child;
	}

	remove() {
		this.parentNode?.removeChild(this);
	}

	replaceChildren(...nodes) {
		for (const child of [...this.childNodes]) this.removeChild(child);
		for (const node of nodes) this.appendChild(node);
	}

	/* --- attributes --- */

	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}

	getAttribute(name) {
		return this.attributes.has(name) ? this.attributes.get(name) : null;
	}

	removeAttribute(name) {
		this.attributes.delete(name);
	}

	hasAttribute(name) {
		return this.attributes.has(name);
	}

	/* --- queries --- */

	querySelector(selector) {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	querySelectorAll(selector) {
		const test = compileSelector(selector);
		const out = [];
		const walk = (node) => {
			for (const child of node.childNodes) {
				if (test(child)) out.push(child);
				walk(child);
			}
		};
		walk(this);
		return out;
	}

	/* --- events --- */

	addEventListener(type, fn, options = {}) {
		if (!this.listeners.has(type)) this.listeners.set(type, []);
		this.listeners.get(type).push({ fn, signal: options.signal, once: options.once === true });
		// `{ signal }` is how music.ts tears its listeners down, so the shim has
		// to honour it or a destroyed player would keep reacting.
		options.signal?.addEventListener?.('abort', () => this.removeEventListener(type, fn), { once: true });
	}

	removeEventListener(type, fn) {
		const entries = this.listeners.get(type);
		if (!entries) return;
		const index = entries.findIndex((entry) => entry.fn === fn);
		if (index >= 0) entries.splice(index, 1);
	}

	dispatchEvent(event) {
		event.target = event.target ?? this;
		for (const entry of [...(this.listeners.get(event.type) ?? [])]) {
			if (entry.once) this.removeEventListener(event.type, entry.fn);
			entry.fn.call(this, event);
		}
		return true;
	}

	/* --- misc --- */

	getBoundingClientRect() {
		return { width: 320, height: 152, top: 0, left: 0, right: 320, bottom: 152 };
	}

	focus() {
		this.ownerDocument.__focus(this);
	}
}

/**
 * The selector grammar this shim supports: `tag`, `[attr]`, `[attr="value"]`,
 * `.class`, any combination concatenated, descendant combinators
 * (`[data-playlist-table] table tbody tr`), a `:not([attr="value"])` suffix
 * (`[tabindex]:not([tabindex="-1"])`), and comma-separated lists of any of the
 * above (`button, [href], input, select, textarea, ...`). Anything else throws,
 * by design.
 */
function compileSelector(selector) {
	const source = String(selector).trim();
	if (source.length === 0) throw new Error('tests/support/dom.mjs: empty selector');
	// A list is the union of its branches, which is what the overlay's focus
	// trap asks for. Commas inside `[attr="..."]` are not separators, so the
	// split is bracket-aware.
	const branches = splitSelectorList(source);
	if (branches.length > 1) {
		const tests = branches.map((branch) => compileSelector(branch));
		return (node) => tests.some((test) => test(node));
	}
	const parts = source.split(/\s+/).map(compileSimpleSelector);
	return (node) => {
		// Right to left: the last part must match the node itself, and every
		// earlier part must match some ancestor in order.
		const last = parts[parts.length - 1];
		if (!last(node)) return false;
		let index = parts.length - 2;
		let ancestor = node.parentNode;
		while (index >= 0 && ancestor) {
			const part = parts[index];
			if (part(ancestor)) index -= 1;
			ancestor = ancestor.parentNode;
		}
		return index < 0;
	};
}

/** Split on top-level commas, leaving any comma inside `[attr="..."]` alone. */
function splitSelectorList(source) {
	const branches = [];
	let depth = 0;
	let current = '';
	for (const char of source) {
		if (char === '[') depth += 1;
		else if (char === ']') depth = Math.max(0, depth - 1);
		if (char === ',' && depth === 0) {
			branches.push(current);
			current = '';
			continue;
		}
		current += char;
	}
	branches.push(current);
	return branches.map((branch) => branch.trim()).filter((branch) => branch.length > 0);
}

function compileSimpleSelector(source) {
	// `[tabindex]:not([tabindex="-1"])` - one optional negated suffix, which is
	// the only pseudo-class the overlay's focus trap needs. Stripping it here
	// keeps the rest inside the grammar below, so a selector this shim cannot
	// express still throws rather than quietly matching the wrong nodes.
	const negated = /^(.*):not\(([^)]*)\)$/.exec(source);
	if (negated) {
		const notThis = compileSimpleSelector(negated[2]);
		const butThis = compileSimpleSelector(negated[1]);
		return (node) => butThis(node) && !notThis(node);
	}
	if (!/^(?:[a-zA-Z][\w-]*)?(?:[.#][\w-]+|\[[^\]]+\])*$/.test(source)) {
		throw new Error(`tests/support/dom.mjs: unsupported selector "${source}"`);
	}
	const tokens = source.match(/[.#][\w-]+|\[[^\]]+\]|[a-zA-Z][\w-]*/g) ?? [];
	const tests = tokens.map((token) => {
		if (token.startsWith('.')) return (node) => String(node.className).split(/\s+/).includes(token.slice(1));
		if (token.startsWith('[')) {
			// `[attr]` and `[attr="value"]` / `[attr=value]`, because the player
			// finds its rows by index and the panel finds its forms by attribute.
			const match = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/.exec(token);
			if (!match) throw new Error(`tests/support/dom.mjs: unsupported attribute selector "${token}"`);
			const [, name, doubleQuoted, singleQuoted, bare] = match;
			const expected = doubleQuoted ?? singleQuoted ?? bare;
			return expected === undefined
				? (node) => node.attributes.has(name)
				: (node) => node.attributes.get(name) === expected;
		}
		return (node) => node.tagName === token.toUpperCase();
	});
	return (node) => tests.every((test) => test(node));
}

/** A fake `HTMLAudioElement` that records what the player did to it. */
class FakeAudio {
	constructor(src) {
		this.src = src;
		this.attributes = new Map();
		this.listeners = new Map();
		this.playCalls = 0;
		this.pauseCalls = 0;
		this.loadCalls = 0;
		this.playResult = Promise.resolve();
		this.retired = false;
	}

	addEventListener(type, fn) {
		if (!this.listeners.has(type)) this.listeners.set(type, []);
		this.listeners.get(type).push(fn);
	}

	removeEventListener(type, fn) {
		const entries = this.listeners.get(type);
		if (!entries) return;
		const index = entries.indexOf(fn);
		if (index >= 0) entries.splice(index, 1);
	}

	emit(type) {
		// A retired fixture's element must not fire into a later test: the
		// player's handlers read module-level state, so a stale event would
		// mutate whichever test is running now.
		if (this.retired) return;
		for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, target: this });
	}

	play() {
		this.playCalls += 1;
		return this.playResult;
	}

	pause() {
		this.pauseCalls += 1;
		this.emit('pause');
	}

	load() {
		this.loadCalls += 1;
	}

	removeAttribute(name) {
		this.attributes.delete(name);
		if (name === 'src') this.src = '';
	}

	setAttribute(name, value) {
		this.attributes.set(name, String(value));
	}

	getAttribute(name) {
		return this.attributes.get(name) ?? null;
	}
}

/** A fake YouTube IFrame API player. */
class FakeYouTubePlayer {
	constructor(element, options) {
		this.element = element;
		this.options = options;
		this.videoId = options.videoId;
		this.state = -1;
		this.time = 0;
		this.duration = 0;
		this.destroyed = false;
		this.volumeValue = null;
		this.pauseCalls = 0;
		this.muteCalls = 0;
		this.unmuteCalls = 0;
		this.loadedVideoIds = [];
		this.retired = false;
	}

	playVideo() {
		if (this.retired) return;
		this.state = 1;
		this.options.events?.onStateChange?.({ data: 1 });
	}

	pauseVideo() {
		if (this.retired) return;
		this.pauseCalls += 1;
		this.state = 2;
		this.options.events?.onStateChange?.({ data: 2 });
	}

	loadVideoById(videoId) {
		if (this.retired) return;
		this.loadedVideoIds.push(videoId);
		this.videoId = videoId;
		this.state = 3;
		this.options.events?.onStateChange?.({ data: 3 });
	}

	seekTo(seconds) {
		this.time = seconds;
	}

	setVolume(volume) {
		this.volumeValue = volume;
	}

	mute() {
		this.muteCalls += 1;
	}

	unMute() {
		this.unmuteCalls += 1;
	}

	getPlayerState() {
		return this.state;
	}

	getCurrentTime() {
		return this.time;
	}

	getDuration() {
		return this.duration;
	}

	getVideoData() {
		return { video_id: this.videoId, title: 'fake video', author: 'fake channel' };
	}

	destroy() {
		this.destroyed = true;
	}

	/** The provider says this video cannot be played. */
	fail() {
		if (this.retired) return;
		this.options.events?.onError?.({ data: 100 });
	}

	/** The video reached its end. */
	finish() {
		if (this.retired) return;
		this.state = 0;
		this.options.events?.onStateChange?.({ data: 0 });
	}
}

/**
 * The player fixture. Every selector `music.ts` requires is present, with the
 * same nesting the component uses — which also means a rename in the component
 * breaks these tests instead of silently doing nothing.
 */
const PLAYER_CHILDREN = [
	['button', 'data-music-play'],
	['button', 'data-music-next'],
	['button', 'data-music-playlist-toggle'],
	['button', 'data-music-toggle'],
];

const PANEL_CHILDREN = [
	['button', 'data-music-playlist-close'],
	['h3', 'data-music-current-title'],
	['p', 'data-music-current-artist'],
	['p', 'data-music-current-album'],
	['p', 'data-music-current-date'],
	['div', 'data-music-progress-region'],
	['div', 'data-music-progress'],
	['span', 'data-music-progress-fill'],
	['p', 'data-music-progress-note'],
	['span', 'data-music-elapsed'],
	['span', 'data-music-duration'],
	['span', 'data-music-queue-count'],
	['p', 'data-music-status-title'],
	['span', 'data-music-status-meta'],
	['span', 'data-music-state-announcement'],
];

export function installTestDom(options = {}) {
	const clock = new VirtualClock();
	// Everything this fixture creates checks this before firing an event, so a
	// torn-down player can never speak into the next test.
	const retired = { value: false };
	const previous = {
		document: globalThis.document,
		window: globalThis.window,
		Audio: globalThis.Audio,
		fetch: globalThis.fetch,
		setTimeout: globalThis.setTimeout,
		clearTimeout: globalThis.clearTimeout,
		setInterval: globalThis.setInterval,
		clearInterval: globalThis.clearInterval,
		requestAnimationFrame: globalThis.requestAnimationFrame,
		cancelAnimationFrame: globalThis.cancelAnimationFrame,
		localStorage: globalThis.localStorage,
		sessionStorage: globalThis.sessionStorage,
		CustomEvent: globalThis.CustomEvent,
		location: globalThis.location,
	};

	const storage = new Map();
	const session = new Map();
	const storageStub = {
		getItem: (key) => (storage.has(key) ? storage.get(key) : null),
		setItem: (key, value) => void storage.set(key, String(value)),
		removeItem: (key) => void storage.delete(key),
		clear: () => storage.clear(),
	};
	const sessionStub = {
		getItem: (key) => (session.has(key) ? session.get(key) : null),
		setItem: (key, value) => void session.set(key, String(value)),
		removeItem: (key) => void session.delete(key),
	};

	const documentElement = new TestElement('html');
	const head = new TestElement('head');
	const body = new TestElement('body');
	documentElement.appendChild(head);
	documentElement.appendChild(body);

	const listeners = new Map();
	/**
	 * Every listener currently attached anywhere in the document, plus the
	 * window's. A `destroy()` path is the only thing that lowers this number,
	 * which makes "the teardown really released everything" assertable rather
	 * than assumed.
	 */
	const countListeners = () => {
		let total = 0;
		const visit = (node) => {
			total += node.listeners ? [...node.listeners.values()].reduce((sum, list) => sum + list.length, 0) : 0;
			for (const child of node.childNodes ?? []) visit(child);
		};
		visit(documentElement);
		for (const list of listeners.values()) total += list.length;
		return total;
	};
	const removeWindowListener = (type, fn) => {
		const entries = listeners.get(type);
		if (!entries) return;
		const index = entries.findIndex((entry) => entry.fn === fn);
		if (index >= 0) entries.splice(index, 1);
	};
	const fireWindowEvent = (type, event = {}) => {
		for (const entry of [...(listeners.get(type) ?? [])]) entry.fn({ type, ...event });
	};

	const audioRegistry = [];
	const youtubeRegistry = [];

	const document = {
		documentElement,
		head,
		body,
		visibilityState: 'visible',
		// `document.hidden` (StackGame's loop gate reads it); tracks
		// `visibilityState` the way the real document does.
		get hidden() {
			return document.visibilityState === 'hidden';
		},
		createElement: (tag) => {
			const element = new TestElement(tag);
			element.ownerDocument = document;
			return element;
		},
		querySelector: (selector) => documentElement.querySelector(selector) ?? body.querySelector(selector),
		// A document-level search walks the whole tree, so <body> is reached
		// twice — once through <html> and once on its own. A browser returns
		// each matching node exactly once, and code that binds listeners from a
		// document-level querySelectorAll would otherwise bind them twice, so
		// the two walks are merged and de-duplicated here.
		querySelectorAll: (selector) => {
			const seen = new Set();
			const out = [];
			for (const node of documentElement.querySelectorAll(selector)) {
				if (seen.has(node)) continue;
				seen.add(node);
				out.push(node);
			}
			for (const node of body.querySelectorAll(selector)) {
				if (seen.has(node)) continue;
				seen.add(node);
				out.push(node);
			}
			return out;
		},
		// `{ signal }` is honoured here for the same reason TestElement honours
		// it: window-level teardowns are the ones most easily forgotten, so the
		// shim must be able to show they were forgotten. `window` delegates to
		// this method, so fixing it here fixes both.
		addEventListener: (type, fn, options = {}) => {
			if (!listeners.has(type)) listeners.set(type, []);
			listeners.get(type).push({ fn, signal: options.signal });
			options.signal?.addEventListener?.('abort', () => removeWindowListener(type, fn), { once: true });
		},
		removeEventListener: (type, fn) => removeWindowListener(type, fn),
		dispatchEvent: (event) => {
			fireWindowEvent(event.type, event);
			return true;
		},
		/** `document.contains()` — the overlay asks it about the last focus. */
		contains: (node) => documentElement.contains(node) || body.contains(node),
		__focus: (element) => {
			document.__focused = element;
		},
		__focused: null,
		/**
		 * `document.activeElement`. The settings overlay asks it both to decide
		 * where focus lands on open and to know whether focus is already inside
		 * the panel when it closes, so the shim keeps the focused element here
		 * and hands it back — `null` before anything is focused.
		 */
		get activeElement() {
			return document.__focused;
		},
		__fireWindowEvent: (type, event = {}) => fireWindowEvent(type, event),
	};

	// In a browser the window IS the global scope, so the shim points one
	// listener map and one clock at both objects rather than keeping two.
	const window = {
		document,
		location: { pathname: options.pathname ?? '/', href: 'https://bnji.net/' },
		visibilityState: 'visible',
		setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
		clearTimeout: (id) => clock.clearTimeout(id),
		setInterval: (fn, ms) => clock.setInterval(fn, ms),
		clearInterval: (id) => clock.clearInterval(id),
		requestAnimationFrame: (fn) => clock.requestAnimationFrame(fn),
		cancelAnimationFrame: (id) => clock.cancelAnimationFrame(id),
		addEventListener: (type, fn, options) => document.addEventListener(type, fn, options),
		removeEventListener: (type, fn) => document.removeEventListener(type, fn),
		dispatchEvent: (event) => document.dispatchEvent(event),
		matchMedia: undefined,
		CustomEvent: class CustomEvent {
			constructor(type, init = {}) {
				this.type = type;
				this.detail = init.detail;
			}
		},
	};

	globalThis.document = document;
	globalThis.window = window;
	globalThis.CustomEvent = window.CustomEvent;
	globalThis.location = window.location;
	globalThis.Audio = class Audio extends FakeAudio {
		constructor(src) {
			super(src);
			this.retired = retired.value;
			audioRegistry.push(this);
		}
	};
	globalThis.requestAnimationFrame = (fn) => clock.requestAnimationFrame(fn);
	globalThis.cancelAnimationFrame = (id) => clock.cancelAnimationFrame(id);
	// In a browser the global scope IS window, so bare setTimeout/setInterval
	// (as used by the lab games) must hit the same virtual clock as
	// window.* — otherwise a `clearInterval` from one side cannot cancel a
	// timer from the other.
	globalThis.setTimeout = (fn, ms) => clock.setTimeout(fn, ms);
	globalThis.clearTimeout = (id) => clock.clearTimeout(id);
	globalThis.setInterval = (fn, ms) => clock.setInterval(fn, ms);
	globalThis.clearInterval = (id) => clock.clearInterval(id);
	globalThis.localStorage = storageStub;
	globalThis.sessionStorage = sessionStub;

	/* --- fetch --- */

	const fetchCalls = [];
	const responses = [...(options.responses ?? [])];
	const held = [];
	const respond = (payload, status) =>
		Promise.resolve(
			new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
				status: status ?? 200,
				headers: { 'content-type': 'application/json' },
			}),
		);
	globalThis.fetch = (input, init = {}) => {
		const url = typeof input === 'string' ? input : input.url;
		fetchCalls.push({ url, init });
		const next = responses.shift();
		// 'pending' lets a test assert on the UI WHILE a request is in flight.
		if (next === 'pending') {
			return new Promise((resolve) => held.push({ url, resolve }));
		}
		if (!next) return Promise.reject(new Error(`unexpected fetch: ${url}`));
		if (next instanceof Error) return Promise.reject(next);
		return respond(next, next.status);
	};

	/* --- the fixture --- */

	function build(tag, attribute) {
		const element = document.createElement(tag);
		element.setAttribute(attribute, '');
		return element;
	}

	const player = build('div', 'data-music-player');
	player.dataset.state = 'idle';
	player.dataset.provider = 'none';
	player.dataset.trackCount = '0';
	player.dataset.playlistOpen = 'false';
	player.dataset.collapsed = 'false';

	const controls = document.createElement('div');
	for (const [tag, attribute] of PLAYER_CHILDREN) controls.appendChild(build(tag, attribute));
	player.appendChild(controls);

	const panel = build('section', 'data-music-playlist');
	panel.hidden = true;
	const status = document.createElement('p');
	status.appendChild(build('p', 'data-music-status-title'));
	status.appendChild(build('span', 'data-music-status-meta'));
	status.appendChild(build('span', 'data-music-state-announcement'));
	controls.appendChild(status);

	for (const [tag, attribute] of PANEL_CHILDREN) panel.appendChild(build(tag, attribute));
	const queue = document.createElement('ol');
	queue.setAttribute('data-music-track-list', '');
	panel.appendChild(queue);
	player.appendChild(panel);

	player.appendChild(build('div', 'data-music-youtube-host'));
	// Both embed hosts, mirroring MusicPlayer.astro. The player refuses to
	// boot without them, so a fixture missing either one silently tests
	// nothing at all.
	player.appendChild(build('div', 'data-music-spotify-host'));
	body.appendChild(player);

	const event = (type, extra = {}) => ({
		type,
		isTrusted: true,
		preventDefault: () => {},
		stopPropagation: () => {},
		composedPath: () => [player, body],
		...extra,
	});

	return {
		clock,
		document,
		window,
		player,
		audioRegistry,
		youtubeRegistry,

		/* --- queries --- */
		text: (selector) => player.querySelector(selector)?.textContent ?? null,
		attr: (selector, name) => player.querySelector(selector)?.getAttribute(name) ?? null,
		/** The player root's own dataset — `[data-music-player]` is itself. */
		dataset: player.dataset,
		datasetOf: (selector) => player.querySelector(selector)?.dataset ?? null,
		hidden: (selector) => player.querySelector(selector)?.hidden ?? null,
		disabled: (selector) => player.querySelector(selector)?.disabled ?? null,
		count: (selector) => player.querySelectorAll(selector).length,
		find: (selector) => player.querySelector(selector),
		/** Document-scoped queries, for panels that are not the music player. */
		q: (selector) => body.querySelector(selector),
		qAll: (selector) => body.querySelectorAll(selector),

		/* --- events --- */
		click: (selector) => player.querySelector(selector)?.dispatchEvent(event('click')),
		keydown: (selector, key) => player.querySelector(selector)?.dispatchEvent(event('keydown', { key })),
		/** A trusted input outside the player: the autoplay-retry path. */
		outsideInput: () => document.__fireWindowEvent('pointerdown', event('pointerdown', { composedPath: () => [body] })),

		/* --- clock --- */
		advance: (ms) => clock.advance(ms),
		/** Let queued microtasks (the async playlist load) settle. */
		settle: async (ticks = 25) => {
			for (let index = 0; index < ticks; index += 1) await Promise.resolve();
		},

		/* --- provider fakes --- */
		/** Make the next `<audio>` refuse to play, the way a browser does. */
		rejectNextAudioPlay: (name) => {
			globalThis.Audio = class extends FakeAudio {
				constructor(src) {
					super(src);
					this.playResult = Promise.reject(Object.assign(new Error('playback refused'), { name }));
					audioRegistry.push(this);
				}
			};
		},

		installYouTubeApi: () => {
			window.YT = {
				Player: class extends FakeYouTubePlayer {
					constructor(element, options) {
						super(element, options);
						this.retired = retired.value;
						youtubeRegistry.push(this);
						// onReady is asynchronous in the real API.
						queueMicrotask(() => options.events?.onReady?.({ target: this }));
					}
				},
			};
		},
		lastAudio: () => audioRegistry[audioRegistry.length - 1] ?? null,
		lastYouTube: () => youtubeRegistry[youtubeRegistry.length - 1] ?? null,

		fetchCalls,

		/* --- a request held mid-flight --- */
		pushResponse: (next) => void responses.push(next),
		/** Answer the oldest held request. */
		resolveNext: (payload, status = 200) => {
			const entry = held.shift();
			if (!entry) throw new Error('no request is being held');
			entry.resolve(
				new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
					status,
					headers: { 'content-type': 'application/json' },
				}),
			);
		},
		heldCount: () => held.length,

		/** Total live listeners in the document and on the window. */
		listenerCount: () => countListeners(),

		uninstall: () => {
			retired.value = true;
			for (const audio of audioRegistry) audio.retired = true;
			for (const player of youtubeRegistry) player.retired = true;
			globalThis.document = previous.document;
			globalThis.window = previous.window;
			globalThis.Audio = previous.Audio;
			globalThis.fetch = previous.fetch;
			globalThis.requestAnimationFrame = previous.requestAnimationFrame;
			globalThis.cancelAnimationFrame = previous.cancelAnimationFrame;
			globalThis.setTimeout = previous.setTimeout;
			globalThis.clearTimeout = previous.clearTimeout;
			globalThis.setInterval = previous.setInterval;
			globalThis.clearInterval = previous.clearInterval;
			globalThis.localStorage = previous.localStorage;
			globalThis.sessionStorage = previous.sessionStorage;
			globalThis.CustomEvent = previous.CustomEvent;
			globalThis.location = previous.location;
		},
	};
}
