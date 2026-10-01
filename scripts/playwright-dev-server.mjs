import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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

// Spawn the astro CLI's JS entry with this Node binary directly instead of
// `npm run astro`. On Windows, npm resolves to a `npm.cmd` shim, and Node
// refuses to spawn .cmd/.bat files without a shell (EINVAL since the
// CVE-2024-27980 hardening in Node 18.20/20.12/21.7+), which killed
// `npm run test:e2e` under PowerShell. The direct spawn is portable, needs no
// shell, and delivers SIGINT/SIGTERM straight to the dev server on teardown.
const astroBin = (() => {
	const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../node_modules/astro/package.json', import.meta.url)), 'utf8'));
	const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.astro;
	if (!bin) throw new Error('astro package.json has no "bin.astro" entry');
	return fileURLToPath(new URL(`../node_modules/astro/${bin}`, import.meta.url));
})();
const server = spawn(process.execPath, [astroBin, 'dev', '--config', 'tests/e2e/astro.config.mjs', '--host', '0.0.0.0', '--port', '4321', '--strictPort'], {
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
