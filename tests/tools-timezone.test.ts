/**
 * BNJI.NET — /tools/ Time Zone Converter tests.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { installTestDom } from './support/dom.mjs';
import {
	convertTimeZone,
	formatInZone,
	formatTimeZoneOffset,
	calculateZoneDifference,
} from '../src/scripts/tools-timezone.ts';

type Dom = ReturnType<typeof installTestDom>;
type TimeZoneModule = typeof import('../src/scripts/tools-timezone.ts');

let tzModule: TimeZoneModule | null = null;

async function getModule(): Promise<TimeZoneModule> {
	if (!tzModule) tzModule = await import('../src/scripts/tools-timezone.ts');
	return tzModule;
}

function buildFixture(dom: Dom): void {
	const { document } = dom;
	const section = document.createElement('section');
	section.setAttribute('data-timezone-converter', '');

	const hooks: Record<string, string> = {
		'data-timezone-input': 'input',
		'data-timezone-source': 'select',
		'data-timezone-target': 'select',
		'data-timezone-swap': 'button',
		'data-timezone-now': 'button',
		'data-timezone-copy': 'button',
		'data-timezone-status': 'p',
		'data-timezone-error': 'p',
		'data-timezone-results': 'div',
		'data-timezone-target-output': 'p',
		'data-timezone-diff-output': 'p',
	};

	for (const [hook, tag] of Object.entries(hooks)) {
		const el = document.createElement(tag);
		el.setAttribute(hook, '');
		section.appendChild(el);
	}

	document.body.appendChild(section);
}

test('convertTimeZone converts date string between source and target time zones', () => {
	const res = convertTimeZone('2026-06-15T12:00', 'UTC', 'America/New_York');
	assert.equal(res.ok, true);
	if (!res.ok) return;
	assert.ok(res.formattedSource.includes('2026'));
	assert.ok(res.formattedTarget.includes('2026'));
	assert.ok(res.timeDiffLabel.includes('hrs relative to source') || res.timeDiffLabel === 'Same time');
});

test('convertTimeZone rejects empty or invalid datetime input', () => {
	const emptyRes = convertTimeZone('', 'UTC', 'America/New_York');
	assert.equal(emptyRes.ok, false);
	if (!emptyRes.ok) assert.match(emptyRes.error, /enter or select a date/i);

	const invalidRes = convertTimeZone('invalid-date', 'UTC', 'America/New_York');
	assert.equal(invalidRes.ok, false);
});

test('formatTimeZoneOffset returns offset representation', () => {
	const d = new Date('2026-01-01T00:00:00Z');
	const offsetUtc = formatTimeZoneOffset(d, 'UTC');
	assert.ok(offsetUtc.includes('UTC'));
});

test('calculateZoneDifference calculates relative hour difference', () => {
	const d = new Date('2026-01-01T00:00:00Z');
	const same = calculateZoneDifference(d, 'UTC', 'UTC');
	assert.equal(same, 'Same time');

	const diff = calculateZoneDifference(d, 'UTC', 'America/New_York');
	assert.ok(diff.includes('hrs relative to source'));
});

test('destroyTimeZoneConverter releases listeners and is idempotent', async () => {
	const dom = installTestDom();
	buildFixture(dom);
	const { initTimeZoneConverter, destroyTimeZoneConverter } = await getModule();

	initTimeZoneConverter();
	const before = dom.listenerCount();
	destroyTimeZoneConverter();
	const after = dom.listenerCount();

	assert.ok(after < before, 'destroy freed event listeners');

	initTimeZoneConverter();
	assert.equal(dom.listenerCount(), before, 're-init binds same amount');
	destroyTimeZoneConverter();
});
