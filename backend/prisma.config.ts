import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 no longer reads the connection URL from schema.prisma.
// The CLI (migrate, db seed) uses DIRECT_URL; the running app uses DATABASE_URL via the pg adapter.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DIRECT_URL'),
  },
});
