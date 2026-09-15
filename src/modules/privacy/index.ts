/**
 * The privacy module's public surface (§1.1).
 *
 * Privacy is a coordinator: it knows that erasure was requested and nothing
 * about anyone else's tables. What crosses this boundary is the decision and
 * the sweep, never another module's data.
 */
export { handleEraseMe } from './api/erasure-route';
export {
  ERASURE_GRACE_MS,
  registerErasureHandlers,
  requestErasure,
  sweepErasures,
} from './application/erasure';
export type { ErasureResult } from './application/erasure';
