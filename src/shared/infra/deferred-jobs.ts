import { CloudTasksClient } from '@google-cloud/tasks';
import { loadConfig } from './config';

/**
 * Deferred work on a scale-to-zero platform (architecture.md §1.3).
 *
 * Cloud Run can kill this container as soon as it returns a response, so work
 * that should outlive the request — generating thumbnails, building an export,
 * purging erased data — cannot simply be started and left to run. It goes
 * through Cloud Tasks: create a task now, return the response, and let Cloud
 * Tasks call back into `/internal/*` on its own schedule, in its own request,
 * which Cloud Run will keep the container alive for.
 *
 * Shared infrastructure rather than something the media module owns: the same
 * need recurs for `notifications` (Phase 7) and `privacy` (Phase 8), and a
 * task queue carries no domain meaning of its own.
 *
 * There is no local equivalent in this file. Locally there is no
 * "after this response" to protect against — `next dev` is a process that
 * keeps running — so each module's local adapter for its own deferred work
 * calls the handler directly, in-process (architecture.md §7.1's "in-process
 * queue calling the same handler directly"). Generalising *that* side into
 * shared infrastructure would mean either a path-keyed registry with a
 * loading-order hazard (nothing guarantees the route that owns a handler has
 * been imported before the route that wants to call it) or passing a function
 * reference through this module's otherwise-string-shaped interface. Neither
 * is worth it for something that is, at bottom, "call the function": see
 * `modules/media/infrastructure/local-thumbnail-queue.ts` for how a module's
 * local path actually looks.
 */
export interface DeferredJobs {
  readonly description: string;
  enqueue(input: { path: string; body: Record<string, unknown> }): Promise<void>;
}

/**
 * The subset of `CloudTasksClient` this adapter uses, so a test can supply a
 * fake without pulling in a client that would try to reach Google.
 */
export interface TaskCreator {
  queuePath(project: string, location: string, queue: string): string;
  createTask(request: {
    parent: string;
    task: {
      httpRequest: {
        httpMethod: 'POST';
        url: string;
        headers: Record<string, string>;
        body: Uint8Array;
      };
    };
  }): Promise<unknown>;
}

export class CloudTasksJobs implements DeferredJobs {
  readonly description: string;

  constructor(
    private readonly client: TaskCreator,
    private readonly projectId: string,
    private readonly location: string,
    private readonly queue: string,
    private readonly baseUrl: string,
    private readonly sharedSecret: string,
  ) {
    this.description = `cloud-tasks:${queue}`;
  }

  async enqueue(input: { path: string; body: Record<string, unknown> }): Promise<void> {
    const parent = this.client.queuePath(this.projectId, this.location, this.queue);

    await this.client.createTask({
      parent,
      task: {
        httpRequest: {
          httpMethod: 'POST',
          url: new URL(input.path, this.baseUrl).toString(),
          headers: {
            'content-type': 'application/json',
            // Verified by shared/infra/internal-auth.ts on the receiving end.
            authorization: `Bearer ${this.sharedSecret}`,
          },
          body: new TextEncoder().encode(JSON.stringify(input.body)),
        },
      },
    });
  }
}

let cached: DeferredJobs | undefined;
let cachedFor: string | undefined;

/**
 * The configured adapter, or undefined when deferred work cannot run —
 * missing GCP project/region, no base URL to call back to, or no shared
 * secret to sign the callback with. A caller turns that into whatever it
 * means for the feature asking: media's upload confirmation, for instance,
 * still marks the upload done, because a thumbnail that never generates is a
 * missing convenience, not a broken upload.
 *
 * There is no local branch here, unlike `getObjectStorage` and
 * `getEmailTransport` — see the module doc comment for why the local path
 * does not go through this factory at all.
 */
export function getDeferredJobs(): DeferredJobs | undefined {
  const config = loadConfig();

  const key = [
    config.GCP_PROJECT_ID ?? '',
    config.GCP_REGION ?? '',
    config.CLOUD_TASKS_QUEUE,
    config.APP_BASE_URL ?? '',
    config.INTERNAL_TASKS_SECRET ?? '',
  ].join('|');

  if (cached && cachedFor === key) return cached;

  let jobs: DeferredJobs | undefined;

  if (
    config.GCP_PROJECT_ID &&
    config.GCP_REGION &&
    config.APP_BASE_URL &&
    config.INTERNAL_TASKS_SECRET
  ) {
    jobs = new CloudTasksJobs(
      new CloudTasksClient(),
      config.GCP_PROJECT_ID,
      config.GCP_REGION,
      config.CLOUD_TASKS_QUEUE,
      config.APP_BASE_URL,
      config.INTERNAL_TASKS_SECRET,
    );
  }

  cached = jobs;
  cachedFor = key;
  return jobs;
}

/** Test seam: forget the memoised adapter so a test can vary the environment. */
export function resetDeferredJobsForTests(): void {
  cached = undefined;
  cachedFor = undefined;
}
