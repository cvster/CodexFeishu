import { defineConfig } from 'tsup';
export default defineConfig({
  entry: { index: 'packages/codex-core/src/index.ts' },
  outDir: 'packages/codex-core/dist', format: ['esm'], target: 'node20',
  platform: 'node', clean: true, splitting: false, dts: true,
  // The web adapter copies this standalone artifact into its upstream tree.
  noExternal: ['cross-spawn', 'ws'],
  banner: { js: "import { createRequire as __coreCreateRequire } from 'node:module'; const require = __coreCreateRequire(import.meta.url);" },
});
