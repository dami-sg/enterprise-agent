import { defineConfig } from 'vitest/config';

// The gateway is a plain Node service (no OpenTUI), so a default Vitest config
// suffices — the pure routing / rendering / protocol logic is unit-tested here.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
