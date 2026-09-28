/**
 * BNJI.NET — the Settings overlay as a dialog, and the two controls in it that
 * are NOT settings.
 *
 * Three things have to hold, and only the first of them used to be obvious:
 *
 *   1. The overlay behaves like a modal: the gear opens it, Escape / the
 *      backdrop / the close button close it, Tab cycles inside it, and focus
 *      goes back to whatever opened it.
 *   2. The masked code field is honest. Nothing is wired behind it, so every
 *      submission must be answered with "not enabled yet" — never a message
 *      that implies a code worked.
 *   3. The code is disposable. It is not a Settings field, so it cannot reach
 *      the store or localStorage; it is wiped on submit and again on close.
 *      This is the assertion that matters most, because the failure mode is
 *      invisible: a code sitting in a field, or worse in storage, looks
 *      exactly like a working feature until someone reads it back.
 *
 * The Admin link is a plain anchor to `/admin/`. It is asserted here as a link
 * and not as a button, because the whole point is that it performs no
 * client-side check: the server decides who may stay (see docs/ADMIN.md §5).
 *
 * There is no browser here, so these run against the DOM shim in
 * tests/support/dom.mjs with a virtual clock. The fixture mirrors
 * SettingsOverlay.astro's structure and selectors, so a rename in the
 * component fails here rather than silently skipping — and the last test
 * compares the two from source, for the attributes this fixture does not
 * render.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installTestDom } from './support/dom.mjs';
import {
	CODE_EMPTY_MESSAGE,
	CODE_HANDLERS,
	CODE_IDLE_MESSAGE,
	CODE_UNAVAILABLE_MESSAGE,
	normalizeCode,
	submitCode,
	type CodeHandler,
} from '../src/scripts/settings-codes.ts';
import { SETTINGS_STORAGE_KEY } from '../src/scripts/settings.ts';

type Dom = ReturnType<typeof installTestDom>;
type OverlayModule = typeof import('../src/scripts/settings-overlay.ts');
type SettingsModule = typeof import('../src/scripts/settings.ts');

type CodesModule = typeof import('../src/scripts/settings-codes.ts');

let overlayModule: OverlayModule | null = null;
let codesModule: CodesModule | null = null;
let settingsModule: SettingsModule | null = null;
let active: Dom | null = null;

/** The overlay's DOM globals are installed before its modules are imported. */
async function modules(): Promise<{ overlay: OverlayModule; settings: SettingsModule }> {
	if (!overlayModule) overlayModule = await import('../src/scripts/settings-overlay.ts');
	if (!settingsModule) settingsModule = await import('../src/scripts/settings.ts');
	return { overlay: overlayModule, settings: settingsModule };
}

/** The dispatcher module, imported on its own so it needs no DOM. */
async function codeModules(): Promise<{ codes: CodesModule }> {
	if (!codesModule) codesModule = await import('../src/scripts/settings-codes.ts');
	return { codes: codesModule };
}

/**
 * Run `body` with temporary handlers in the registry, then remove them.
 *
 * The registry ships empty, which is the whole point of it — so the only way to
 * prove the dispatch rules is to lend it handlers for the length of one test.
 * `finally` is what makes that safe: a failed assertion must not leave a
 * handler behind for the next test to trip over.
 */
function withHandler(...handlers: [...CodeHandler[], () => void]): void {
	const registry = CODE_HANDLERS as CodeHandler[];
	const body = handlers.pop() as () => void;
	registry.push(...(handlers as CodeHandler[]));
	try {
		body();
	} finally {
		registry.length = 0;
	}
	assert.equal(registry.length, 0, 'the registry is empty again');
}

/** The code under test. Chosen so it cannot collide with any real value. */
const CODE = 'not-a-real-code-42';

/** The ten fields the store has always had — no more, and no code among them. */
const SETTINGS_FIELDS = [
	'advancedGlass',
	'cursorEffects',
	'introEnabled',
	'muted',
	'performanceMode',
	'reducedEffects',
	'starDensity',
	'theme',
	'uiScale',
	'volume',
];

/** The shim's element type, which is what every fixture node is. */
type El = ReturnType<Dom['document']['createElement']>;

/** The nodes the controller binds, named as the tests refer to them. */
type Fixture = {
	backdrop: El;
	overlay: El;
	close: El;
	gear: El;
	footerLink: El;
	codeInput: El;
	codeSubmit: El;
	codeStatus: El;
	adminLink: El;
	mute: El;
	volume: El;
};

/**
 * Build a SettingsOverlay-shaped tree: backdrop, panel, close button, one
 * control per bound field, the code row, the Admin link, and two triggers (the
 * header gear plus a footer shortcut), all carrying the hooks the controller
 * looks up.
 */
function buildOverlay(dom: Dom): Fixture {
	const doc = dom.document;

	const el = (tag: string, attributes: Record<string, string> = {}) => {
		const element = doc.createElement(tag);
		for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
		return element;
	};

	const backdrop = el('div', { 'data-settings-backdrop': '' });
	const overlay = el('section', {
		class: 'settings-overlay',
		'data-settings-overlay': '',
		'data-glass': 'raised',
		role: 'dialog',
		'aria-modal': 'true',
		'aria-labelledby': 'settings-title',
		tabindex: '-1',
	});
	// `hidden` is a property, not a reflected attribute, so the panel and its
	// backdrop start closed the way the built markup does.
	overlay.hidden = true;
	backdrop.hidden = true;

	const head = el('header', { class: 'settings-overlay__head' });
	const title = el('h2', { class: 'settings-overlay__title', id: 'settings-title' });
	title.textContent = 'Settings';
	head.appendChild(title);
	const close = el('button', { class: 'settings-overlay__close', type: 'button', 'data-settings-close': '' });
	close.textContent = 'Close';
	head.appendChild(close);
	overlay.appendChild(head);

	// Two store-bound controls, so the binding half of the module is exercised
	// alongside the dialog half: a checkbox and a range with its readout.
	const mute = el('input', { id: 'settings-muted', 'data-setting': 'muted' });
	mute.type = 'checkbox';
	mute.checked = false;
	overlay.appendChild(mute);

	const volume = el('input', { id: 'settings-volume', min: '0', max: '100', step: '5', 'data-setting': 'volume' });
	volume.type = 'range';
	volume.value = '60';
	const volumeReadout = el('output', { 'data-setting-output': 'volume' });
	volumeReadout.textContent = '60%';
	overlay.appendChild(volume);
	overlay.appendChild(volumeReadout);

	// The code row: masked input, submit button, live status line.
	const codeGroup = el('fieldset', { class: 'settings-group' });
	const codeLegend = el('legend', { class: 'settings-group__title mono' });
	codeLegend.textContent = 'Secret codes';
	codeGroup.appendChild(codeLegend);

	const codeInput = el('input', {
		id: 'settings-code',
		class: 'settings-code__input',
		type: 'password',
		autocomplete: 'off',
		spellcheck: 'false',
		'aria-describedby': 'settings-code-status',
		'data-settings-code': '',
	});
	codeInput.type = 'password';
	codeInput.value = '';
	codeGroup.appendChild(codeInput);

	const codeSubmit = el('button', {
		class: 'glass-button glass-button--sm',
		type: 'button',
		'data-glass': '',
		'data-settings-code-submit': '',
	});
	codeSubmit.textContent = 'Submit';
	codeGroup.appendChild(codeSubmit);

	const codeStatus = el('p', {
		class: 'settings-code__status mono',
		id: 'settings-code-status',
		role: 'status',
		'aria-live': 'polite',
		'data-settings-code-status': '',
	});
	codeStatus.textContent = CODE_IDLE_MESSAGE;
	codeGroup.appendChild(codeStatus);
	overlay.appendChild(codeGroup);

	// The Admin link: a real anchor to the real route.
	const adminGroup = el('fieldset', { class: 'settings-group' });
	const adminLegend = el('legend', { class: 'settings-group__title mono' });
	adminLegend.textContent = 'Admin';
	adminGroup.appendChild(adminLegend);
	const adminLink = el('a', { class: 'glass-button glass-button--sm', href: '/admin/', 'data-glass': '' });
	adminLink.textContent = 'Admin';
	adminGroup.appendChild(adminLink);
	overlay.appendChild(adminGroup);

	doc.body.appendChild(backdrop);
	doc.body.appendChild(overlay);

	// Triggers: the header gear is the real one, and a second stands in for any
	// other [data-settings-open] on the page (Header.astro is the only one
	// today), so the multi-trigger paths are covered either way.
	const gear = el('button', {
		class: 'nav__action',
		type: 'button',
		'data-settings-open': '',
		'aria-expanded': 'false',
	});
	const footerLink = el('a', { href: '#settings', 'data-settings-open': '', 'aria-expanded': 'false' });
	doc.body.appendChild(gear);
	doc.body.appendChild(footerLink);

	return {
		backdrop,
		overlay,
		close,
		gear,
		footerLink,
		codeInput,
		codeSubmit,
		codeStatus,
		adminLink,
		mute,
		volume,
	};
}

/** Dispatch a key event on an element. */
const key = (element: El, name: string, options: { shiftKey?: boolean } = {}) =>
	element.dispatchEvent({
		type: 'keydown',
		key: name,
		shiftKey: options.shiftKey === true,
		preventDefault: () => {},
		stopPropagation: () => {},
	});

/** Click an element. */
const click = (element: El) =>
	element.dispatchEvent({ type: 'click', preventDefault: () => {}, stopPropagation: () => {} });

/** Name a fixture node, for an assertion that reads as a sentence. */
function labelOf(element: El, dom: Dom & Fixture): string {
	if (element === dom.close) return 'close';
	if (element === dom.mute) return 'mute';
	if (element === dom.volume) return 'volume';
	if (element === dom.codeInput) return 'code';
	if (element === dom.codeSubmit) return 'submit';
	if (element === dom.adminLink) return 'admin';
	return `unexpected:${element.tagName}`;
}

/** The controller's own focus-trap selector, quoted so the test tracks it. */
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Install the DOM, build the fixture and bind the controller. */
async function boot(): Promise<Dom & Fixture> {
	const dom = installTestDom();
	const fixture = buildOverlay(dom);
	const { overlay } = await modules();
	overlay.initSettingsOverlay();
	active = dom;
	return Object.assign(dom, fixture);
}

afterEach(() => {
	overlayModule?.destroySettingsOverlay();
	if (active) active.uninstall();
	active = null;
});

/* --- the dialog ----------------------------------------------------------- */

test('the gear opens and closes the panel, with the scroll lock and aria state', async () => {
	const dom = await boot();

	assert.equal(dom.overlay.hidden, true, 'starts closed');
	assert.equal(dom.backdrop.hidden, true, 'backdrop starts closed');
	assert.equal(dom.gear.getAttribute('aria-expanded'), 'false');

	click(dom.gear);
	assert.equal(dom.overlay.hidden, false, 'the gear opens the panel');
	assert.equal(dom.backdrop.hidden, false, 'the backdrop opens with it');
	assert.equal(dom.document.documentElement.classList.contains('settings-is-open'), true);
	assert.equal(dom.gear.getAttribute('aria-expanded'), 'true');
	assert.equal(dom.footerLink.getAttribute('aria-expanded'), 'true', 'every trigger tracks state');

	click(dom.gear);
	assert.equal(dom.overlay.hidden, true, 'the gear closes the panel again');
	assert.equal(dom.backdrop.hidden, true);
	assert.equal(dom.document.documentElement.classList.contains('settings-is-open'), false);
	assert.equal(dom.gear.getAttribute('aria-expanded'), 'false');
});

test('Escape, the backdrop and the close button each close the panel', async () => {
	const dom = await boot();

	click(dom.gear);
	key(dom.overlay, 'Escape');
	assert.equal(dom.overlay.hidden, true, 'Escape closes');

	click(dom.gear);
	assert.equal(dom.overlay.hidden, false);
	click(dom.backdrop);
	assert.equal(dom.overlay.hidden, true, 'a backdrop click closes');

	click(dom.gear);
	click(dom.close);
	assert.equal(dom.overlay.hidden, true, 'the close button closes');
});

test('focus moves into the panel on open and back to the opener on close', async () => {
	const dom = await boot();

	dom.gear.focus();
	assert.equal(dom.document.__focused, dom.gear, 'the opener holds focus before opening');

	click(dom.gear);
	assert.equal(dom.document.__focused, dom.overlay, 'the panel itself is focused on open');

	click(dom.close);
	assert.equal(dom.document.__focused, dom.gear, 'focus returns to the opener');

	// A different trigger is a different opener.
	dom.footerLink.focus();
	click(dom.footerLink);
	assert.equal(dom.overlay.hidden, false);
	click(dom.backdrop);
	assert.equal(dom.document.__focused, dom.footerLink, 'focus returns to whichever trigger opened it');
});

test('Tab is trapped inside the panel, and the new controls are in the cycle', async () => {
	const dom = await boot();
	click(dom.gear);

	const focusable = dom.overlay.querySelectorAll(FOCUSABLE);
	// Close button, the two bound inputs, code input, code submit, Admin link.
	// The panel itself is excluded by the :not() — that is what keeps Tab out
	// of the container. Compared by label rather than by node, because
	// assert.deepEqual walks a node's ancestors and these form a cycle.
	assert.deepEqual(
		focusable.map((element: El) => labelOf(element, dom)),
		['close', 'mute', 'volume', 'code', 'submit', 'admin'],
	);

	const first = focusable[0];
	const last = focusable[focusable.length - 1];

	// From the container (focus is on it right after opening), Tab wraps to
	// the first control rather than escaping the panel.
	key(dom.overlay, 'Tab');
	assert.equal(dom.document.__focused, first, 'Tab from the container lands on the first control');

	last.focus();
	key(dom.overlay, 'Tab');
	assert.equal(dom.document.__focused, first, 'Tab past the last control wraps to the first');

	first.focus();
	key(dom.overlay, 'Tab', { shiftKey: true });
	assert.equal(dom.document.__focused, last, 'Shift+Tab before the first control wraps to the last');
});

test('the two-way store binding still writes every control and readout', async () => {
	const { settings } = await modules();
	const dom = await boot();

	// The controller syncs once on init, straight from the store.
	assert.equal(dom.mute.checked, settings.getSettings().muted === true, 'the checkbox mirrors the store');
	assert.equal(dom.volume.value, String(Math.round(settings.getSettings().volume * 100)), 'the range mirrors the store');
	const readout = dom.document.querySelector('[data-setting-output="volume"]');
	assert.equal(readout.textContent, `${Math.round(settings.getSettings().volume * 100)}%`, 'the readout mirrors the store');

	// Writing through a control reaches the store, and the code field is not
	// one of them: it carries no [data-setting], so it can never be persisted.
	dom.mute.checked = true;
	dom.mute.dispatchEvent({ type: 'change' });
	assert.equal(settings.getSettings().muted, true, 'the change handler writes through');

	dom.mute.checked = false;
	dom.mute.dispatchEvent({ type: 'change' });
	assert.equal(settings.getSettings().muted, false);
});

/* --- the secret code field ------------------------------------------------ */

test('an empty submission is refused, and the field is left empty', async () => {
	const dom = await boot();

	dom.codeInput.value = '';
	click(dom.codeSubmit);
	assert.equal(dom.codeStatus.textContent, CODE_EMPTY_MESSAGE);
	assert.equal(dom.codeInput.value, '', 'nothing to clear, but nothing appears either');

	// Whitespace alone is empty too — the dispatcher normalises before counting.
	dom.codeInput.value = '   ';
	click(dom.codeSubmit);
	assert.equal(dom.codeStatus.textContent, CODE_EMPTY_MESSAGE);
	assert.equal(dom.codeInput.value, '');
});

test('a real submission is answered honestly and the field is cleared', async () => {
	const dom = await boot();

	dom.codeInput.value = CODE;
	click(dom.codeSubmit);

	assert.equal(
		dom.codeStatus.textContent,
		CODE_UNAVAILABLE_MESSAGE,
		'no effect is configured, so no submission may read as accepted',
	);
	assert.equal(dom.codeInput.value, '', 'the code leaves the field on submit');
	assert.doesNotMatch(dom.codeStatus.textContent ?? '', new RegExp(CODE), 'the status never echoes the code');
});

test('Enter in the field submits, and no form is involved', async () => {
	const dom = await boot();

	dom.codeInput.value = CODE;
	key(dom.codeInput, 'Enter');

	assert.equal(dom.codeStatus.textContent, CODE_UNAVAILABLE_MESSAGE);
	assert.equal(dom.codeInput.value, '', 'Enter submits and clears like the button does');

	// A real submission path would be a <form>. There is none: a password
	// field inside a form is what makes browsers offer to save it.
	const markup = readFileSync(new URL('../src/components/SettingsOverlay.astro', import.meta.url), 'utf8');
	const codes = /<fieldset[^>]*>\s*<legend[^>]*>Secret codes<\/legend>([\s\S]*?)<\/fieldset>/.exec(markup);
	assert.ok(codes, 'the Settings overlay has a Secret codes fieldset');
	assert.doesNotMatch(codes[1], /<form/i, 'the code field must not sit in a form');
});

test('the code is wiped and the status reset when the panel closes', async () => {
	const dom = await boot();

	click(dom.gear);
	dom.codeInput.value = CODE;
	click(dom.codeSubmit);
	assert.equal(dom.codeStatus.textContent, CODE_UNAVAILABLE_MESSAGE);

	// Type again but do not submit: the panel is closed with a value in it.
	dom.codeInput.value = CODE;
	click(dom.close);
	assert.equal(dom.codeInput.value, '', 'the close button clears the field');
	assert.equal(dom.codeStatus.textContent, CODE_IDLE_MESSAGE, 'closing resets the status');

	click(dom.gear);
	dom.codeInput.value = CODE;
	key(dom.overlay, 'Escape');
	assert.equal(dom.codeInput.value, '', 'Escape clears it too');
	assert.equal(dom.codeStatus.textContent, CODE_IDLE_MESSAGE);
});

/* --- nothing is stored, and nothing leaks -------------------------------- */

test('a submitted code reaches no store, no storage, no URL and no log', async () => {
	const logged: string[] = [];
	const real = { log: console.log, info: console.info, warn: console.warn, error: console.error };
	const record = (...args: unknown[]) => void logged.push(args.map((arg) => String(arg)).join(' '));
	console.log = record;
	console.info = record;
	console.warn = record;
	console.error = record;

	try {
		const dom = await boot();
		const before = { href: dom.window.location.href, pathname: dom.window.location.pathname };
		const { settings } = await modules();

		click(dom.gear);
		dom.codeInput.value = CODE;
		click(dom.codeSubmit);
		key(dom.overlay, 'Escape');

		// Not in the settings store, and not in anything the store wrote.
		const persisted = globalThis.localStorage.getItem(SETTINGS_STORAGE_KEY);
		assert.doesNotMatch(JSON.stringify(settings.getSettings()), new RegExp(CODE), 'the store holds no code');
		assert.doesNotMatch(persisted ?? '', new RegExp(CODE), 'localStorage holds no code');
		assert.ok(
			!Object.keys(settings.getSettings()).some((field) => /code|secret/i.test(field)),
			'the settings schema has no code field to put one in',
		);

		// Not in the URL, and not in any other storage slot.
		assert.equal(dom.window.location.href, before.href, 'the URL did not change');
		assert.equal(dom.window.location.pathname, before.pathname, 'the path did not change');
		assert.equal(dom.codeInput.value, '', 'and the field is empty again after the close');

		// Not in the console.
		assert.deepEqual(logged, [], 'nothing about the code was logged');
	} finally {
		Object.assign(console, real);
	}
});

/* --- the dispatcher itself ------------------------------------------------ */

test('normalizeCode trims the ends and collapses inner whitespace', async () => {
	const { codes } = await codeModules();
	assert.equal(codes.normalizeCode('  plain  '), 'plain');
	assert.equal(codes.normalizeCode('two   words'), 'two words');
	assert.equal(codes.normalizeCode('a\t\nb'), 'a b');
	assert.equal(codes.normalizeCode('   '), '');
	// The shape a handler receives is exactly this, so a handler can be tested
	// against the string it will actually see.
	assert.equal(codes.normalizeCode('  spaced\tout  '), 'spaced out');
});

test('an empty submission never reaches a handler', async () => {
	const { codes } = await codeModules();
	const seen: string[] = [];
	withHandler(() => {
		seen.push('called');
		return null;
	}, () => {
		const outcome = codes.submitCode('   ', {} as HTMLElement);
		assert.equal(outcome.status, 'rejected');
		assert.equal(outcome.message, CODE_EMPTY_MESSAGE);
		assert.deepEqual(seen, [], 'a handler was reached for an empty code');
	});
});

test('the first handler to claim a code wins, and a null falls through', async () => {
	const { codes } = await codeModules();
	const order: string[] = [];
	withHandler(
		() => {
			order.push('first');
			return null;
		},
		() => {
			order.push('second');
			return { status: 'accepted', message: 'claimed by the second handler' };
		},
		() => {
			order.push('third');
			return { status: 'accepted', message: 'never reached' };
		},
		() => {
			const outcome = codes.submitCode('some-code', {} as HTMLElement);
			assert.equal(outcome.status, 'accepted');
			assert.equal(outcome.message, 'claimed by the second handler');
			assert.deepEqual(order, ['first', 'second'], 'the third handler never saw a claimed code');
		},
	);
});

test('a handler that declines every code leaves the honest "not enabled" answer', async () => {
	const { codes } = await codeModules();
	withHandler(() => null, () => {
		const outcome = codes.submitCode('some-code', {} as HTMLElement);
		assert.equal(outcome.status, 'unavailable', 'it must never read like the code was accepted');
		assert.equal(outcome.message, CODE_UNAVAILABLE_MESSAGE);
	});
});

test('the persisted settings schema has gained no code field', async () => {
	const { settings } = await modules();
	assert.deepEqual(Object.keys(settings.getSettings()).sort(), SETTINGS_FIELDS);
});

test('the dispatcher keeps the code out of storage, the URL and the console', async () => {
	// Comments are stripped first: the module's header explains at length why it
	// must NOT touch these, which is not the same as touching them.
	const raw = readFileSync(new URL('../src/scripts/settings-codes.ts', import.meta.url), 'utf8');
	const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
	assert.doesNotMatch(
		code,
		/localStorage|sessionStorage|document\.cookie|location\.|history\.|console\./,
		'a client-side code must never be written anywhere',
	);
	assert.equal(CODE_HANDLERS.length, 0, 'the registry is empty, so nothing is granted');
});

/* --- the admin link ------------------------------------------------------ */

test('the Admin control is a real link to /admin/, with no client-side gate', async () => {
	const dom = await boot();

	assert.equal(dom.adminLink.tagName, 'A', 'it is a link, not a button');
	assert.equal(dom.adminLink.getAttribute('href'), '/admin/', 'it points at the admin route, trailing slash included');
	assert.equal(dom.adminLink.textContent, 'Admin');
	assert.equal(dom.adminLink.hasAttribute('data-glass'), true, 'it carries the glass surface like every other control');

	// It must not be wired to anything client-side: the server decides.
	const source = readFileSync(new URL('../src/components/SettingsOverlay.astro', import.meta.url), 'utf8');
	const admin = /<a[^>]*href="\/admin\/"[^>]*>/.exec(source);
	assert.ok(admin, 'the Admin anchor is in the markup');
	assert.doesNotMatch(admin[0], /onclick|data-settings/i, 'the link has no client-side handler of its own');

	// And it is inside the focus cycle, so keyboard users reach it.
	click(dom.gear);
	const focusable = dom.overlay.querySelectorAll(FOCUSABLE);
	assert.ok(focusable.includes(dom.adminLink), 'the link is reachable by Tab');
});

/* --- the markup the controller binds ------------------------------------- */

test('every hook the controller queries is rendered by a component', async () => {
	const script = readFileSync(new URL('../src/scripts/settings-overlay.ts', import.meta.url), 'utf8');
	const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

	const selectors = new Set<string>();
	for (const match of script.matchAll(/querySelector(?:All)?(?:<[^>]*>)?\(\s*'\[([\w-]+)\]'/g)) {
		selectors.add(match[1]);
	}
	assert.ok(selectors.size > 0, 'the controller queries nothing');

	// Most hooks live in the overlay; the opener lives in the header, which is
	// the only place a gear is rendered.
	const OWNER: Record<string, string> = {
		'data-settings-open': 'src/components/Header.astro',
	};

	for (const selector of selectors) {
		const owner = OWNER[selector] ?? 'src/components/SettingsOverlay.astro';
		assert.match(read(owner), new RegExp(`\\s${selector}(=|\\s|>)`), `${owner} is missing ${selector}`);
	}

	// The two new controls in particular: their hooks, their labels and the
	// accessible status line must all be in the real markup.
	const markup = read('src/components/SettingsOverlay.astro');
	assert.match(markup, /data-settings-code\b/, 'the masked input is bound');
	assert.match(markup, /data-settings-code-submit\b/, 'the submit button is bound');
	assert.match(markup, /data-settings-code-status\b/, 'the status line is bound');
	assert.match(markup, /type="password"/, 'the input is masked');
	assert.match(markup, /autocomplete="off"/, 'the input opts out of autofill');
	assert.match(markup, /role="status"/, 'the status line is a live region');
	assert.match(markup, /aria-live="polite"/, 'the status line is announced politely');
	assert.match(markup, /href="\/admin\/"/, 'the Admin link points at /admin/');
	assert.match(markup, /<legend[^>]*>Admin<\/legend>/, 'the Admin group is labelled');
	assert.match(
		markup,
		new RegExp(CODE_IDLE_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
		'the idle status text is the one the controller resets to',
	);
});
