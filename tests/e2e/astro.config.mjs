import { defineConfig } from 'astro/config';
import { fileURLToPath } from 'node:url';

// Browser UI tests need Astro's page renderer, not Cloudflare bindings or a
// remote dev proxy. Worker/runtime checks use the repository's normal config.
export default defineConfig({
	root: fileURLToPath(new URL('../../', import.meta.url)),
	output: 'static',
	server: { host: '0.0.0.0', port: 4321, strictPort: true },
	vite: { server: { allowedHosts: true } },
});
