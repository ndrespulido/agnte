import {
  blur,
  dark,
  fontFamily,
  fontSize,
  fontWeight,
  hairline,
  letterSpacing,
  light,
  lineHeight,
  motion,
  radius,
  shadow,
  size,
  space,
  zIndex,
  type Palette,
} from './tokens';

/**
 * The web's spelling of the tokens.
 *
 * Generated rather than hand-written, and checked by a test that regenerates it
 * and compares. Two hand-maintained copies of a palette diverge; the only
 * question is when, and the failure — a colour that is right in one place and
 * stale in another — is the kind nobody notices until a screenshot.
 *
 * Pure: takes tokens, returns a string. No file system here, so the test can
 * call it without touching disk.
 */

const px = (value: number): string => `${value}px`;

const paletteVariables = (palette: Palette): string =>
  Object.entries(palette)
    .map(([name, value]) => `  --color-${kebab(name)}: ${value};`)
    .join('\n');

const kebab = (name: string): string =>
  name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

const scale = (prefix: string, values: Record<string, number | string>): string =>
  Object.entries(values)
    .map(
      ([name, value]) =>
        `  --${prefix}-${kebab(name)}: ${typeof value === 'number' ? px(value) : value};`,
    )
    .join('\n');

/** Unitless — line heights and weights must not carry px. */
const unitless = (prefix: string, values: Record<string, number>): string =>
  Object.entries(values)
    .map(([name, value]) => `  --${prefix}-${kebab(name)}: ${value};`)
    .join('\n');

const shadowValue = (s: {
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
}): string => `${px(s.x)} ${px(s.y)} ${px(s.blur)} ${px(s.spread)} ${s.color}`;

export function tokensCss(): string {
  return `/*
 * GENERATED FILE — do not edit.
 *
 * Written from src/shared/design/tokens.ts by scripts/generate-tokens-css.ts.
 * \`npm run tokens\` regenerates it; a unit test fails if it has drifted, so a
 * token change that forgets the regeneration cannot reach a deploy.
 *
 * The tokens themselves are plain data so a React Native client can consume
 * the same values (CLAUDE.md). This file is only the web's spelling of them.
 */

:root {
  color-scheme: light dark;

${paletteVariables(light)}

${scale('space', space)}
  --hairline: ${px(hairline)};

${scale('radius', radius)}

${scale('font', fontFamily)}
${scale('text', fontSize)}
${unitless('weight', fontWeight)}
${unitless('leading', lineHeight)}
${scale('tracking', letterSpacing)}

  --motion-fast: ${motion.fast}ms;
  --motion-normal: ${motion.normal}ms;
  --motion-ease-out: ${motion.easeOut};

  --shadow-button: ${shadowValue(shadow.button)};
  --shadow-raised: ${shadowValue(shadow.raised)};

  --blur-glass: ${px(blur.glass)};

${unitless('z', zIndex)}

${scale('size', size)}
}

/*
 * Dark mode from the start (CLAUDE.md). Only the palette changes: spacing,
 * type and motion are the same design in both.
 */
@media (prefers-color-scheme: dark) {
  :root {
${paletteVariables(dark)}
  }
}

/*
 * An honoured motion preference is a duration of zero, not a shorter one.
 * Every transition in the app reads these variables, so this is the single
 * place the preference takes effect.
 */
@media (prefers-reduced-motion: reduce) {
  :root {
    --motion-fast: ${motion.reducedMotion}ms;
    --motion-normal: ${motion.reducedMotion}ms;
  }
}
`;
}
