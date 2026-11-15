# Spike: one UI codebase for web, iOS and Android?

Architecture §12.7 step 2. The question was whether a single React Native
(Expo) codebase can carry the hardest screen — a timeline that opens on today,
scrolls into past and future, loads more at both ends without jumping, keeps a
sticky date and has a composer — on all three platforms.

**Answer: not with React Native's own list on web. Recommendation: share
`@agnte/core`, keep two UIs** (the existing Next.js web client, and a native
Expo app). §12.6 already named this as the fallback.

Expo SDK 58, React Native 0.88, react-native-web 0.21. Measured on the web
export in headless Chromium at a Pixel 7 viewport. **Nothing here was run on
iOS or Android** — there is no simulator or device in the build environment.

## What worked

- `@agnte/core` is consumed unchanged by Metro (see `metro.config.js`): tokens,
  string tables, `headerLabel`, `timeLabel`, `placementOf`. The shared package
  does its job, and that part of the plan is settled.
- The app typechecks, bundles for web (542 KB of JS) and renders; the composer
  adds a row.

## What did not, on web

All three with `FlatList`, the list React Native ships:

1. **`maintainVisibleContentPosition` does not exist in react-native-web.**
   It is the one prop that holds the page still when older rows are added
   above. On web it is silently ignored.
2. **`initialScrollIndex` without fixed row heights rendered a page that could
   not scroll** — five rows, no overflow. Verses have no fixed height.
3. **The manual fix for (1) is fed wrong numbers.** The usual compensation
   (remember content height, shift the offset by the growth) needs the height
   to change only when rows are prepended. The list windows by *estimated*
   heights, so the height moved by −44 px to +857 px between samples with
   nothing prepended, tracked rows unmounted mid-measurement, and one prepend
   moved the reader by 5,107 px. Turning windowing off
   (`disableVirtualization`) did not fix it: rows still mount in batches and
   the opening jump to today stopped landing.

## What was not tried

- Third-party lists that advertise web support and prepend anchoring
  (FlashList, Legend List). They might close the gap; that is a second spike,
  and it would make the hardest screen depend on a library's web support.
- A hand-written web list inside the Expo app (plain `ScrollView` plus the
  browser's own measurements). That works — it is what the Next.js client
  already does — but then the screen is written twice anyway, and the web copy
  gives up server rendering and the existing service worker and offline queue.

## Why two UIs rather than pushing on

The web timeline already exists, is tested, and does the three things above
correctly using the DOM directly. Replacing it means re-solving them on a
layer that hides the DOM. The native app has no such history and gets the one
prop for free. The cost of two UIs is drawing each screen twice; what keeps
that honest is how much lives in `core` — the parser, date reading, timeline
arithmetic, strings, tokens and the offline queue's rules — so the two UIs
differ in layout code and not in behaviour.

## Before trusting the native half

Open this app in Expo Go on a phone (`npm install`, `npx expo start`, scan the
code) and check, by hand: it opens on Today; scrolling up loads older days
without the page moving; the date header sticks; the composer stays above the
keyboard. Those four are the claims this spike could not test.
