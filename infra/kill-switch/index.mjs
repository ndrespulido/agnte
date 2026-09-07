import { CloudBillingClient } from '@google-cloud/billing';
import functions from '@google-cloud/functions-framework';
import { decide, parseMessage } from './decide.mjs';

/**
 * Budget kill switch (docs/architecture.md §3.1).
 *
 * Budget -> Pub/Sub -> this function -> billing disabled for the project. As
 * close to a hard spending stop as any cloud offers, and correspondingly
 * destructive: everything stops.
 *
 * It is a backstop, not a cap. GCP's spend data lags by hours, so a genuine
 * runaway can pass the threshold before this ever runs. The real protections
 * are --max-instances on Cloud Run and the Compute API being left disabled, so
 * a NAT gateway or load balancer cannot be created at all.
 *
 * Ships disarmed. With ARMED unset or not "true" it logs the decision and
 * changes nothing, which is what makes the rehearsal safe to run first.
 */

const PROJECT_ID = process.env.TARGET_PROJECT_ID;
const ARMED = process.env.ARMED === 'true';

const billing = new CloudBillingClient();

functions.cloudEvent('killSwitch', async (cloudEvent) => {
  const message = parseMessage(cloudEvent.data);

  if (message === undefined) {
    // Returning normally rather than throwing: a throw makes Pub/Sub redeliver
    // a message that will never parse, forever.
    console.error('kill-switch: could not decode the budget notification; ignoring');
    return;
  }

  const { act, reason } = decide(message);

  if (!act) {
    console.log(`kill-switch: no action — ${reason}`);
    return;
  }

  if (!ARMED) {
    console.warn(
      `kill-switch: WOULD DISABLE BILLING for ${PROJECT_ID} — ${reason}. ` +
        'Not armed (set ARMED=true to enable). No change made.',
    );
    return;
  }

  const name = `projects/${PROJECT_ID}`;

  // Checking first makes a redelivered message a no-op rather than a second
  // write, and gives a clearer log line than an error from the update.
  const [info] = await billing.getProjectBillingInfo({ name });
  if (!info.billingEnabled) {
    console.log(`kill-switch: billing already disabled for ${PROJECT_ID}; nothing to do`);
    return;
  }

  console.error(`kill-switch: DISABLING BILLING for ${PROJECT_ID} — ${reason}`);

  await billing.updateProjectBillingInfo({
    name,
    projectBillingInfo: { billingAccountName: '' },
  });

  console.error(
    `kill-switch: billing DISABLED for ${PROJECT_ID}. ` +
      'Everything in the project has stopped, including this function. ' +
      'Recovery is in docs/operations.md §3.',
  );
});
