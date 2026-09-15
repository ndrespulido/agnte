import { loadConfig } from './config';

/**
 * Place suggestions for the location field (Google Places Autocomplete).
 *
 * Shared *infrastructure*, not a module: there is no aggregate here, nothing
 * persists, and no domain rule applies — it is an adapter over someone else's
 * HTTP API, which is exactly what §1.1 permits sharing. A `places` module
 * would be a folder of empty layers around one fetch.
 *
 * ---------------------------------------------------------------------------
 * This is the one metered dependency in the system.
 *
 * Everything else here is fixed-cost or free by construction (§3.1: scale to
 * zero, no load balancer, R2 for its absent egress fees). Places bills per
 * request against a monthly credit, which means a key held down in the
 * location field is, literally, money. Three things keep that bounded, and all
 * three matter:
 *
 *   - the client debounces and will not ask below MIN_QUERY_LENGTH,
 *   - the route is rate-limited per user like every other authenticated
 *     endpoint,
 *   - and this is server-side, so the key is never in a browser where it could
 *     be lifted and spent by someone else.
 *
 * The obvious further step is Google's session tokens, which bill a whole
 * typing session as one unit rather than per keystroke. Not done here, and
 * worth doing if this ever sees more than one person's use.
 * ---------------------------------------------------------------------------
 */

/**
 * Below this, suggestions are noise anyway — two characters match half the
 * planet — so the floor costs nothing in usefulness and removes the most
 * expensive keystrokes.
 */
export const MIN_QUERY_LENGTH = 3;

/** Google returns more; this is what the sheet can show without a scroll. */
const MAX_SUGGESTIONS = 5;

const ENDPOINT = 'https://places.googleapis.com/v1/places:autocomplete';

export interface PlaceSuggestion {
  /** What goes in the field when chosen. */
  readonly description: string;
  /** The name alone, for the first line of the row. */
  readonly primary: string;
  /** City, country — the second, quieter line. */
  readonly secondary: string | null;
}

/** The shape Google answers with, narrowed to what is read below. */
interface AutocompleteResponse {
  suggestions?: {
    placePrediction?: {
      text?: { text?: string };
      structuredFormat?: {
        mainText?: { text?: string };
        secondaryText?: { text?: string };
      };
    };
  }[];
}

export class PlacesNotConfigured extends Error {}

/**
 * Suggestions for what someone has typed so far.
 *
 * Throws `PlacesNotConfigured` rather than returning empty when there is no
 * key: an empty list means "nowhere matches that", and a field that silently
 * stops suggesting is indistinguishable from one whose provider is down.
 */
export async function suggestPlaces(query: string): Promise<PlaceSuggestion[]> {
  /*
   * Trimmed, and not defensively — a trailing newline here is a *likely*
   * value, not a far-fetched one.
   *
   * The key is stored in Secret Manager and mounted as an environment
   * variable, which preserves the payload's bytes exactly. Every natural way
   * to create that payload adds a newline: `gcloud ... --format=value(...)`
   * ends its output with one, and piping it straight into
   * `gcloud secrets versions add --data-file=-` stores it.
   *
   * What makes it worth a line of code rather than a note in a runbook is how
   * it fails. A newline is illegal in an HTTP header value, so `fetch` throws
   * before the request leaves — while every way of checking the secret by hand
   * passes, because shell command substitution strips trailing newlines. The
   * result is a key that works in a terminal and only fails inside the app.
   */
  const key = loadConfig().GOOGLE_PLACES_API_KEY?.trim();
  if (!key) throw new PlacesNotConfigured('GOOGLE_PLACES_API_KEY is not set');

  const input = query.trim();
  if (input.length < MIN_QUERY_LENGTH) return [];

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': key,
      // Ask only for the fields read below. Places bills by what is
      // requested, so a field mask is a cost control as much as a filter.
      'x-goog-fieldmask':
        'suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat',
    },
    body: JSON.stringify({ input }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Places rejected the request (${response.status}): ${detail.slice(0, 300)}`,
    );
  }

  const body = (await response.json()) as AutocompleteResponse;

  return (body.suggestions ?? [])
    .flatMap((suggestion) => {
      const prediction = suggestion.placePrediction;
      if (!prediction) return [];

      const primary = prediction.structuredFormat?.mainText?.text;
      const description = prediction.text?.text ?? primary;
      if (!description) return [];

      return [
        {
          description,
          primary: primary ?? description,
          secondary: prediction.structuredFormat?.secondaryText?.text ?? null,
        },
      ];
    })
    .slice(0, MAX_SUGGESTIONS);
}
