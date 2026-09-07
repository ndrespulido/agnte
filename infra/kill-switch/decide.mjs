/**
 * Decides whether a budget notification should disable billing.
 *
 * Separated from the API call because this is the whole safety boundary: a
 * false positive takes the entire project down, and a false negative makes the
 * backstop useless. Everything here is pure so it can be tested exhaustively —
 * see tests/unit/kill-switch.test.ts.
 *
 * Budget notifications arrive on every configured threshold, not only the last
 * one, so the low alerts (roughly EUR 5 / 10 / 20) reach this function too and
 * must not trigger it.
 */

/**
 * @param {unknown} message Decoded budget notification.
 * @returns {{act: boolean, reason: string}}
 */
export function decide(message) {
  if (message === null || typeof message !== 'object') {
    return { act: false, reason: 'message is not an object' };
  }

  const { costAmount, budgetAmount, budgetDisplayName, currencyCode } = message;

  // Absent or non-numeric values mean a message shape that is not understood.
  // Refusing to act is the safe direction: the alerts still fire, and a
  // backstop that never triggers is better than one that triggers wrongly.
  if (typeof costAmount !== 'number' || Number.isNaN(costAmount)) {
    return { act: false, reason: 'costAmount is missing or not a number' };
  }
  if (typeof budgetAmount !== 'number' || Number.isNaN(budgetAmount)) {
    return { act: false, reason: 'budgetAmount is missing or not a number' };
  }
  if (budgetAmount <= 0) {
    return { act: false, reason: `budgetAmount is not positive (${budgetAmount})` };
  }

  if (costAmount < budgetAmount) {
    const percent = Math.round((costAmount / budgetAmount) * 100);
    return {
      act: false,
      reason:
        `${percent}% of budget (${costAmount} of ${budgetAmount} ${currencyCode ?? ''})`.trim(),
    };
  }

  return {
    act: true,
    reason:
      `budget exceeded: ${costAmount} of ${budgetAmount} ${currencyCode ?? ''}`.trim() +
      (budgetDisplayName ? ` [${budgetDisplayName}]` : ''),
  };
}

/**
 * Pub/Sub delivers the payload base64-encoded. Returns undefined rather than
 * throwing, so a malformed message is logged and ignored instead of being
 * retried forever by Pub/Sub.
 *
 * @param {unknown} cloudEventData
 * @returns {unknown}
 */
export function parseMessage(cloudEventData) {
  const encoded = cloudEventData?.message?.data;
  if (typeof encoded !== 'string') return undefined;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}
