import { config } from 'dotenv';

config({ path: '.env.test', override: true, quiet: true });
process.env.NODE_ENV = 'test';

if (process.env.ALLOW_DB_RESET !== 'true') {
  throw new Error(
    'Refusing to run e2e tests: copy .env.test.example to .env.test, point it at a throwaway database, ' +
      'and keep ALLOW_DB_RESET=true. The suite deletes all data in that database.',
  );
}
