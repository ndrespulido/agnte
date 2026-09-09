import { describe, expect, it } from 'vitest';
import { MAX_EDGE, fitWithin } from '@/app/_client/downscale';

/**
 * `fitWithin` is the half of the downscale that can be tested without a
 * browser — the decode, orient and encode around it need a real canvas, and
 * are driven in Chromium instead (the same split the CSP work used: pure
 * rules under test here, the browser behaviour verified once for real).
 */
describe('fitWithin', () => {
  it('leaves a source already within the limit alone', () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 });
  });

  it('leaves a source exactly at the limit alone', () => {
    expect(fitWithin(1600, 1200, 1600)).toEqual({ width: 1600, height: 1200 });
  });

  it('caps the long edge of a landscape source, keeping the ratio', () => {
    expect(fitWithin(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
  });

  it('caps the long edge of a portrait source, keeping the ratio', () => {
    // The case a phone actually produces: the *height* is the long edge, so a
    // rule written as "cap the width" would leave this one untouched.
    expect(fitWithin(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
  });

  it('never rounds the short edge to zero', () => {
    // A zero-height canvas throws rather than producing a small image, so an
    // extreme panorama has to floor at one pixel.
    expect(fitWithin(4000, 1, 1600)).toEqual({ width: 1600, height: 1 });
  });

  it('defaults to the exported cap', () => {
    expect(fitWithin(MAX_EDGE * 2, MAX_EDGE * 2)).toEqual({
      width: MAX_EDGE,
      height: MAX_EDGE,
    });
  });
});
