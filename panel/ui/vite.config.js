// Build do painel: Preact + componentes próprios, compilado num HTML único (scripts/publicar.js).
// npm run dev   → http://127.0.0.1:5173 com /api apontando para o painel real (127.0.0.1:4777)
//                 e /tests/mock-*.json para o modo de teste (?mock=1)
// npm run build → ../index.html (o arquivo que o server.js serve)
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const TESTES = path.resolve(AQUI, '..', 'tests');

/** No dev, serve os arquivos do modo de teste como o tests/serve-mock.js faz. */
function arquivosDoMock() {
  const mapa = {
    '/tests/mock-state.json': 'mock-state.json',
    '/tests/mock-details.json': 'mock-details.json',
  };
  return {
    name: 'arquivos-do-mock',
    configureServer(servidor) {
      servidor.middlewares.use((req, res, seguir) => {
        const nome = mapa[(req.url || '').split('?')[0]];
        if (!nome) return seguir();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(fs.readFileSync(path.join(TESTES, nome)));
      });
    },
  };
}

export default defineConfig({
  plugins: [preact(), arquivosDoMock()],
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 1_000_000, // fontes viram data: dentro do CSS (a CSP só aceita 'self' e data:)
    cssCodeSplit: false,
    modulePreload: false,
    reportCompressedSize: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // O servidor exige Host 127.0.0.1:4777 e, no POST, Origin do próprio painel.
      '/api': { target: 'http://127.0.0.1:4777', changeOrigin: true, headers: { origin: 'http://127.0.0.1:4777' } },
    },
  },
});
