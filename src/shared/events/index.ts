export {
  MAX_HANDLER_ATTEMPTS,
  newEvent,
  publish,
  resetSubscriptionsForTests,
  retryDeadLetters,
  subscribe,
} from './bus';
export type { DomainEvent, EventHandler, PublishResult } from './bus';

/**
 * The event names, in one place.
 *
 * A string literal at each call site is a typo waiting to publish into a void —
 * and a subscriber that never fires looks identical to one whose handler is
 * broken, which is the worst failure mode this bus can have.
 */
export const EVENTS = {
  userErasureRequested: 'user.erasure_requested',
} as const;

export interface UserErasureRequested {
  readonly userId: string;
}
