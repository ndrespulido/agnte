/**
 * Design tokens, as data (CLAUDE.md).
 *
 * Plain numbers and strings — no CSS, no styled-components, no React. A future
 * React Native client consumes this exact file, which is only possible if
 * nothing here assumes a browser. That is why spacing is a number of pixels
 * rather than "0.5rem", and why the shadows are described in parts rather than
 * as a CSS shorthand string: `rem` and `box-shadow` are web-only spellings of
 * ideas both platforms have.
 *
 * The CSS custom properties the web uses are *generated* from this file
 * (`css.ts`), and a test fails if the checked-in stylesheet has drifted. Two
 * hand-maintained copies of a palette diverge; the only question is when.
 */

/**
 * Paper-warm neutrals, not pure white (CLAUDE.md). The base is bone rather than
 * #fff and the ink is not black, because a 1990s paper agenda is the reference
 * and paper is never #ffffff under any light.
 */
export interface Palette {
  /** The page. */
  readonly paper: string;
  /** Slightly raised from the page — a card, a section. */
  readonly paperRaised: string;
  /** Body text. */
  readonly ink: string;
  /** Secondary text. Still 4.5:1 against `paper`. */
  readonly inkSoft: string;
  /** Text that may fall to 3:1 — never used for anything that must be read. */
  readonly inkFaint: string;
  /** Hairline rules, which this design uses instead of boxes. */
  readonly rule: string;
  /** The one restrained accent. */
  readonly accent: string;
  /** Accent, for text on `paper`. Darker so it clears 4.5:1. */
  readonly accentText: string;

  /**
   * The translucent base a glass surface sits on. Glass fails WCAG easily
   * (CLAUDE.md), so this is opaque enough that text on it keeps 4.5:1 against
   * whatever scrolls beneath — the blur alone is not a contrast strategy.
   */
  readonly glass: string;
  /** The hairline along a glass edge, which is what makes it read as a pane. */
  readonly glassEdge: string;

  /** The add button: soft vertical silver-to-pewter, no gloss, no bevel. */
  readonly metalTop: string;
  readonly metalBottom: string;
  /** 1px lighter top edge and darker bottom edge. */
  readonly metalEdgeLight: string;
  readonly metalEdgeDark: string;

  readonly ok: string;
  readonly pending: string;
  readonly failed: string;
}

export const light: Palette = {
  paper: '#faf9f6',
  paperRaised: '#ffffff',
  ink: '#1c1c1e',
  inkSoft: '#5c5c62',
  inkFaint: '#8a8a90',
  rule: 'rgba(28, 28, 30, 0.14)',
  accent: '#8a5a2b',
  accentText: '#71481f',
  glass: 'rgba(250, 249, 246, 0.82)',
  glassEdge: 'rgba(28, 28, 30, 0.1)',
  metalTop: '#e8e8e6',
  metalBottom: '#b9b9b6',
  metalEdgeLight: 'rgba(255, 255, 255, 0.85)',
  metalEdgeDark: 'rgba(28, 28, 30, 0.22)',
  ok: '#2f6f4f',
  pending: '#8a6d3b',
  failed: '#9b2c2c',
};

export const dark: Palette = {
  paper: '#141416',
  paperRaised: '#1c1c1f',
  ink: '#ececee',
  inkSoft: '#a6a6ac',
  inkFaint: '#76767c',
  rule: 'rgba(236, 236, 238, 0.16)',
  accent: '#d8a76a',
  accentText: '#e0b47e',
  glass: 'rgba(20, 20, 22, 0.82)',
  glassEdge: 'rgba(236, 236, 238, 0.12)',
  metalTop: '#4a4a4e',
  metalBottom: '#2c2c30',
  metalEdgeLight: 'rgba(255, 255, 255, 0.16)',
  metalEdgeDark: 'rgba(0, 0, 0, 0.45)',
  ok: '#7fbf9a',
  pending: '#d9b370',
  failed: '#e08585',
};

/**
 * A four-based scale. Small enough steps to place a hairline rule deliberately,
 * few enough that a layout cannot drift into arbitrary numbers.
 */
export const space = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

/**
 * Hairlines rather than boxes (CLAUDE.md). 0.5px is a real value on the
 * 2x-and-up screens this is designed for; on a 1x screen the browser rounds it
 * up to 1px, which is the right fallback.
 */
export const hairline = 0.5;

export const radius = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 14,
  pill: 999,
} as const;

/**
 * Body is a humanist sans; the date display carries the character.
 *
 * Stacks rather than a single family, and no webfont: a downloaded face is a
 * render-blocking request on a phone on mobile data, for a design whose whole
 * point is that it feels like paper rather than like a loading screen.
 */
export const fontFamily = {
  body: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', 'Helvetica Neue', sans-serif",
  /**
   * The date. Condensed grotesque where the platform has one, falling back to
   * the typewriter end of the same idea.
   */
  display:
    "'Haettenschweiler', 'Arial Narrow', 'Roboto Condensed', ui-sans-serif, system-ui, sans-serif",
  mono: "ui-monospace, 'SF Mono', 'Cascadia Mono', 'Roboto Mono', monospace",
} as const;

/** Set larger than feels comfortable, per CLAUDE.md — the date is the anchor. */
export const fontSize = {
  micro: 11,
  small: 13,
  body: 16,
  large: 18,
  date: 28,
  dateLarge: 40,
} as const;

export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
} as const;

export const lineHeight = {
  tight: 1.15,
  snug: 1.3,
  normal: 1.5,
} as const;

/** Negative tracking on the display sizes; slight positive on the smallest. */
export const letterSpacing = {
  display: -0.5,
  normal: 0,
  wide: 0.4,
} as const;

/**
 * 150–200ms, ease-out (CLAUDE.md).
 *
 * `reducedMotion` is not a suggestion: every animation in the app reads this
 * and the media query, and a duration of 0 is what an honoured preference
 * looks like.
 */
export const motion = {
  fast: 150,
  normal: 200,
  easeOut: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
  reducedMotion: 0,
} as const;

/**
 * Very soft shadows, described in parts so a native client can rebuild them.
 * No gloss and no bevel anywhere — the metal is a gradient plus two hairline
 * edges, which is what makes it read as anodised paper rather than as a button
 * from 2008.
 */
export const shadow = {
  button: { x: 0, y: 2, blur: 8, spread: 0, color: 'rgba(28, 28, 30, 0.18)' },
  raised: { x: 0, y: 1, blur: 3, spread: 0, color: 'rgba(28, 28, 30, 0.08)' },
} as const;

/** `backdrop-filter: blur(20px)` (CLAUDE.md). */
export const blur = { glass: 20 } as const;

/** Layering, named so nothing invents its own number. */
export const zIndex = {
  base: 0,
  stickyHeader: 10,
  addButton: 20,
  sheet: 30,
} as const;

/**
 * The thumb-reachable size for the add button. 56px is the smallest square that
 * stays comfortable one-handed; the tap target around it is larger still.
 */
export const size = {
  addButton: 56,
  minTapTarget: 44,
} as const;

export const tokens = {
  light,
  dark,
  space,
  hairline,
  radius,
  fontFamily,
  fontSize,
  fontWeight,
  lineHeight,
  letterSpacing,
  motion,
  shadow,
  blur,
  zIndex,
  size,
} as const;

export type Tokens = typeof tokens;
