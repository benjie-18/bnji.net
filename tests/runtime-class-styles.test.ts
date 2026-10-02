/**
 * Astro scopes a page's <style> block by stamping `data-astro-cid-…` onto the
 * elements it compiles from the template. A node a client script creates never
 * carries that attribute, so a scoped rule for it silently never matches: the
 * row renders unstyled and nothing errors. That is exactly how the chess board
 * lost its squares (`src/scripts/games/chess.ts` paints them), the friends and
 * messages lists lost their rows, and the room chat lost its layout.
 *
 * The rule this test enforces: every class a client script can create must be
 * styled either by a plain stylesheet (no scope attribute by definition) or by
 * `:global(...)` inside a component/page style block.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

function listFiles(dir: string, extension: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
		if (entry.isDirectory()) out.push(...listFiles(`${dir}/${entry.name}`, extension));
		else if (entry.name.endsWith(extension)) out.push(`${dir}/${entry.name}`);
	}
	return out;
}

function read(path: string): string {
	return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

/** Classes a script can put on a node: className = '…', class="…" in markup
 *  strings, and classList.add/remove/toggle('…'). Interpolations are dropped,
 *  so `admin__badge--${tone}` is checked as its literal prefix. */
function createdClasses(source: string): Set<string> {
	const out = new Set<string>();
	const add = (raw: string): void => {
		for (const token of raw.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
			if (/^[a-z][a-z0-9_-]*$/.test(token)) out.add(token);
		}
	};
	for (const match of source.matchAll(/className\s*=\s*(?:`([^`]*)`|'([^']*)'|"([^"]*)")/g)) {
		add(match[1] ?? match[2] ?? match[3] ?? '');
	}
	for (const match of source.matchAll(/class="([^"]*)"/g)) add(match[1] ?? '');
	for (const match of source.matchAll(/classList\.(?:add|remove|toggle)\('([^']+)'\)/g)) add(match[1] ?? '');
	return out;
}

/** Selector preludes from a stylesheet, ignoring braces inside declarations. */
function preludes(css: string): string[] {
	const out: string[] = [];
	let buffer = '';
	for (const char of css) {
		if (char === '{') {
			out.push(buffer.trim());
			buffer = '';
		} else if (char === '}') {
			buffer = '';
		} else {
			buffer += char;
		}
	}
	return out;
}

function mentions(selector: string, className: string): boolean {
	const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`\\.${escaped}(?![\\w-])`).test(selector);
}

function globalsIn(selector: string): string {
	return [...selector.matchAll(/:global\(([^)]*)\)/g)].map((match) => match[1] ?? '').join(', ');
}

const dynamic = new Set<string>();
for (const file of listFiles('src/scripts', '.ts')) {
	for (const className of createdClasses(read(file))) dynamic.add(className);
}

/** Plain stylesheets are never scoped, so a rule there always reaches a
 *  script-created node. */
const globalSheets = new Set(listFiles('src/styles', '.css'));
const styleOwners = [
	...listFiles('src/components', '.astro'),
	...listFiles('src/pages', '.astro'),
	...listFiles('src/layouts', '.astro'),
];

test('the audit has something to audit (guards against a vacuous pass)', () => {
	assert.ok(dynamic.size > 20, `expected script-created classes, found ${dynamic.size}`);
	assert.ok(globalSheets.size > 5, `expected stylesheets, found ${globalSheets.size}`);
	assert.ok(styleOwners.length > 10, `expected style owners, found ${styleOwners.length}`);
	assert.ok(dynamic.has('chess-square') && dynamic.has('dm-msg') && dynamic.has('friends-row'));
});

test('a class a script creates is never styled through Astro scoping alone', () => {
	const offenders: string[] = [];
	for (const file of styleOwners) {
		const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(read(file))?.[1];
		if (!style) continue;
		for (const selector of preludes(style)) {
			if (selector.startsWith('@')) continue;
			const globals = globalsIn(selector);
			for (const className of dynamic) {
				if (!mentions(selector, className)) continue;
				if (mentions(globals, className)) continue;
				offenders.push(`${file}: .${className} in "${selector.slice(0, 80)}"`);
			}
		}
	}
	assert.deepEqual(offenders, []);
});

test('the classes the rework named are covered globally', () => {
	const sample = ['chess-square', 'ms-cell', 'dm-msg', 'dm-list__name', 'friends-row', 'room-tools__chat-item', 'player-tools__save'];
	for (const className of sample) {
		assert.ok(dynamic.has(className), `${className} should still be created by a script`);
		const inSheet = [...globalSheets].filter((file) => preludes(read(file)).some((selector) => !selector.startsWith('@') && mentions(selector, className)));
		const viaGlobal = styleOwners.filter((file) => {
			const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(read(file))?.[1];
			return style ? mentions(globalsIn(style), className) : false;
		});
		assert.ok(inSheet.length + viaGlobal.length > 0, `no global styling found for .${className}`);
	}
});
