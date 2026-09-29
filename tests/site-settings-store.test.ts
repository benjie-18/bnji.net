import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSettings, DYNAMIC_SETTINGS_DEFAULTS } from '../src/server/site-settings-store';

describe('site-settings-store', () => {
	it('returns defaults when given empty input', () => {
		const result = sanitizeSettings({});
		assert.deepEqual(result, DYNAMIC_SETTINGS_DEFAULTS);
	});

	it('clamps numeric bounds correctly', () => {
		const result = sanitizeSettings({
			boardMaxTextLength: 99999, // max 1000
			boardPostCooldownSeconds: -50, // min 0
			boardHourlyPostLimit: 0, // min 1
		});
		assert.equal(result.boardMaxTextLength, 1000);
		assert.equal(result.boardPostCooldownSeconds, 0);
		assert.equal(result.boardHourlyPostLimit, 1);
	});

	it('sanitizes strings and dropdown selections', () => {
		const result = sanitizeSettings({
			boardProvider: 'invalid-provider',
			dmProvider: 'discord',
			siteName: '  Test Site Name  ',
			defaultTheme: 'light',
		});
		assert.equal(result.boardProvider, 'd1'); // falls back to d1
		assert.equal(result.dmProvider, 'discord');
		assert.equal(result.siteName, 'Test Site Name');
		assert.equal(result.defaultTheme, 'light');
	});
});
