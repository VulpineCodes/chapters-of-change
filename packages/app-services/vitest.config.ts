import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Tests run against the domain *sources* (no build step needed) and against
// the single canonical JWT module in the API app, so what is tested here is
// exactly what the NestJS layer ships.
export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@chapters/domain',
        replacement: fileURLToPath(new URL('../domain/src/index.ts', import.meta.url)),
      },
      {
        find: '@api-auth-jwt',
        replacement: fileURLToPath(new URL('../../apps/api/src/auth/jwt.ts', import.meta.url)),
      },
    ],
  },
  test: { include: ['src/**/*.test.ts'] },
});
