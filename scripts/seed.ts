/**
 * Creates a signed-in-able account for local development.
 *
 * `npm run dev` works with no data, but every protected route needs a user, and
 * walking register → open the terminal → click the verification link before
 * each session is friction that gets skipped. This does it in one step.
 *
 * Refuses to run outside local development. A seeded account with a published
 * password is the kind of thing that quietly becomes a production account, and
 * the check is cheaper than the incident.
 *
 *   npm run seed
 *   npm run seed -- --email me@example.com --password 'something longer'
 */
import { parseArgs } from 'node:util';
import { systemClock } from '../src/shared/kernel';
import { loadConfig } from '../src/shared/infra/config';
import { getDatabase } from '../src/shared/infra/database';
import { parseEmail } from '../src/modules/identity/domain/email';
import { parsePassword } from '../src/modules/identity/domain/password';
import { createVerifiedUser } from '../src/modules/identity/domain/user';
import { Argon2PasswordHasher } from '../src/modules/identity/infrastructure/argon2-password-hasher';
import { PrismaUserRepository } from '../src/modules/identity/infrastructure/prisma-user-repository';

const DEFAULT_EMAIL = 'dev@agnte.local';
const DEFAULT_PASSWORD = 'development password';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      password: { type: 'string' },
    },
  });

  const config = loadConfig();
  if (config.APP_ENV !== 'local') {
    console.error(
      `Refusing to seed: APP_ENV is "${config.APP_ENV}".\n` +
        'This creates an account with a known password. It is for local development only.',
    );
    process.exitCode = 1;
    return;
  }

  const database = getDatabase();
  if (!database) {
    console.error(
      'No DATABASE_URL. Seeding needs a database:\n' +
        '  createdb agnte && export DATABASE_URL=postgresql://localhost:5432/agnte\n' +
        '  npx prisma migrate deploy',
    );
    process.exitCode = 1;
    return;
  }

  const email = parseEmail(values.email ?? DEFAULT_EMAIL);
  if (!email.ok) {
    console.error(email.error.message);
    process.exitCode = 1;
    return;
  }

  const password = parsePassword(values.password ?? DEFAULT_PASSWORD);
  if (!password.ok) {
    console.error(password.error.message);
    process.exitCode = 1;
    return;
  }

  const users = new PrismaUserRepository();

  // Idempotent: re-running should be a no-op, not an error. A seed you cannot
  // run twice is a seed you stop running.
  const existing = await users.findByEmail(email.value);
  if (existing) {
    console.log(`Already seeded: ${existing.email} (${existing.id})`);
    await database.$disconnect();
    return;
  }

  const user = createVerifiedUser({
    email: email.value,
    passwordHash: await new Argon2PasswordHasher().hash(password.value),
    displayName: 'Local Developer',
    clock: systemClock,
  });

  const created = await users.create(user);
  if (created.kind === 'email-taken') {
    // Another process won the race between the check above and this insert.
    console.log(`Already seeded: ${email.value}`);
    await database.$disconnect();
    return;
  }

  console.log(
    [
      'Seeded a verified account:',
      `  email:    ${user.email}`,
      `  password: ${values.password ?? DEFAULT_PASSWORD}`,
      '',
      'Sign in with:',
      `  curl -s localhost:3000/v1/auth/login -H 'content-type: application/json' \\`,
      `    -d '${JSON.stringify({ email: user.email, password: values.password ?? DEFAULT_PASSWORD })}'`,
    ].join('\n'),
  );

  await database.$disconnect();
}

await main();
