import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTests } from '@/shared/infra/config';
import { MIN_QUERY_LENGTH, suggestPlaces } from '@/shared/infra/places';

/**
 * The one metered dependency in the system.
 *
 * These tests are mostly about *not spending money*: that a short query never
 * becomes a billed request, that the field degrades to plain text rather than
 * erroring when no key is configured, and that only the requested fields are
 * asked for. `fetch` is stubbed because the alternative is calling Google in
 * CI, which is the exact cost this file exists to bound.
 */
const ORIGINAL_ENV = { ...process.env };

const answerWith = (body: unknown, ok = true, status = 200) =>
  vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

beforeEach(() => {
  process.env.APP_ENV = 'local';
  resetConfigForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetConfigForTests();
  vi.unstubAllGlobals();
});

describe('place suggestions', () => {
  it('refuses to run at all without a key, rather than answering empty', async () => {
    // Empty would mean "nowhere matches that", which is a different fact and
    // makes an unconfigured field indistinguishable from a working one.
    delete process.env.GOOGLE_PLACES_API_KEY;
    resetConfigForTests();

    await expect(suggestPlaces('Barcelona')).rejects.toThrow(/GOOGLE_PLACES_API_KEY/);
  });

  it('never calls out for a query shorter than the floor', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    resetConfigForTests();

    const fetchMock = answerWith({ suggestions: [] });
    vi.stubGlobal('fetch', fetchMock);

    expect(await suggestPlaces('ba')).toEqual([]);
    // The assertion that matters: two characters cost nothing.
    expect(fetchMock).not.toHaveBeenCalled();
    expect('ba'.length).toBeLessThan(MIN_QUERY_LENGTH);
  });

  it('asks only for the fields it reads', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    resetConfigForTests();

    const fetchMock = answerWith({ suggestions: [] });
    vi.stubGlobal('fetch', fetchMock);
    await suggestPlaces('Barcelona');

    // Places bills by requested field, so the mask is a cost control.
    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers['x-goog-fieldmask']).toBe(
      'suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat',
    );
    expect(init.headers['x-goog-api-key']).toBe('test-key');
  });

  /*
   * The failure this guards against looked like a broken app and was a stray
   * byte: a newline is illegal in an HTTP header value, so `fetch` throws
   * before the request is sent — while checking the same secret in a shell
   * passes, because command substitution strips trailing newlines. Every
   * ordinary way of writing this secret (`gcloud ... --format=value(keyString)`
   * piped into `gcloud secrets versions add`) produces one.
   */
  it('survives a key stored with the trailing newline gcloud writes', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key\n';
    resetConfigForTests();

    const fetchMock = answerWith({ suggestions: [] });
    vi.stubGlobal('fetch', fetchMock);
    await suggestPlaces('Barcelona');

    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers['x-goog-api-key']).toBe('test-key');
  });

  it('treats a key of nothing but whitespace as no key at all', async () => {
    process.env.GOOGLE_PLACES_API_KEY = '   \n';
    resetConfigForTests();

    await expect(suggestPlaces('Barcelona')).rejects.toThrow(/GOOGLE_PLACES_API_KEY/);
  });

  it('flattens what Google answers into what the field shows', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'test-key';
    resetConfigForTests();

    vi.stubGlobal(
      'fetch',
      answerWith({
        suggestions: [
          {
            placePrediction: {
              text: { text: 'Sagrada Família, Barcelona, Spain' },
              structuredFormat: {
                mainText: { text: 'Sagrada Família' },
                secondaryText: { text: 'Barcelona, Spain' },
              },
            },
          },
          // No structuredFormat: still usable, and must not be dropped.
          { placePrediction: { text: { text: 'Somewhere' } } },
          // Nothing usable at all: dropped rather than rendered blank.
          {},
        ],
      }),
    );

    expect(await suggestPlaces('Sagrada')).toEqual([
      {
        description: 'Sagrada Família, Barcelona, Spain',
        primary: 'Sagrada Família',
        secondary: 'Barcelona, Spain',
      },
      { description: 'Somewhere', primary: 'Somewhere', secondary: null },
    ]);
  });

  it('raises the provider’s own reason when it rejects the request', async () => {
    process.env.GOOGLE_PLACES_API_KEY = 'bad-key';
    resetConfigForTests();

    vi.stubGlobal('fetch', answerWith({ error: 'API key not valid' }, false, 403));

    await expect(suggestPlaces('Barcelona')).rejects.toThrow(/403.*API key not valid/);
  });
});
