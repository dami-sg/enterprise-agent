import { defineConfig, configDefaults } from 'vitest/config';

// The Ink (React) TUI + core are tested under Vitest. The OpenTUI/Solid screen
// in `src/tui-otui` is tested with `bun test` (it imports `bun:test` and needs
// the Solid preload), so exclude it here — run those via `pnpm test:tui`. This
// mirrors `tsconfig.tui.json`, which keeps the same files off the `tsc` path.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'src/tui-otui/**'],
  },
});
