import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { readFileSync } from 'fs';
import { join } from 'path';
import pkg from './package.json';

/* WebKit strictly enforces module MIME types. Vite's dev server serves
   .md files as text/markdown (via the mime package), which WebKit rejects
   for module scripts. This plugin fixes it at the HTTP layer — intercepting
   ALL .md requests and serving them as valid JS modules that export the
   raw content string. We handle both ?raw and bare .md requests so the
   static file server never gets a chance to set text/markdown. */
function markdownFallback(): Plugin {
  return {
    name: 'polypore-md-fallback',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url ?? '';
        const qIdx = rawUrl.indexOf('?');
        const pathname = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;

        if (!pathname.endsWith('.md')) {
          next();
          return;
        }

        /* resolve the file: Vite uses /@fs/ prefix for paths outside root */
        const filePath = pathname.startsWith('/@fs/')
          ? decodeURIComponent(pathname.slice(4))
          : join(server.config.root, decodeURIComponent(pathname));

        let content = '';
        try {
          content = readFileSync(filePath, 'utf8');
        } catch {
          /* file unreadable — serve an empty module so WebKit never sees
             text/markdown. the transform hook will also catch build-time
             imports via Rollup. */
        }
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(`export default ${JSON.stringify(content)}`);
      });
    },
    /* belt-and-suspenders: also cover the Rollup transform path.
     * Skip ?raw — Vite's built-in raw transform already produces
     * `export default "..."`, and re-wrapping it would double-escape. */
    transform(code, id) {
      const qIdx = id.indexOf('?');
      const query = qIdx >= 0 ? id.slice(qIdx) : '';
      const bare = qIdx >= 0 ? id.slice(0, qIdx) : id;
      if (bare.endsWith('.md') && !query.includes('raw')) {
        return { code: `export default ${JSON.stringify(code)}`, map: null };
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), markdownFallback()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {},
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/@xterm')) return 'xterm';
          if (id.includes('node_modules/dockview') || id.includes('node_modules/dockview-core')) return 'dockview';
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) return 'react';
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'http://localhost' },
    },
    setupFiles: './src/setupTests.ts',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}', 'plugins/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'build', 'docs/mockups/**'],
  },
});
