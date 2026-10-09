// Panel build: Preact + own components, compiled into a single HTML file (scripts/publish.js).
// npm run dev   → http://127.0.0.1:5173 with /api pointing to the real panel (127.0.0.1:4777)
//                 and /tests/mock-items.json for the test mode (?mock=1)
// npm run build → ../index.html (the file server.js serves)
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TESTS = path.resolve(HERE, '..', 'tests');

/** In dev, serves the test mode files as tests/serve-mock.js does. */
function mockFiles() {
  const map = {
    '/tests/mock-items.json': 'mock-items.json',
  };
  return {
    name: 'mock-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = map[(req.url || '').split('?')[0]];
        if (!name) return next();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(fs.readFileSync(path.join(TESTS, name)));
      });
    },
  };
}

export default defineConfig({
  plugins: [preact(), mockFiles()],
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 1_000_000, // fonts become data: inside the CSS (the CSP only accepts 'self' and data:)
    cssCodeSplit: false,
    modulePreload: false,
    reportCompressedSize: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // The server requires Host 127.0.0.1:4777 and, on POST, an Origin of the panel itself.
      '/api': { target: 'http://127.0.0.1:4777', changeOrigin: true, headers: { origin: 'http://127.0.0.1:4777' } },
    },
  },
});
