import { loadConfig } from './config';

/**
 * Email transport (architecture.md §3: Resend).
 *
 * Shared infrastructure rather than something identity owns: `notifications`
 * needs the same wire in Phase 7, and a transport carries no domain meaning.
 * What each module says in its emails stays with that module — see identity's
 * IdentityMailer, which owns the templates.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailTransport {
  readonly description: string;
  send(message: EmailMessage): Promise<void>;
}

/**
 * Local development: print it.
 *
 * `npm run dev` has to work with no Resend account (architecture.md §7.1), and
 * a verification link printed to the terminal is genuinely more convenient to
 * click than one that has to survive a round trip through a real inbox.
 */
export class ConsoleEmailTransport implements EmailTransport {
  readonly description = 'console';

  async send(message: EmailMessage): Promise<void> {
    console.info(
      [
        '',
        '── email ──────────────',
        `to:      ${message.to}`,
        `subject: ${message.subject}`,
        '',
        message.text,
        '───────────────────────',
        '',
      ].join('\n'),
    );
  }
}

/**
 * Resend over plain fetch rather than their SDK.
 *
 * One POST to one endpoint does not need a dependency, and a dependency here
 * would have to be kept current for the life of the project. If retries or
 * batching are ever wanted, that is the moment to reconsider — not before.
 */
export class ResendEmailTransport implements EmailTransport {
  readonly description = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });

    if (!response.ok) {
      // The body carries Resend's reason (unverified domain, invalid address).
      // The recipient is not included: this string ends up in logs, and an
      // address in a log is personal data sitting somewhere it was not meant to.
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Resend rejected the message (${response.status}): ${detail.slice(0, 300)}`,
      );
    }
  }
}

let cached: EmailTransport | undefined;

/**
 * Console locally, Resend when configured.
 *
 * Returns undefined only when a deployed environment has no email configured at
 * all — which the health check reports rather than discovering at the moment
 * someone tries to register.
 */
export function getEmailTransport(): EmailTransport | undefined {
  if (cached) return cached;

  const config = loadConfig();

  if (config.RESEND_API_KEY && config.EMAIL_FROM) {
    cached = new ResendEmailTransport(config.RESEND_API_KEY, config.EMAIL_FROM);
    return cached;
  }

  if (config.APP_ENV === 'local') {
    cached = new ConsoleEmailTransport();
    return cached;
  }

  return undefined;
}

/** Test seam: forget the memoised transport so a test can vary process.env. */
export function resetEmailTransportForTests(): void {
  cached = undefined;
}
