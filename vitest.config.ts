import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/mcp-server/test/**/*.test.ts', 'apps/desktop/src/**/*.test.ts'],
    testTimeout: 20000,
  },
});
