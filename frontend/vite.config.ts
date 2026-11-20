import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Third-party code in chunks of its own, which load with the pages that need
 * them — matched by module path, not given as package names. Given names,
 * Rollup moves each package's whole dependency tree into its chunk: `clsx`,
 * which every component uses, went into the charts chunk with Recharts, so the
 * first visit to any page, the sign-in page included, downloaded all of the
 * charts (430 kB) for it; and React's JSX runtime went into the animation one.
 * Listed here are only the packages nothing but their chunk's library uses.
 */
const VENDOR_CHUNKS: [string, RegExp][] = [
  // With React, which loads first anyway: the two tiny helpers the app and the
  // charts share, so Rollup cannot leave them in the charts chunk on its own.
  ['vendor-react', /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|@remix-run[\\/]router|clsx|tiny-invariant)[\\/]/],
  [
    'vendor-charts',
    /[\\/]node_modules[\\/](recharts|recharts-scale|react-smooth|victory-vendor|d3-[^\\/]+|internmap|decimal\.js-light|fast-equals|lodash|eventemitter3|react-is|prop-types|react-transition-group|dom-helpers)[\\/]/,
  ],
  ['vendor-motion', /[\\/]node_modules[\\/](framer-motion|motion-dom|motion-utils)[\\/]/],
  ['vendor-dnd', /[\\/]node_modules[\\/]@dnd-kit[\\/]/],
];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
    // One copy for the whole app. Every Radix part pins its own exact version of
    // this package, so npm gives each its own copy, and with it its own React
    // context: none of them saw the DirectionProvider in PreferenceEffects. In
    // Arabic everything inside a tab was laid out left to right, and menus and
    // selects opened to the wrong side, on a page reading right to left.
    dedupe: ['@radix-ui/react-direction'],
  },
  server: { port: 5173, host: true },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          for (const [name, pattern] of VENDOR_CHUNKS) if (pattern.test(id)) return name;
          return undefined;
        },
      },
    },
  },
});
