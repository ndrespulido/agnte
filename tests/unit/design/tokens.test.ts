import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tokensCss } from '@/shared/design/css';
import { dark, light, motion, tokens, type Palette } from '@/shared/design/tokens';

/**
 * Two things are worth testing about a design system this early: that the
 * generated stylesheet has not drifted from the tokens, and that the palette
 * is actually readable. The second is not a formality — CLAUDE.md says glass
 * fails WCAG easily and that text must stay 4.5:1 against whatever scrolls
 * beneath, which is a claim a test can hold to.
 */

const CSS_PATH = fileURLToPath(new URL('../../../src/app/tokens.css', import.meta.url));

describe('the generated stylesheet', () => {
  it('matches the tokens', () => {
    // If this fails, run `npm run tokens`. It exists so a palette change that
    // forgets the regeneration cannot reach a deploy with a stale stylesheet.
    expect(readFileSync(CSS_PATH, 'utf8')).toBe(tokensCss());
  });

  it('emits line heights and weights without units', () => {
    // A `line-height: 1.5px` is a real mistake this shape of generator makes,
    // and it is invisible until the page is rendered.
    const css = tokensCss();
    expect(css).toContain('--leading-normal: 1.5;');
    expect(css).toContain('--weight-regular: 400;');
    expect(css).toMatch(/--space-lg: 16px;/);
  });

  it('honours a reduced-motion preference with zero, not merely less', () => {
    expect(tokensCss()).toContain('prefers-reduced-motion: reduce');
    expect(motion.reducedMotion).toBe(0);
  });
});

/**
 * WCAG 2.1 relative luminance and contrast ratio.
 *
 * Written out rather than pulled from a package: the kernel-style rule in this
 * repo is that a thing worth asserting is worth owning, and this is thirty
 * lines that will never change.
 */
function parseColor(value: string): { r: number; g: number; b: number; a: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }

  const rgba = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
  if (rgba?.[1]) {
    const parts = rgba[1].split(',').map((p) => Number(p.trim()));
    return {
      r: parts[0] ?? 0,
      g: parts[1] ?? 0,
      b: parts[2] ?? 0,
      a: parts[3] ?? 1,
    };
  }

  throw new Error(`Cannot parse colour: ${value}`);
}

const channel = (v: number): number => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = (color: { r: number; g: number; b: number }): number =>
  0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);

function contrast(foreground: string, background: string): number {
  const f = luminance(parseColor(foreground));
  const b = luminance(parseColor(background));
  const [hi, lo] = f > b ? [f, b] : [b, f];
  return (hi + 0.05) / (lo + 0.05);
}

/** Source-over compositing, for a translucent surface on an opaque one. */
function over(foreground: string, background: string): string {
  const f = parseColor(foreground);
  const b = parseColor(background);
  const mix = (fc: number, bc: number) => Math.round(fc * f.a + bc * (1 - f.a));
  return `rgb(${mix(f.r, b.r)}, ${mix(f.g, b.g)}, ${mix(f.b, b.b)})`;
}

describe.each([
  ['light', light],
  ['dark', dark],
])('the %s palette', (_name, palette: Palette) => {
  it('has body text at 4.5:1 or better on paper', () => {
    expect(contrast(palette.ink, palette.paper)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(palette.ink, palette.paperRaised)).toBeGreaterThanOrEqual(4.5);
  });

  it('has secondary text at 4.5:1 — it is still text people read', () => {
    expect(contrast(palette.inkSoft, palette.paper)).toBeGreaterThanOrEqual(4.5);
  });

  it('has the accent readable as text', () => {
    // Two accent tokens exist precisely because the one that looks right as a
    // fill does not clear 4.5:1 as text. This is what stops them being merged.
    expect(contrast(palette.accentText, palette.paper)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps text readable on glass over the page', () => {
    // The sticky date header, sitting on the page's own background.
    expect(
      contrast(palette.ink, over(palette.glass, palette.paper)),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps text readable on glass over the worst thing that can scroll under it', () => {
    // The real risk (CLAUDE.md): glass is translucent, so the contrast depends
    // on what is behind it. The extremes are what must hold — a photograph
    // scrolling under the header is somewhere between them.
    for (const beneath of ['#000000', '#ffffff']) {
      const surface = over(palette.glass, beneath);
      expect(contrast(palette.ink, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('does not use pure white or pure black — it is meant to be paper', () => {
    // Every surface, not just the page. The sheet was #ffffff and this test
    // did not notice, because it only looked at `paper`.
    for (const surface of [palette.paper, palette.paperRaised]) {
      expect(surface.toLowerCase()).not.toBe('#ffffff');
    }
    expect(palette.ink.toLowerCase()).not.toBe('#000000');
  });
});

describe('the token set', () => {
  it('is plain data a React Native client could consume', () => {
    // No functions, no CSS strings with units baked in where a number belongs.
    expect(typeof tokens.space.lg).toBe('number');
    expect(typeof tokens.radius.md).toBe('number');
    expect(typeof tokens.motion.fast).toBe('number');
    expect(typeof tokens.shadow.button.blur).toBe('number');
    expect(JSON.parse(JSON.stringify(tokens))).toEqual(tokens);
  });

  it('uses hairlines rather than boxes', () => {
    expect(tokens.hairline).toBeLessThan(1);
  });

  it('keeps motion inside the 150-200ms the design asks for', () => {
    expect(tokens.motion.fast).toBeGreaterThanOrEqual(150);
    expect(tokens.motion.normal).toBeLessThanOrEqual(200);
  });

  it('has a thumb-reachable add button above the minimum tap target', () => {
    expect(tokens.size.addButton).toBeGreaterThanOrEqual(tokens.size.minTapTarget);
  });
});
