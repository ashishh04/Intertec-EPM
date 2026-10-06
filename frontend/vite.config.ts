import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Identifies this build. The browser's persisted query cache is discarded when
 * it changes (src/lib/queryPersister.ts), so a response whose shape changed in
 * this build is never restored into components written for the new one. CI may
 * set EPM_BUILD_ID to the release; otherwise the moment of building, which in
 * development means each start of the dev server.
 */
const BUILD_ID = process.env.EPM_BUILD_ID || new Date().toISOString();

export default defineConfig({
  define: { __EPM_BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: { port: 5173, host: true },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-charts': ['recharts'],
          'vendor-motion': ['framer-motion'],
          'vendor-dnd': ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
        },
      },
    },
  },
});
