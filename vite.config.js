import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Bare module specifiers provided by the Alid host runtime via `<script type="importmap">`.
 */
export const sharedImports = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  '@alid/react',
  '@alid/kernel',
];

export const SHARED_IMPORTS = sharedImports;

function isSharedImport(id) {
  return sharedImports.includes(id);
}

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: false,
    minify: false,
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.js'),
      formats: ['es'],
      fileName: () => 'plugin.js',
    },
    rollupOptions: {
      external: isSharedImport,
      output: {
        codeSplitting: false,
      },
    },
  },
});
