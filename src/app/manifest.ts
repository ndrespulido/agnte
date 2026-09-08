import type { MetadataRoute } from 'next';
import { light } from '@/shared/design/tokens';

/**
 * The PWA manifest, so the app can be added to a home screen.
 *
 * Generated from the design tokens rather than hard-coded: `theme_color` is
 * what the phone paints around the app — the status bar on Android, the splash
 * background on both — and a hard-coded hex here would be the one copy of the
 * palette nobody remembers to update.
 *
 * Only the light paper is used here: a manifest carries one theme colour, and
 * the per-scheme values live on the viewport export in layout.tsx where a media
 * query can choose between them.
 *
 * `display: standalone` rather than `fullscreen`: the OS clock and battery are
 * worth keeping, and a timeline centred on today is odd next to a hidden clock.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Agnte',
    short_name: 'Agnte',
    description: 'A timeline for your life.',
    start_url: '/timeline',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: light.paper,
    theme_color: light.paper,
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
    ],
  };
}
