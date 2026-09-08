/**
 * Writes src/app/tokens.css from the design tokens.
 *
 * Run by `npm run tokens`. The generated file is committed so a build needs no
 * codegen step, and a unit test regenerates it in memory and compares — which
 * is what stops a token change reaching a deploy with a stale stylesheet.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tokensCss } from '../src/shared/design/css';

const target = fileURLToPath(new URL('../src/app/tokens.css', import.meta.url));
writeFileSync(target, tokensCss(), 'utf8');

console.info(`wrote ${target}`);
