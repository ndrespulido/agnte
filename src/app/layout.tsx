import type { Metadata, Viewport } from 'next';
import { dark, light } from '@/shared/design/tokens';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agnte',
  description: 'A timeline for your life.',
  appleWebApp: { capable: true, title: 'Agnte', statusBarStyle: 'default' },
  // Preview environments are publicly reachable so they can be opened on a
  // phone. Keep them out of search results.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  /*
   * The glass header sits under the notch on a phone, so the page has to reach
   * into the safe area rather than stopping short of it — the sheet adds its
   * own bottom inset back in.
   */
  viewportFit: 'cover',
  /*
   * Follows the palette. Declared for both schemes so the browser chrome
   * matches the page rather than flashing white behind a dark timeline.
   */
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: light.paper },
    { media: '(prefers-color-scheme: dark)', color: dark.paper },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
