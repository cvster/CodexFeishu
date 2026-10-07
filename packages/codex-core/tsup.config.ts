import { defineConfig } from 'tsup';
export default defineConfig([{
  entry: { index: 'packages/codex-core/src/index.ts' },
  outDir: 'packages/codex-core/dist', format: ['esm'], target: 'node20',
  // Two targets share the directory; neither may erase the other's output.
  platform: 'node', clean: false, splitting: false, dts: true,
  // The web adapter copies this standalone artifact into its upstream tree.
  noExternal: ['cross-spawn', 'ws'],
  banner: { js: "import { createRequire as __coreCreateRequire } from 'node:module'; const require = __coreCreateRequire(import.meta.url);" },
}, {
  entry: { models: 'packages/codex-core/src/models.ts' },
  outDir: 'packages/codex-core/dist', format: ['esm'], target: 'es2020',
  platform: 'browser', clean: false, splitting: false, dts: true,
}]);
