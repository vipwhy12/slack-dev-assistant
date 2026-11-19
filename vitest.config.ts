import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Implemented repositories are nested under storageDir; they have their own Docker verifier.
    include: ['tests/**/*.test.ts'],
    maxWorkers: 4,
    testTimeout: 15_000, // Integration tests create Git repositories/worktrees on disk.
  },
});
