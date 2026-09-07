import type { EmailTransport } from '@/shared/infra/email';
import type { Email } from '../domain/email';
import type { IdentityMailer } from '../domain/ports';

const greeting = (displayName: string | null): string =>
  displayName ? `Hi ${displayName},` : 'Hi,';

/**
 * Identity's email templates, over whatever transport is configured.
 *
 * Plain text only, and no tracking pixels or link wrapping. Both would make the
 * mail heavier, more likely to be treated as spam, and — for an app holding
 * medical notes — would mean a third party learns when someone opened it.
 */
export class TransportIdentityMailer implements IdentityMailer {
  constructor(private readonly transport: EmailTransport) {}

  async sendVerification(input: {
    to: Email;
    displayName: string | null;
    verificationUrl: string;
  }): Promise<void> {
    await this.transport.send({
      to: input.to,
      subject: 'Confirm your Agnte address',
      text: [
        greeting(input.displayName),
        '',
        'Open this link to finish creating your Agnte account:',
        input.verificationUrl,
        '',
        'The link works once and expires in 24 hours.',
        '',
        // Said plainly because it is true, and because it is the difference
        // between a confused recipient and an alarmed one: no account exists
        // yet, so there is nothing for them to secure.
        "If you didn't ask for this, ignore this email. No account has been created.",
      ].join('\n'),
    });
  }

  async sendDuplicateRegistrationNotice(input: {
    to: Email;
    displayName: string | null;
    signInUrl: string;
  }): Promise<void> {
    await this.transport.send({
      to: input.to,
      subject: 'Someone tried to register with your Agnte address',
      text: [
        greeting(input.displayName),
        '',
        'Someone just tried to create an Agnte account with this email address,',
        'but one already exists. Your account and password are unchanged.',
        '',
        'If that was you, sign in instead:',
        input.signInUrl,
        '',
        "If it wasn't, no action is needed — whoever it was learned nothing about",
        'your account, and this message is the only thing that happened.',
      ].join('\n'),
    });
  }

  async sendPasswordReset(input: {
    to: Email;
    displayName: string | null;
    resetUrl: string;
  }): Promise<void> {
    await this.transport.send({
      to: input.to,
      subject: 'Reset your Agnte password',
      text: [
        greeting(input.displayName),
        '',
        'Open this link to choose a new password:',
        input.resetUrl,
        '',
        'The link works once and expires in an hour.',
        '',
        // Worth saying, because it is the reassurance that stops someone
        // panicking, and it is also true: requesting a reset changes nothing.
        "If you didn't ask for this, ignore this email. Your password has not",
        'changed, and this link expires on its own.',
      ].join('\n'),
    });
  }

  async sendPasswordResetForUnknownAddress(input: {
    to: Email;
    registerUrl: string;
  }): Promise<void> {
    await this.transport.send({
      to: input.to,
      subject: 'Password reset requested for Agnte',
      text: [
        'Hi,',
        '',
        'Someone asked to reset the Agnte password for this address, but there is',
        'no account here. You may have signed up with a different address.',
        '',
        'To create an account:',
        input.registerUrl,
        '',
        "If you didn't ask for this, nothing has happened and you can ignore this.",
      ].join('\n'),
    });
  }
}
