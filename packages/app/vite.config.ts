import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Direkt auf die Quellen zeigen: Die Workspace-Pakete werden nicht gebaut,
    // sondern von Vite wie eigener Quellcode behandelt. Das spart einen
    // Build-Schritt und macht Änderungen an Engine und Shared sofort sichtbar.
    alias: {
      '@photomaster/shared': resolve(root, 'packages/shared/src/index.ts'),
      '@photomaster/engine': resolve(root, 'packages/engine/src/index.ts'),
    },
  },
  server: {
    // Mit PORT lässt sich ausweichen, wenn 5173 schon von einem anderen
    // Projekt belegt ist. `strictPort` verhindert, dass Vite stattdessen
    // still auf den nächsten Port springt — das wäre 5174, und dort läuft
    // die API, die dann nicht mehr starten könnte.
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
    // Über den Proxy laufen Oberfläche und API auf derselben Herkunft —
    // dadurch braucht der Server kein CORS.
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.PM_PORT || 5174}`,
        changeOrigin: false,
        // Ein Export überträgt bis zu 96 MB und kann je nach Bildgröße dauern.
        timeout: 15 * 60 * 1000,
        proxyTimeout: 15 * 60 * 1000,
      },
    },
    fs: { allow: [root] },
  },
  build: { outDir: 'dist', sourcemap: true, target: 'es2022' },
});
