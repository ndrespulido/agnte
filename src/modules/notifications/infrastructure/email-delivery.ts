import { contactFor } from '@/modules/identity';
import { getEmailTransport } from '@/shared/infra/email';
import { loadConfig } from '@/shared/infra/config';
import { isLocale, stringsFor, DEFAULT_LOCALE } from '@/shared/i18n';
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

    const contact = await contactFor(input.userId);
    if (!contact) throw new Error('That user no longer has an address to send to.');

    /*
     * The language the *recipient* chose, not the sender's and not the
     * server's. There is no request here to read a header from — this runs
     * from the scheduled tick — which is why identity stores it on the user.
     *
     * An unrecognised value falls back to English rather than throwing: a row
     * written by a newer version of the app that offers a language this
     * instance does not have yet should still get its reminder.
     */
    const s = stringsFor(isLocale(contact.locale) ? contact.locale : DEFAULT_LOCALE);

    const origin = loadConfig().APP_BASE_URL?.replace(/\/+$/, '');
    const link = input.verseId && origin ? `${origin}/?verse=${input.verseId}` : null;

    await transport.send({
      to: contact.email,
      // The title and body are the person's own words, from their own verse,
      // so they are not translated — only the app's sentences around them are.
      subject: input.title,
      text: [
        input.title,
        ...(input.body ? ['', input.body] : []),
        ...(link ? ['', s.email.openInAgnte, link] : []),
        '',
        s.email.reminderFooter,
      ].join('\n'),
    });
  }
}
