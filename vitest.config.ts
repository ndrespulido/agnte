import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],

    /**
     * Test files run one at a time.
     *
     * The integration suites share a single Postgres and each clears the tables
     * it works with. Run in parallel workers they delete rows out from under
     * one another, which shows up as a foreign key violation or a concurrency
     * assertion that counts one winner too many — failures that look like
     * application bugs and are not, and that come and go with worker
     * scheduling. A flaky suite is worse than a slow one: it trains you to
     * re-run rather than read.
     *
     * The alternative — a schema per file, or scoping every delete to rows the
     * file created — buys back a second or two on a suite this size and adds a
     * mechanism to every future test. Revisit if the suite gets slow enough to
     * notice.
     */
    fileParallelism: false,
  },
});
