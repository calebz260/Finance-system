/**
 * Loads `backend/.env` into `process.env` before any configuration is read.
 *
 * Imported for its side effect at the top of `env.ts`, which guarantees it runs first
 * (ES module imports are evaluated in order). Real deployments inject environment
 * variables directly and simply have no `.env` file -- `dotenv` is a no-op then, and
 * existing variables are never overwritten, so a container's configuration always wins.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadDotenv } from 'dotenv';

const currentDir = dirname(fileURLToPath(import.meta.url));

// `src/config` in development, `dist/config` once built -- the backend root is two up.
const backendRoot = resolve(currentDir, '..', '..');

const envFile = resolve(backendRoot, '.env');
if (existsSync(envFile)) {
  loadDotenv({ path: envFile, override: false, quiet: true });
}
