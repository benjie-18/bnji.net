import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixture = new URL('../tests/e2e/fixtures/game-shell.astro', import.meta.url);
const route = new URL('../src/pages/playwright-game-shell.astro', import.meta.url);
const marker = new URL('../.astro/playwright-fixture.created', import.meta.url);
if (existsSync(marker)) {
	if (existsSync(route)) unlinkSync(route);
	unlinkSync(marker);
}
if (existsSync(route)) throw new Error('Refusing to overwrite an existing playwright-game-shell.astro route.');
mkdirSync(new URL('../.astro/', import.meta.url), { recursive: true });
copyFileSync(fixture, route);
writeFileSync(marker, 'temporary Playwright route');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const server = spawn(npm, ['run', 'astro', '--', 'dev', '--config', 'tests/e2e/astro.config.mjs', '--host', '0.0.0.0', '--port', '4321', '--strictPort'], {
	cwd: fileURLToPath(new URL('..', import.meta.url)),
	stdio: 'inherit',
});
let cleaned = false;
const cleanup = () => {
	if (cleaned) return;
	cleaned = true;
	if (existsSync(marker)) {
		if (existsSync(route)) unlinkSync(route);
		unlinkSync(marker);
	}
};

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, () => {
		server.kill(signal);
		cleanup();
	});
}
server.once('error', (error) => {
	cleanup();
	console.error(error);
	process.exitCode = 1;
});
server.once('exit', (code, signal) => {
	cleanup();
	process.exitCode = signal ? 1 : code ?? 1;
});
