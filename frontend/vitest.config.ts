import { defineConfig, mergeConfig } from 'vitest/config';

// Explicit extension: Vite's native config loader requires it.
import viteConfig from './vite.config.ts';

/**
 * Test configuration layered on top of the real Vite config, so component tests resolve
 * modules and aliases exactly the way the built application does.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      name: 'frontend',
      environment: 'jsdom',
      globals: false,
      setupFiles: ['./src/tests/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      // Tailwind is not needed to assert behaviour, and skipping it keeps runs fast.
      css: false,
    },
  }),
);
