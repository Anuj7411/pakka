import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    /**
     * Above vitest's 5s default because corpus generation is genuinely slow —
     * ~2.5s for a 30-mandate corpus, and mutation testing instruments every
     * line, which pushes it past 5s.
     *
     * Found by whole-repo mutation testing failing its dry run: the generator
     * tests timed out, so Stryker refused to start and the largest module in
     * the project had never actually been mutation tested. A timeout that only
     * bites under instrumentation hides exactly the coverage you were trying
     * to measure.
     */
    testTimeout: 30_000,
  },
});
