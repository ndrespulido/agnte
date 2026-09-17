/**
 * Mints a VAPID keypair for Web Push (architecture.md §8.4).
 *
 * A VAPID keypair identifies *this application server* to a push service. It is
 * generated once per deployment and then left alone: browsers subscribe against
 * the public key, so rotating it invalidates every existing subscription and
 * every device silently stops receiving reminders until it re-subscribes.
 *
 *   npm run vapid
 *
 * The private key is a secret. The public key is handed to every browser by
 * design, and the subject is a contact address a push service can complain to.
 */
import { generateVapidKeys } from '../src/modules/notifications/infrastructure/web-push';

const subject = process.argv[2] ?? 'mailto:ops@agnte.app';

if (!/^(mailto:|https:)/.test(subject)) {
  console.error('The subject must be a mailto: or https: URL.');
  process.exit(1);
}

const keys = generateVapidKeys(subject);

console.log(`
Generated a VAPID keypair. Store the private key as a secret:

  printf %s '${keys.privateKey}' \\
    | gcloud secrets create agnte-vapid-private-key --data-file=- --project=agnte-prod

Then set all three on the service (the deploy script reads them from there):

  VAPID_PUBLIC_KEY=${keys.publicKey}
  VAPID_PRIVATE_KEY=<from the secret above>
  VAPID_SUBJECT=${subject}

Locally, put them in .env.local.

Rotating these later invalidates every existing subscription: every device
stops receiving reminders until someone opens the app and turns them back on.
Generate once, keep it.
`);
