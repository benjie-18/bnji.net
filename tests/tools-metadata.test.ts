/**
 * BNJI.NET — /tools/ Image Metadata Inspector & Remover tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './support/dom.mjs';
import {
	checkMetadataFile,
	extractImageMetadata,
	stripMetadataBinary,
} from '../src/scripts/tools-metadata.ts';

type Dom = ReturnType<typeof installTestDom>;
type MetadataModule = typeof import('../src/scripts/tools-metadata.ts');

let metaModule: MetadataModule | null = null;

async function metadata(): Promise<MetadataModule> {
	if (!metaModule) metaModule = await import('../src/scripts/tools-metadata.ts');
	return metaModule;
}

function buildMetadataComponent(dom: Dom): void {
	const { document } = dom;
	const section = document.createElement('section');
	section.setAttribute('data-image-metadata', '');

	const hooks: Record<string, string> = {
		'data-metadata-source': 'input',
		'data-metadata-drop': 'div',
		'data-metadata-strip': 'button',
		'data-metadata-download': 'button',
		'data-metadata-reset': 'button',
		'data-metadata-status': 'p',
		'data-metadata-error': 'p',
		'data-metadata-results': 'div',
		'data-metadata-list': 'div',
		'data-metadata-clean-info': 'p',
	};

	for (const [hook, tag] of Object.entries(hooks)) {
		const element = document.createElement(tag);
		element.setAttribute(hook, '');
		section.appendChild(element);
	}

	document.body.appendChild(section);
}

const MB = 1024 * 1024;

test('checkMetadataFile accepts supported formats', () => {
	for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/tiff']) {
		assert.deepEqual(checkMetadataFile({ name: 'photo.img', type, size: 1024 }), { ok: true });
	}
});

test('checkMetadataFile rejects unsupported formats', () => {
	for (const type of ['application/pdf', 'video/mp4', 'text/plain', '']) {
		const res = checkMetadataFile({ name: 'file', type, size: 1024 });
		assert.equal(res.ok, false);
		if (!res.ok) assert.match(res.message, /not supported/);
	}
});

test('checkMetadataFile rejects empty or oversized files', () => {
	assert.equal(checkMetadataFile({ name: 'empty.jpg', type: 'image/jpeg', size: 0 }).ok, false);
	assert.equal(checkMetadataFile({ name: 'huge.jpg', type: 'image/jpeg', size: 30 * MB }).ok, false);
});

test('extractImageMetadata extracts PNG text chunks', () => {
	// Construct minimal PNG with tEXt chunk
	const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	// tEXt chunk: length 12, 'tEXt', Title\0Hello
	const chunkLength = [0x00, 0x00, 0x00, 0x0b];
	const chunkType = Array.from(Buffer.from('tEXt'));
	const chunkData = Array.from(Buffer.from('Title\0Hello'));
	const crc = [0x00, 0x00, 0x00, 0x00];

	const bytes = new Uint8Array([...header, ...chunkLength, ...chunkType, ...chunkData, ...crc]);
	const result = extractImageMetadata(bytes.buffer, 'image/png');

	assert.equal(result.hasMetadata, true);
	assert.equal(result.tags.length, 1);
	assert.match(result.tags[0].label, /PNG Text/);
});

test('stripMetadataBinary removes PNG tEXt chunks', () => {
	const header = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	const chunkLength = [0x00, 0x00, 0x00, 0x0b];
	const chunkType = Array.from(Buffer.from('tEXt'));
	const chunkData = Array.from(Buffer.from('Title\0Hello'));
	const crc = [0x00, 0x00, 0x00, 0x00];

	const bytes = new Uint8Array([...header, ...chunkLength, ...chunkType, ...chunkData, ...crc]);
	const clean = stripMetadataBinary(bytes.buffer, 'image/png');

	const cleanResult = extractImageMetadata(clean.buffer as unknown as ArrayBuffer, 'image/png');
	assert.equal(cleanResult.hasMetadata, false);
	assert.equal(clean.byteLength, 8); // Only PNG signature remaining
});

test('destroyImageMetadata releases bound event listeners', async () => {
	const dom = installTestDom();
	buildMetadataComponent(dom);
	const { initImageMetadata, destroyImageMetadata } = await metadata();

	initImageMetadata();
	const before = dom.listenerCount();

	destroyImageMetadata();
	const after = dom.listenerCount();
	assert.ok(after < before);

	initImageMetadata();
	assert.equal(dom.listenerCount(), before);
	destroyImageMetadata();
});

test('initImageMetadata is idempotent', async () => {
	const dom = installTestDom();
	buildMetadataComponent(dom);
	const { initImageMetadata, destroyImageMetadata } = await metadata();

	initImageMetadata();
	const once = dom.listenerCount();
	initImageMetadata();
	assert.equal(dom.listenerCount(), once);
	destroyImageMetadata();
});
