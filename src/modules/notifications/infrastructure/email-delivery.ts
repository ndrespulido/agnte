import { contactEmailFor } from '@/modules/identity';
import { getEmailTransport } from '@/shared/infra/email';
import { loadConfig } from '@/shared/infra/config';
import type { NotificationDelivery } from '../domain/ports';

/**
 * The one place notifications imports `@/modules/identity` — the same
 * single-file convention verse's MediaModuleAdapter documents.
 *
 * Email is the *fallback* transport in §8.4, and it is built first here on
 * purpose: Resend is already wired and proven, while Web Push needs VAPID keys,
 * a service worker and — on iOS — the PWA installed to the home screen before
 * it delivers anything at all. Shipping the fallback first means the feature
 * works for everyone on day one and push is an improvement on top, rather than
 * the whole feature being gated behind a platform requirement.
 */
export class EmailNotificationDelivery implements NotificationDelivery {
  readonly description = 'email';

  async send(input: {
    userId: string;
    title: string;
    body: string | null;
    verseId: string | null;
  }): Promise<void> {
    const transport = getEmailTransport();
    // Thrown rather than swallowed: the dispatcher counts attempts and decides
    // whether to retry, and it can only do that if failure reaches it.
    if (!transport) throw new Error('No email transport is configured.');

    const to = await contactEmailFor(input.userId);
    if (!to) throw new Error('That user no longer has an address to send to.');

    const origin = loadConfig().APP_BASE_URL?.replace(/\/+$/, '');
    const link = input.verseId && origin ? `${origin}/?verse=${input.verseId}` : null;

    await transport.send({
      to,
      subject: input.title,
      text: [
        input.title,
        ...(input.body ? ['', input.body] : []),
        ...(link ? ['', 'Open it in Agnte:', link] : []),
        '',
        'You set this reminder in Agnte. Change or cancel it from the Reminders screen.',
      ].join('\n'),
    });
  }
}
