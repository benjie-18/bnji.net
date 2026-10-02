import test from 'node:test';
import assert from 'node:assert/strict';
import { installTestDom } from './support/dom.mjs';

function setupMatchMedia(window: any, isDesktop = true) {
	const mm = (query: string) => ({
		matches: isDesktop ? query.includes('min-width: 900px') : !query.includes('min-width: 900px'),
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	});
	window.matchMedia = mm;
	globalThis.matchMedia = mm;
}

test('header dropdowns toggle open/close on trigger click', async () => {
	const dom = installTestDom();
	setupMatchMedia(dom.window, true);
	try {
		const navGroup = dom.document.createElement('li');
		navGroup.className = 'nav-group';
		navGroup.setAttribute('data-nav-group', '');

		const trigger = dom.document.createElement('button');
		trigger.type = 'button';
		trigger.className = 'nav-group__trigger';
		trigger.setAttribute('data-nav-dropdown-trigger', '');
		trigger.setAttribute('aria-expanded', 'false');
		trigger.setAttribute('aria-controls', 'nav-dropdown-projects');
		trigger.textContent = 'Projects';

		const dropdown = dom.document.createElement('div');
		dropdown.className = 'nav-dropdown';
		dropdown.setAttribute('id', 'nav-dropdown-projects');
		dropdown.setAttribute('data-nav-dropdown', '');

		navGroup.appendChild(trigger);
		navGroup.appendChild(dropdown);
		dom.document.body.appendChild(navGroup);

		const { initNavDropdowns, teardownInteractions } = await import('../src/scripts/interactions.ts');
		initNavDropdowns();

		assert.equal(navGroup.classList.contains('is-open'), false);
		assert.equal(trigger.getAttribute('aria-expanded'), 'false');

		// Click trigger
		trigger.dispatchEvent(new dom.window.CustomEvent('click'));

		assert.equal(navGroup.classList.contains('is-open'), true, 'Group should have is-open class after click');
		assert.equal(trigger.getAttribute('aria-expanded'), 'true', 'Trigger aria-expanded should be true after click');

		// Click trigger again
		trigger.dispatchEvent(new dom.window.CustomEvent('click'));

		assert.equal(navGroup.classList.contains('is-open'), false, 'Group should lose is-open class on second click');
		assert.equal(trigger.getAttribute('aria-expanded'), 'false', 'Trigger aria-expanded should be false');

		teardownInteractions();
	} finally {
		dom.uninstall();
	}
});

test('header dropdown closes on pointerdown outside', async () => {
	const dom = installTestDom();
	setupMatchMedia(dom.window, true);
	try {
		const outside = dom.document.createElement('div');
		outside.setAttribute('id', 'outside');
		dom.document.body.appendChild(outside);

		const navGroup = dom.document.createElement('li');
		navGroup.className = 'nav-group';
		navGroup.setAttribute('data-nav-group', '');

		const trigger = dom.document.createElement('button');
		trigger.type = 'button';
		trigger.className = 'nav-group__trigger';
		trigger.setAttribute('data-nav-dropdown-trigger', '');
		trigger.setAttribute('aria-expanded', 'false');
		trigger.setAttribute('aria-controls', 'nav-dropdown-projects');
		trigger.textContent = 'Projects';

		const dropdown = dom.document.createElement('div');
		dropdown.className = 'nav-dropdown';
		dropdown.setAttribute('id', 'nav-dropdown-projects');
		dropdown.setAttribute('data-nav-dropdown', '');

		navGroup.appendChild(trigger);
		navGroup.appendChild(dropdown);
		dom.document.body.appendChild(navGroup);

		const { initNavDropdowns, teardownInteractions } = await import('../src/scripts/interactions.ts');
		initNavDropdowns();

		// Open
		trigger.dispatchEvent(new dom.window.CustomEvent('click'));
		assert.equal(navGroup.classList.contains('is-open'), true, 'Group should be open');

		// Pointerdown outside
		dom.document.dispatchEvent(new dom.window.CustomEvent('pointerdown', { target: outside }));
		assert.equal(navGroup.classList.contains('is-open'), false, 'Group should close on pointerdown outside');

		teardownInteractions();
	} finally {
		dom.uninstall();
	}
});

test('header dropdown closes on focusout when focus moves outside', async () => {
	const dom = installTestDom();
	setupMatchMedia(dom.window, true);
	try {
		const outside = dom.document.createElement('button');
		outside.setAttribute('id', 'outside');
		dom.document.body.appendChild(outside);

		const navGroup = dom.document.createElement('li');
		navGroup.className = 'nav-group';
		navGroup.setAttribute('data-nav-group', '');

		const trigger = dom.document.createElement('button');
		trigger.type = 'button';
		trigger.className = 'nav-group__trigger';
		trigger.setAttribute('data-nav-dropdown-trigger', '');
		trigger.setAttribute('aria-expanded', 'false');
		trigger.setAttribute('aria-controls', 'nav-dropdown-projects');
		trigger.textContent = 'Projects';

		const dropdown = dom.document.createElement('div');
		dropdown.className = 'nav-dropdown';
		dropdown.setAttribute('id', 'nav-dropdown-projects');
		dropdown.setAttribute('data-nav-dropdown', '');

		navGroup.appendChild(trigger);
		navGroup.appendChild(dropdown);
		dom.document.body.appendChild(navGroup);

		const { initNavDropdowns, teardownInteractions } = await import('../src/scripts/interactions.ts');
		initNavDropdowns();

		// Open
		trigger.dispatchEvent(new dom.window.CustomEvent('click'));
		assert.equal(navGroup.classList.contains('is-open'), true);

		// Focusout event where relatedTarget is outside
		const focusoutEvent = new dom.window.CustomEvent('focusout');
		(focusoutEvent as any).relatedTarget = outside;
		navGroup.dispatchEvent(focusoutEvent);

		assert.equal(navGroup.classList.contains('is-open'), false, 'Group should close when focus moves outside');

		teardownInteractions();
	} finally {
		dom.uninstall();
	}
});
