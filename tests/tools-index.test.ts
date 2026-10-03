/**
 * /tools/ repertory: the categories the data promises, the hooks the script
 * binds, and the filtering that keeps fourteen tools off one scroll.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Three things can drift apart here, and none of them fails a build:
 *
 *   1. src/data/tools.ts lists a tool the page never renders (the index would
 *      link to nothing), or renders it under a different name;
 *   2. scripts/tools-index.ts queries a hook the components stopped rendering —
 *      the exact failure tests/tools-markup.test.ts exists for, in a new pair of
 *      files;
 *   3. the filtering itself: a category that hides the wrong section, a shortcut
 *      that fires while the visitor is typing a "1" into the word counter, a
 *      deep link that lands on a hidden tool.
 *
 * The first two are checked against the real sources. The third runs the real
 * controller in jsdom against a fixture that mirrors the two components, which
 * is honest only because check 2 proves the fixture's hooks are the real ones.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import { TOOL_CATEGORIES, TOOLS, TOOL_COUNT } from '../src/data/tools';
import { destroyToolsIndex, initToolsIndex } from '../src/scripts/tools-index';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const REPERTORY = 'src/components/tools/ToolsRepertory.astro';
const GROUP = 'src/components/tools/ToolGroup.astro';
const PAGE = 'src/pages/tools.astro';
const SCRIPT = 'src/scripts/tools-index.ts';

/* --- 1. the data, the components and the page agree ----------------------- */

test('every tool in the repertory is a section on the page, named the same', () => {
	const components = readdirSync(new URL('../src/components/tools', import.meta.url))
		.filter((name) => name.endsWith('.astro'))
		.map((name) => ({ name, markup: read(`src/components/tools/${name}`) }));

	for (const tool of TOOLS) {
		const owners = components.filter((file) =>
			new RegExp(`\\sid="${tool.id}"`).test(file.markup),
		);
		assert.equal(owners.length, 1, `${tool.id} should be rendered by exactly one component`);

		// The heading is what a visitor scans, so the index and the tool must
		// say the same thing — and the heading sits on one line so this stays
		// readable to a grep as well as to a test.
		const heading = /<h3 class="tool__title"[^>]*>\s*([^<]+?)\s*<\/h3>/.exec(owners[0]!.markup);
		assert.ok(heading, `${owners[0]!.name} has no tool__title heading for ${tool.id}`);
		assert.equal(heading![1], tool.name, `${tool.id} is titled differently than the index says`);

		// And the page must actually mount it: the map in tools.astro is typed
		// against ToolId, but this catches an entry deleted from the map by hand.
		assert.match(read(PAGE), new RegExp(`'${tool.id}':`), `${tool.id} is not mounted by ${PAGE}`);
	}

	assert.equal(TOOLS.length, TOOL_COUNT, 'the count the page prints is the count it lists');
});

test('the repertory data is a set: no tool in two categories, no key twice', () => {
	const ids = TOOLS.map((tool) => tool.id);
	assert.equal(new Set(ids).size, ids.length, 'a tool appears in two categories');

	const keys = TOOL_CATEGORIES.map((category) => category.shortcut);
	assert.equal(new Set(keys).size, keys.length, 'two categories share a shortcut key');
	for (const key of keys) assert.match(key, /^\d$/, 'a shortcut is a single digit, printed as-is');

	const indexes = TOOL_CATEGORIES.map((category) => category.index);
	assert.equal(new Set(indexes).size, indexes.length, 'two categories share an index');

	for (const category of TOOL_CATEGORIES) {
		assert.ok(category.tools.length > 0, `${category.id} is an empty category`);
		assert.equal(category.label, category.title.toUpperCase(), 'the eyebrow is the title in caps');
	}
});

/* --- 2. the script and the components agree ------------------------------ */

/** Every attribute selector a controller looks up, as in tools-markup.test.ts. */
function selectorsIn(source: string): string[] {
	const pattern = /querySelector(?:All)?(?:<[^>]*>)?\(\s*'\[([\w-]+)\]'/g;
	const found = new Set<string>();
	for (const match of source.matchAll(pattern)) found.add(match[1]!);
	return [...found].sort();
}

test('every selector the index controller queries exists in its components', () => {
	const markup = read(REPERTORY) + read(GROUP);
	const selectors = selectorsIn(read(SCRIPT));
	assert.ok(selectors.length >= 3, 'the index controller queries nothing');

	for (const selector of selectors) {
		const present = new RegExp(`\\s${selector}(=|\\s|>)`).test(markup);
		assert.ok(present, `no component renders ${selector}, which ${SCRIPT} binds`);
	}

	// The classes and the <kbd> the script reads text out of, which a data-hook
	// check cannot see.
	for (const needle of ['tools-repertory__cat-name', 'tool-group__tools', '<kbd']) {
		assert.ok(markup.includes(needle), `the index controller reads ${needle}, and nothing renders it`);
	}
});

/* --- 3. the real controller in a real DOM -------------------------------- */

/**
 * The two components' markup, reduced to the hooks and the shape the controller
 * works on: a repertory with chips (each carrying the key it prints) and two
 * links per category, over two sections of two tools each.
 */
const FIXTURE = `
<section class="tools-repertory" id="tools-repertory" data-tools-repertory>
	<nav class="tools-repertory__cats" aria-label="Tool categories">
		<a class="tools-repertory__cat" href="#tools-list" data-tools-cat="all" aria-current="true">
			<kbd class="tools-repertory__cat-key mono" aria-hidden="true">0</kbd>
			<span class="tools-repertory__cat-name">All</span>
			<span class="tools-repertory__cat-count mono">4</span>
		</a>
		<a class="tools-repertory__cat" href="#cat-images" data-tools-cat="images">
			<kbd class="tools-repertory__cat-key mono" aria-hidden="true">1</kbd>
			<span class="tools-repertory__cat-name">Images &amp; color</span>
			<span class="tools-repertory__cat-count mono">2</span>
		</a>
		<a class="tools-repertory__cat" href="#cat-text" data-tools-cat="text">
			<kbd class="tools-repertory__cat-key mono" aria-hidden="true">2</kbd>
			<span class="tools-repertory__cat-name">Text &amp; lists</span>
			<span class="tools-repertory__cat-count mono">2</span>
		</a>
	</nav>
	<div class="tools-repertory__grid">
		<div class="tools-repertory__group" data-tools-group-links="images">
			<ul class="tools-repertory__list">
				<li><a class="tools-repertory__link" href="#image-converter" data-tools-link="image-converter">Image converter</a></li>
				<li><a class="tools-repertory__link" href="#color-picker" data-tools-link="color-picker">Color picker</a></li>
			</ul>
		</div>
		<div class="tools-repertory__group" data-tools-group-links="text">
			<ul class="tools-repertory__list">
				<li><a class="tools-repertory__link" href="#word-counter" data-tools-link="word-counter">Word counter</a></li>
				<li><a class="tools-repertory__link" href="#text-diff" data-tools-link="text-diff">Text diff</a></li>
			</ul>
		</div>
	</div>
	<p class="sr-only" role="status" data-tools-live>All 4 tools are listed.</p>
</section>
<div class="tools-list" id="tools-list">
	<section class="tool-group" id="cat-images" data-tool-group="images">
		<div class="tool-group__tools">
			<section class="tool" id="image-converter"></section>
			<section class="tool" id="color-picker"></section>
		</div>
	</section>
	<section class="tool-group" id="cat-text" data-tool-group="text">
		<div class="tool-group__tools">
			<section class="tool" id="word-counter"><textarea data-word-text></textarea></section>
			<section class="tool" id="text-diff"></section>
		</div>
	</section>
</div>`;

/*
 * ONE jsdom for the whole file, reset between tests.
 *
 * A fresh JSDOM per test costs a real second of CPU on a small machine, and the
 * suite runs its files in parallel: thirteen of them were enough to push an
 * unrelated, timing-sensitive test (dm-client's 30ms ticks) over its budget.
 * Resetting the document is as honest here — every test starts from the same
 * markup, and the controller's listeners are torn down by destroyToolsIndex()
 * before the next test asks for a fresh binding.
 */
let shared: JSDOM | null = null;
let scrolled: Element[] = [];

function indexDom(hash = ''): JSDOM {
	if (!shared) {
		shared = new JSDOM(`<!doctype html><html><body>${FIXTURE}</body></html>`, {
			url: 'http://localhost:4321/tools/',
		});
		/*
		 * jsdom implements no scrolling and says so by not defining the method at
		 * all. The controller scrolls to a category when a key or a deep link asks
		 * for it; stubbing it keeps that path runnable here, and the stub records
		 * what was scrolled to so the tests can assert it.
		 */
		scrolled = [];
		shared.window.Element.prototype.scrollIntoView = function (this: Element) {
			scrolled.push(this);
		};
	}

	const dom = shared;
	dom.window.document.body.innerHTML = FIXTURE;
	dom.window.history.replaceState(null, '', `/tools/${hash}`);
	scrolled.length = 0;

	const g = globalThis as Record<string, unknown>;
	g.window = dom.window;
	g.document = dom.window.document;
	g.location = dom.window.location;
	/*
	 * One realm, as in a browser: the controller tears its listeners down with an
	 * AbortSignal, and jsdom rejects one from Node's realm.
	 */
	g.AbortController = dom.window.AbortController;
	return dom;
}

function mount(t: { after(fn: () => void): void }, _dom: JSDOM): void {
	initToolsIndex();
	// The window outlives the test; the controller must not.
	t.after(() => destroyToolsIndex());
}

const group = (dom: JSDOM, id: string): HTMLElement => {
	const node = dom.window.document.querySelector<HTMLElement>(`[data-tool-group="${id}"]`);
	assert.ok(node, `the fixture lost ${id}`);
	return node;
};

const chip = (dom: JSDOM, id: string): HTMLElement => {
	const node = dom.window.document.querySelector<HTMLElement>(`[data-tools-cat="${id}"]`);
	assert.ok(node, `the fixture lost the ${id} chip`);
	return node;
};

const live = (dom: JSDOM): string =>
	(dom.window.document.querySelector('[data-tools-live]')?.textContent ?? '').trim();

const click = (dom: JSDOM, node: Element): void => {
	node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
};

const press = (dom: JSDOM, key: string, target?: Element, init?: { ctrlKey?: boolean }): void => {
	const event = new dom.window.KeyboardEvent('keydown', {
		key,
		bubbles: true,
		cancelable: true,
		ctrlKey: init?.ctrlKey ?? false,
	});
	(target ?? dom.window.document.body).dispatchEvent(event);
};

const scrolledTo = (): Element[] => scrolled;

test('with nothing clicked every category is on the page, and "All" is current', (t) => {
	const dom = indexDom();
	mount(t, dom);
	assert.equal(group(dom, 'images').hidden, false);
	assert.equal(group(dom, 'text').hidden, false);
	assert.equal(chip(dom, 'all').getAttribute('aria-current'), 'true');
	assert.equal(chip(dom, 'images').getAttribute('aria-current'), null);
	assert.match(live(dom), /All 4 tools are listed/);
});

test('choosing a category shows that category and hides the others', (t) => {
	const dom = indexDom();
	mount(t, dom);
	click(dom, chip(dom, 'text'));

	assert.equal(group(dom, 'text').hidden, false, 'the chosen category stays');
	assert.equal(group(dom, 'images').hidden, true, 'the others are hidden, not merely dimmed');
	assert.equal(chip(dom, 'text').getAttribute('aria-current'), 'true');
	assert.equal(chip(dom, 'all').getAttribute('aria-current'), null, 'one current chip, not two');
	assert.match(live(dom), /Text & lists: 2 tools shown/, 'and the change is announced');

	click(dom, chip(dom, 'all'));
	assert.equal(group(dom, 'images').hidden, false, '"All" brings everything back');
	assert.equal(group(dom, 'text').hidden, false);
	assert.match(live(dom), /All 4 tools are listed/);
});

test('a tool link opens its own category', (t) => {
	const dom = indexDom();
	mount(t, dom);
	const link = dom.window.document.querySelector('[data-tools-link="word-counter"]');
	assert.ok(link);
	click(dom, link);

	assert.equal(group(dom, 'text').hidden, false);
	assert.equal(group(dom, 'images').hidden, true, 'the link is a shortcut to the tool, not to the page');
	assert.equal(chip(dom, 'text').getAttribute('aria-current'), 'true');
});

test('the digits switch category, and scroll to the one they opened', (t) => {
	const dom = indexDom();
	mount(t, dom);
	press(dom, '1');

	assert.equal(group(dom, 'images').hidden, false);
	assert.equal(group(dom, 'text').hidden, true);
	assert.deepEqual(scrolledTo(), [group(dom, 'images')], 'the key lands the visitor in the category');

	press(dom, '0');
	assert.equal(group(dom, 'text').hidden, false, '0 is "All"');
	assert.equal(scrolledTo().length, 1, 'and "All" does not move the page out from under the visitor');
});

test('a digit typed into a tool is a digit, not a category change', (t) => {
	const dom = indexDom();
	mount(t, dom);
	const textarea = dom.window.document.querySelector('[data-word-text]');
	assert.ok(textarea);

	press(dom, '1', textarea);
	assert.equal(group(dom, 'text').hidden, false, 'typing in the word counter stays in the word counter');
	assert.equal(group(dom, 'images').hidden, false);

	press(dom, '1', undefined, { ctrlKey: true });
	assert.equal(group(dom, 'images').hidden, false, 'a modified digit belongs to the browser');

	press(dom, '9');
	assert.equal(group(dom, 'images').hidden, false, 'a key nothing claims does nothing');
});

test('a deep link to a hidden tool opens its category and scrolls to it', (t) => {
	const dom = indexDom();
	mount(t, dom);

	// Someone filtered, then followed a link to a tool in the other category.
	click(dom, chip(dom, 'text'));
	assert.equal(group(dom, 'images').hidden, true);

	dom.window.location.hash = '#color-picker';
	dom.window.dispatchEvent(new dom.window.Event('hashchange'));

	assert.equal(group(dom, 'images').hidden, false, 'the tool the URL names is reachable');
	assert.equal(group(dom, 'text').hidden, true);
	assert.deepEqual(
		scrolledTo().at(-1),
		group(dom, 'images'),
		'the browser could not scroll to a hidden section, so the controller does',
	);
});

test('a hash that is not a tool leaves everything visible', (t) => {
	const dom = indexDom('#tools-repertory');
	mount(t, dom);
	assert.equal(group(dom, 'images').hidden, false);
	assert.equal(group(dom, 'text').hidden, false);
	assert.equal(chip(dom, 'all').getAttribute('aria-current'), 'true');
});

test('landing on #cat-text opens that category', (t) => {
	const dom = indexDom('#cat-text');
	mount(t, dom);
	assert.equal(group(dom, 'text').hidden, false);
	assert.equal(group(dom, 'images').hidden, true);
	assert.equal(chip(dom, 'text').getAttribute('aria-current'), 'true');
});

test('teardown leaves the page whole, and a second init binds again', (t) => {
	const dom = indexDom();
	initToolsIndex();
	click(dom, chip(dom, 'text'));
	assert.equal(group(dom, 'images').hidden, true);

	destroyToolsIndex();
	assert.equal(group(dom, 'images').hidden, false, 'a stopped controller hides nothing');

	click(dom, chip(dom, 'text'));
	assert.equal(group(dom, 'images').hidden, false, 'and nothing is listening any more');

	initToolsIndex();
	click(dom, chip(dom, 'text'));
	assert.equal(group(dom, 'images').hidden, true, 'a second init works on the same subtree');

	t.after(() => destroyToolsIndex());
});

test('the page without the script is the whole catalogue', () => {
	// No init(): this is the JavaScript-off page. Nothing may be hidden, because
	// the only thing that hides a section is the controller.
	const dom = indexDom();
	// The attribute, not the word: the chips carry aria-hidden on their key caps.
	assert.doesNotMatch(
		dom.window.document.body.innerHTML,
		/\s(?:hidden)(?:=|\s|>)/,
		'no section is hidden in the markup itself',
	);
	for (const id of ['images', 'text']) assert.equal(group(dom, id).hidden, false);
	for (const tool of ['image-converter', 'color-picker', 'word-counter', 'text-diff']) {
		assert.ok(dom.window.document.getElementById(tool), `${tool} is in the document`);
	}
});
