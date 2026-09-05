import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agnte — deployment status',
  description: 'Phase 0 status page: proves the deployment path end to end.',
  // Preview environments are publicly reachable so they can be opened on a
  // phone. Keep them out of search results.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
