/**
 * Prisma CLI configuration (Prisma 7).
 *
 * The connection URL lives here rather than in `schema.prisma`, which is where Prisma 7
 * expects it for `migrate`, `db` and `introspect`. The application runtime does not read
 * this file -- it builds its own connection through a driver adapter in
 * `src/lib/prisma.ts`.
 */
import { config as loadDotenv } from 'dotenv';
import { defineConfig, env } from 'prisma/config';

// The CLI runs outside the application bootstrap, so `.env` has to be loaded explicitly.
loadDotenv({ path: '.env', override: false, quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
