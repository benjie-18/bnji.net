/**
 * BNJI.NET — the admin playlist panel's behaviour.
 *
 * The routes are covered in admin-playlist-api.test.ts; this file covers the
 * panel that drives them: the two-step resolve-then-edit flow, the
 * provider-dependent date field, the in-flight state of a row's controls, and
 * the recovery path when a provider returns nothing at all.
 *
 * Same DOM shim as the player tests, with one addition: a request can be held
 * mid-flight, because "the controls are disabled while the request runs" is
 * only observable before it finishes.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installTestDom } from './support/dom.mjs';

type Dom = ReturnType<typeof installTestDom>;
type PanelModule = typeof import('../src/scripts/admin-playlist.ts');

let panelModule: PanelModule | null = null;
let active: Dom | null = null;

async function panel(): Promise<PanelModule> {
	if (!panelModule) panelModule = await import('../src/scripts/admin-playlist.ts');
	return panelModule;
}

const ITEM = {
	id: 'item-1',
	position: 0,
	title: 'the feeling',
	artist: 'benji',
	album: 'Songs',
	provider: 'file',
	url: '/music/the feeling.mp3',
};

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		provider: 'youtube',
		id: 'dQw4w9WgXcQ',
		url: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
		source: 'youtube-oembed',
		status: 'partial',
		message: 'Resolved from YouTube oEmbed (limited). Only a title came back.',
		fields: { title: 'a video' },
		artistIsSuggestion: false,
		lookups: [],
		...overrides,
	};
}

/** The panel's markup, mirroring src/pages/admin/index.astro. */
function buildPanel(dom: Dom): ReturnType<Dom['q']> {
	const { document } = dom;
	const section = document.createElement('section');
	section.setAttribute('data-panel', 'playlist');

	const importCard = document.createElement('div');
	const importForm = document.createElement('form');
	importForm.setAttribute('data-playlist-import', '');
	const url = document.createElement('input');
	url.setAttribute('data-playlist-url', '');
	url.value = 'https://youtu.be/dQw4w9WgXcQ';
	importForm.appendChild(url);
	importForm.appendChild(document.createElement('button')).setAttribute('data-playlist-resolve', '');
	importCard.appendChild(importForm);
	const lookup = document.createElement('p');
	lookup.setAttribute('data-playlist-lookup', '');
	lookup.hidden = true;
	importCard.appendChild(lookup);
	section.appendChild(importCard);

	const draftForm = document.createElement('form');
	draftForm.setAttribute('data-playlist-draft', '');
	draftForm.hidden = true;
	const note = document.createElement('p');
	note.setAttribute('data-playlist-draft-note', '');
	draftForm.appendChild(note);
	for (const attribute of [
		'data-playlist-draft-provider',
		'data-playlist-draft-url',
		'data-playlist-draft-title',
		'data-playlist-draft-artist',
		'data-playlist-draft-album',
		'data-playlist-draft-date',
	]) {
		const input = document.createElement('input');
		input.setAttribute(attribute, '');
		draftForm.appendChild(input);
	}
	const dateLabel = document.createElement('span');
	dateLabel.setAttribute('data-playlist-date-label', '');
	draftForm.appendChild(dateLabel);
	const dateHint = document.createElement('p');
	dateHint.setAttribute('data-playlist-date-hint', '');
	draftForm.appendChild(dateHint);
	const error = document.createElement('p');
	error.setAttribute('data-playlist-error', '');
	error.hidden = true;
	draftForm.appendChild(error);
	for (const attribute of ['data-playlist-save', 'data-playlist-discard']) {
		const button = document.createElement('button');
		button.setAttribute(attribute, '');
		draftForm.appendChild(button);
	}
	section.appendChild(draftForm);

	const listCard = document.createElement('div');
	const table = document.createElement('div');
	table.setAttribute('data-playlist-table', '');
	listCard.appendChild(table);
	section.appendChild(listCard);

	dom.document.body.appendChild(section);
	return section;
}

/** Boot the panel with a playlist already loaded. */
async function bootPanel(
	items: unknown[],
	initialized = true,
): Promise<{ dom: Dom; said: string[]; failed: string[] }> {
	const dom = installTestDom({ responses: [{ items, initialized, count: items.length }] });
	const said: string[] = [];
	const failed: string[] = [];
	const { startAdminPlaylist } = await panel();
	const actions = startAdminPlaylist(buildPanel(dom) as unknown as HTMLElement, {
		say: (text) => void said.push(text),
		fail: (message) => void failed.push(message),
	});
	await actions.load();
	await dom.settle();
	active = dom;
	return { dom, said, failed };
}

/** Paste a link, resolve it against `payload`, and settle. */
async function resolve(dom: Dom, payload: unknown, status = 200): Promise<void> {
	dom.pushResponse('pending');
	dom.q('[data-playlist-import]')!.dispatchEvent({ type: 'submit', preventDefault: () => {} });
	await dom.settle();
	dom.resolveNext(payload, status);
	await dom.settle();
}

/** Submit the draft form and settle. */
async function save(dom: Dom, payload: unknown, status = 200): Promise<void> {
	dom.pushResponse('pending');
	dom.q('[data-playlist-draft]')!.dispatchEvent({ type: 'submit', preventDefault: () => {} });
	await dom.settle();
	dom.resolveNext(payload, status);
	await dom.settle();
}

/** The `<td>`s of one rendered row, by row index. */
const cells = (dom: Dom, index: number): any[] =>
	dom.q('[data-playlist-table] table tbody')!.childNodes[index]?.childNodes ?? [];

/** One row's control group (move up, move down, remove). */
const controls = (dom: Dom, index: number): any[] => cells(dom, index)[7]?.childNodes[0]?.childNodes ?? [];

afterEach(() => {
	active?.uninstall();
	active = null;
});

/* --- the saved list ------------------------------------------------------- */

test('the saved list renders in the stored order, with the ends disabled', async () => {
	const { dom, said } = await bootPanel([
		ITEM,
		{
			...ITEM,
			id: 'item-2',
			position: 1,
			title: 'a video',
			provider: 'youtube',
			url: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
			publishedAt: '2024-05-01',
		},
		{
			...ITEM,
			id: 'item-3',
			position: 2,
			title: 'another video',
			provider: 'youtube',
			url: 'https://youtu.be/aaaaaaaaaaa',
		},
	]);

	assert.equal(dom.qAll('[data-playlist-table] table tbody tr').length, 3);
	// Order comes from the API, which is `ORDER BY position`.
	assert.deepEqual(
		[0, 1, 2].map((index) => cells(dom, index)[1]?.textContent),
		['the feeling', 'a video', 'another video'],
	);
	// A video's upload date is labelled "Published", and a row with neither
	// date nor metadata shows an em dash rather than a blank cell. There is
	// exactly one date field in the model, so there is exactly one label.
	assert.deepEqual(
		[0, 1, 2].map((index) => cells(dom, index)[4]?.textContent),
		['—', 'Published 2024-05-01', '—'],
	);
	assert.deepEqual(
		[0, 1, 2].map((index) => cells(dom, index)[5]?.textContent),
		['file', 'youtube', 'youtube'],
	);
	assert.deepEqual(said, ['3 in the playlist']);

	// The move buttons at each end are disabled, and say why.
	assert.equal(controls(dom, 0)[0]?.disabled, true, 'the first row cannot move up');
	assert.match(controls(dom, 0)[0]?.title ?? '', /already at the top/);
	assert.equal(controls(dom, 0)[1]?.disabled, false);
	assert.equal(controls(dom, 2)[1]?.disabled, true, 'the last row cannot move down');
	assert.match(controls(dom, 2)[1]?.title ?? '', /already at the end/);
});

test('an empty playlist explains that nothing will be restored', async () => {
	const { dom, said } = await bootPanel([]);
	assert.match(dom.q('[data-playlist-table]')!.textContent ?? '', /The playlist is empty/);
	assert.equal(dom.qAll('[data-playlist-table] table').length, 0);
	assert.deepEqual(said, ['Playlist is empty']);
});

test('a not-yet-seeded playlist says the first save seeds it', async () => {
	const { dom } = await bootPanel([], false);
	assert.match(dom.q('[data-playlist-table]')!.textContent ?? '', /has not been seeded yet/);
});

test('a move disables its row while the request is in flight', async () => {
	const { dom } = await bootPanel([
		ITEM,
		{ ...ITEM, id: 'item-2', position: 1, title: 'a video' },
		{ ...ITEM, id: 'item-3', position: 2, title: 'a track' },
	]);
	dom.pushResponse('pending');

	const rowControls = controls(dom, 1);
	rowControls[0]?.dispatchEvent({ type: 'click' });
	await dom.settle();

	// The request is in flight, so every control on that row is disabled: a
	// second click cannot queue a second move on the same row.
	assert.equal(dom.heldCount(), 1);
	for (const control of rowControls) assert.equal(control.disabled, true, 'row controls must be busy');
	assert.equal(dom.fetchCalls.at(-1)?.init.method, 'PATCH');
	assert.deepEqual(JSON.parse(String(dom.fetchCalls.at(-1)?.init.body)), { id: 'item-2', direction: 'up' });

	dom.resolveNext({ ok: true, items: [] });
	await dom.settle();
	for (const control of rowControls) assert.equal(control.disabled, false, 'row controls must be live again');
});

test('a remove asks for the id in the query string', async () => {
	const { dom, said } = await bootPanel([ITEM, { ...ITEM, id: 'item-2', position: 1, title: 'a video' }]);
	dom.pushResponse('pending');

	controls(dom, 0)[2]?.dispatchEvent({ type: 'click' });
	await dom.settle();
	assert.equal(dom.heldCount(), 1);

	dom.resolveNext({ ok: true, count: 1 });
	await dom.settle();
	const removed = dom.fetchCalls.filter((call) => call.init.method === 'DELETE').at(-1);
	assert.match(removed?.url ?? '', /^\/api\/admin\/playlist\?id=item-1$/);
	assert.deepEqual(said, ['2 in the playlist', 'Removed “the feeling”']);
});

test('a 409 reloads the list and says it changed underneath the panel', async () => {
	const { dom, failed } = await bootPanel([ITEM, { ...ITEM, id: 'item-2', position: 1, title: 'a video' }]);
	dom.pushResponse('pending');

	controls(dom, 0)[0]?.dispatchEvent({ type: 'click' });
	await dom.settle();
	dom.resolveNext({ error: 'invalid_order', items: [] }, 409);
	await dom.settle();

	assert.deepEqual(failed, ['The playlist changed while you were looking at it; it has been reloaded.']);
	// The recovery path is a re-read, not a stale table.
	assert.ok(dom.fetchCalls.some((call) => call.url === '/api/admin/playlist' && !call.init.method));
});

/* --- resolve: link -> editable draft -------------------------------------- */

test('a resolved draft opens every field for editing, with the provider date', async () => {
	const { dom } = await bootPanel([ITEM]);
	dom.pushResponse('pending');

	dom.q('[data-playlist-import]')!.dispatchEvent({ type: 'submit', preventDefault: () => {} });
	await dom.settle();
	assert.equal(dom.heldCount(), 1);
	assert.deepEqual(JSON.parse(String(dom.fetchCalls.at(-1)?.init.body)), {
		url: 'https://youtu.be/dQw4w9WgXcQ',
	});
	assert.match(dom.q('[data-playlist-lookup]')!.textContent ?? '', /Resolving metadata/);
	assert.equal(dom.q('[data-playlist-import]')!.getAttribute('aria-busy'), 'true');

	dom.resolveNext({ draft: draft() });
	await dom.settle();

	assert.equal(dom.q('[data-playlist-draft]')!.hidden, false, 'the draft form must open');
	assert.equal(dom.q('[data-playlist-draft-title]')!.value, 'a video');
	assert.equal(dom.q('[data-playlist-draft-url]')!.value, 'https://youtube.com/watch?v=dQw4w9WgXcQ');
	assert.equal(dom.q('[data-playlist-date-label]')!.textContent, 'Publication date (optional)');
	assert.match(dom.q('[data-playlist-date-hint]')!.textContent ?? '', /Published/);
	assert.match(dom.q('[data-playlist-draft-note]')!.textContent ?? '', /Only the title is required/);
	assert.equal(dom.q('[data-playlist-import]')!.getAttribute('aria-busy'), null);
	assert.match(dom.q('[data-playlist-lookup]')!.textContent ?? '', /Only a title came back/);
});

test('a channel name is offered as a suggestion, not as credited metadata', async () => {
	const { dom } = await bootPanel([ITEM]);
	await resolve(
		dom,
		{
			draft: draft({
				status: 'ok',
				source: 'youtube-data-api',
				message: 'Resolved from the YouTube Data API.',
				fields: { title: 'a video', artist: 'Some Channel', publishedAt: '2024-05-01' },
				artistIsSuggestion: true,
			}),
		},
	);
	assert.match(dom.q('[data-playlist-lookup]')!.textContent ?? '', /channel name — a suggestion/);
	assert.equal(dom.q('[data-playlist-draft-artist]')!.value, 'Some Channel');
});

test('an unusable provider still opens the form for manual entry', async () => {
	const { dom } = await bootPanel([ITEM]);
	await resolve(dom, {
		draft: draft({
			provider: 'youtube',
			id: 'dQw4w9WgXcQ',
			url: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
			source: 'manual',
			status: 'unavailable',
			message:
				'No provider credentials are configured for this link. Enter the title and any details you want, then save.',
			fields: {},
		}),
	});

	// Every field is blank and editable: a link plus a title is a complete item.
	assert.equal(dom.q('[data-playlist-draft]')!.hidden, false);
	assert.equal(dom.q('[data-playlist-draft-title]')!.value, '');
	assert.equal(dom.q('[data-playlist-draft-artist]')!.value, '');
	assert.equal(dom.q('[data-playlist-draft-album]')!.value, '');
	assert.equal(dom.q('[data-playlist-draft-date]')!.value, '');
	assert.equal(dom.q('[data-playlist-date-label]')!.textContent, 'Publication date (optional)');
	assert.match(dom.q('[data-playlist-date-hint]')!.textContent ?? '', /Published/);
	assert.match(dom.q('[data-playlist-lookup]')!.textContent ?? '', /No provider credentials/);
});

test('a rejected link is reported in the panel, and no draft opens', async () => {
	const { dom } = await bootPanel([ITEM]);
	await resolve(dom, { error: 'invalid_link', message: 'Only https:// links are accepted.' }, 400);

	assert.equal(dom.q('[data-playlist-error]')!.hidden, false);
	assert.match(dom.q('[data-playlist-error]')!.textContent ?? '', /not a supported YouTube video URL/);
	assert.equal(dom.q('[data-playlist-draft]')!.hidden, true);
	assert.equal(dom.q('[data-playlist-lookup]')!.hidden, true);
});

/* --- save: draft -> stored item ------------------------------------------- */

test('a save sends the provider date to the provider field', async () => {
	const { dom, said } = await bootPanel([ITEM]);
	await resolve(dom, {
		draft: draft({
			provider: 'youtube',
			id: 'dQw4w9WgXcQ',
			url: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
			source: 'youtube-oembed',
			message: 'Resolved from YouTube oEmbed (title only).',
			fields: { title: 'a video' },
		}),
	});

	dom.q('[data-playlist-draft-artist]')!.value = 'Someone';
	dom.q('[data-playlist-draft-date]')!.value = '2019-11-15';
	await save(dom, { ok: true, item: {}, count: 2 });

	const posted = dom.fetchCalls.filter((call) => call.init.method === 'POST').at(-1);
	assert.deepEqual(JSON.parse(String(posted?.init.body)), {
		url: 'https://youtube.com/watch?v=dQw4w9WgXcQ',
		title: 'a video',
		artist: 'Someone',
		album: '',
		publishedAt: '2019-11-15',
	});
	assert.equal(dom.q('[data-playlist-draft]')!.hidden, true, 'the draft closes after a save');
	assert.equal(dom.q('[data-playlist-url]')!.value, '', 'the import form is reset');
	assert.deepEqual(said, ['1 in the playlist', 'Saved “a video”']);
});

test('a save without a title is refused in the panel, not by the server', async () => {
	const { dom } = await bootPanel([ITEM]);
	await resolve(dom, {
		draft: draft({ source: 'manual', status: 'unavailable', message: 'Enter the title.', fields: {} }),
	});

	const before = dom.fetchCalls.length;
	dom.q('[data-playlist-draft]')!.dispatchEvent({ type: 'submit', preventDefault: () => {} });
	await dom.settle();
	assert.equal(dom.fetchCalls.length, before, 'no request is sent without a title');
	assert.match(dom.q('[data-playlist-error]')!.textContent ?? '', /A title is required/);
});

test('a full playlist is reported as the operator condition it is', async () => {
	const { dom } = await bootPanel([ITEM]);
	await resolve(dom, { draft: draft() });
	await save(dom, { error: 'playlist_full', message: 'The playlist already holds 100 items.' }, 422);

	assert.match(dom.q('[data-playlist-error]')!.textContent ?? '', /The playlist is full/);
	assert.equal(dom.q('[data-playlist-draft]')!.hidden, false, 'the draft stays open so it can be retried');
});

test('discarding a draft closes it and leaves the list alone', async () => {
	const { dom } = await bootPanel([ITEM]);
	await resolve(dom, { draft: draft() });

	dom.q('[data-playlist-discard]')!.dispatchEvent({ type: 'click' });
	assert.equal(dom.q('[data-playlist-draft]')!.hidden, true);
	assert.equal(dom.q('[data-playlist-lookup]')!.hidden, true);
	assert.equal(dom.qAll('[data-playlist-table] table tbody tr').length, 1, 'the stored list is untouched');
});
