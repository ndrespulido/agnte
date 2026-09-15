import { ResetPassword } from '../_client/ResetPassword';

export const metadata = { title: 'Set a new password — Agnte' };

/**
 * Where a reset email actually lands.
 *
 * `password-reset-routes.ts` has always mailed a link to `/reset-password`,
 * and until now nothing served that path — so every reset link ever sent
 * arrived at a 404, with the working endpoint sitting one level down at
 * `/v1/auth/reset-password` where no email pointed.
 *
 * Dynamic for the same reason the app shell is: the CSP mints a nonce per
 * request, and a statically built page has none to carry.
 */
export const dynamic = 'force-dynamic';

export default function ResetPasswordPage() {
  return <ResetPassword />;
}
