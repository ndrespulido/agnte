import { afterEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '@/shared/infra/config';
import {
  CloudTasksJobs,
  getDeferredJobs,
  resetDeferredJobsForTests,
  type TaskCreator,
} from '@/shared/infra/deferred-jobs';

/**
 * `CloudTasksJobs` is exercised against a fake client rather than the real
 * `@google-cloud/tasks` SDK — there is no local Cloud Tasks emulator, and this
 * environment cannot reach GCP at all. That makes this the one adapter in the
 * codebase not proven against the real thing before a deploy; the factory
 * function and the request-shape it builds are what these tests can actually
 * hold to.
 */

class FakeTaskCreator implements TaskCreator {
  calls: unknown[] = [];

  queuePath(project: string, location: string, queue: string): string {
    return `projects/${project}/locations/${location}/queues/${queue}`;
  }

  async createTask(request: unknown): Promise<unknown> {
    this.calls.push(request);
    return { name: 'fake-task' };
  }
}

describe('CloudTasksJobs', () => {
  it('targets the queue, the base URL and path, and signs the header', async () => {
    const client = new FakeTaskCreator();
    const jobs = new CloudTasksJobs(
      client,
      'agnte-prod',
      'europe-west3',
      'agnte-media-thumbnails',
      'https://agnte.example.com',
      'the-shared-secret',
    );

    await jobs.enqueue({ path: '/internal/media/thumbnail', body: { mediaId: 'm1' } });

    expect(client.calls).toHaveLength(1);
    const call = client.calls[0] as {
      parent: string;
      task: {
        httpRequest: { url: string; headers: Record<string, string>; body: Uint8Array };
      };
    };

    expect(call.parent).toBe(
      'projects/agnte-prod/locations/europe-west3/queues/agnte-media-thumbnails',
    );
    expect(call.task.httpRequest.url).toBe(
      'https://agnte.example.com/internal/media/thumbnail',
    );
    expect(call.task.httpRequest.headers.authorization).toBe('Bearer the-shared-secret');
    expect(JSON.parse(new TextDecoder().decode(call.task.httpRequest.body))).toEqual({
      mediaId: 'm1',
    });
  });

  it('resolves the target URL against the base URL rather than concatenating strings', async () => {
    // A base URL with a trailing slash and a path without a leading one (or
    // vice versa) is the classic way string concatenation produces
    // "https://example.com//internal/x" or "https://example.cominternal/x".
    const client = new FakeTaskCreator();
    const jobs = new CloudTasksJobs(
      client,
      'p',
      'l',
      'q',
      'https://agnte.example.com/',
      's',
    );

    await jobs.enqueue({ path: '/internal/media/thumbnail', body: {} });

    const call = client.calls[0] as { task: { httpRequest: { url: string } } };
    expect(call.task.httpRequest.url).toBe(
      'https://agnte.example.com/internal/media/thumbnail',
    );
  });
});

describe('getDeferredJobs', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    resetConfigForTests();
    resetDeferredJobsForTests();
  });

  const configure = (env: Record<string, string | undefined>) => {
    process.env = { ...ORIGINAL_ENV, ...env };
    resetConfigForTests();
    resetDeferredJobsForTests();
  };

  it('is undefined with nothing configured', () => {
    configure({
      GCP_PROJECT_ID: undefined,
      GCP_REGION: undefined,
      APP_BASE_URL: undefined,
      INTERNAL_TASKS_SECRET: undefined,
    });
    expect(getDeferredJobs()).toBeUndefined();
  });

  it.each([
    ['GCP_PROJECT_ID'],
    ['GCP_REGION'],
    ['APP_BASE_URL'],
    ['INTERNAL_TASKS_SECRET'],
  ] as const)('is undefined when only %s is missing', (missing) => {
    const full: Record<string, string> = {
      GCP_PROJECT_ID: 'agnte-prod',
      GCP_REGION: 'europe-west3',
      APP_BASE_URL: 'https://agnte.example.com',
      INTERNAL_TASKS_SECRET: 'a'.repeat(32),
    };
    delete full[missing];
    configure(full);
    expect(getDeferredJobs()).toBeUndefined();
  });

  it('is configured once every value is present', () => {
    configure({
      GCP_PROJECT_ID: 'agnte-prod',
      GCP_REGION: 'europe-west3',
      APP_BASE_URL: 'https://agnte.example.com',
      INTERNAL_TASKS_SECRET: 'a'.repeat(32),
    });
    expect(getDeferredJobs()).toBeDefined();
    expect(getDeferredJobs()?.description).toBe('cloud-tasks:agnte-media-thumbnails');
  });

  it('returns the same instance until the configuration changes', () => {
    configure({
      GCP_PROJECT_ID: 'agnte-prod',
      GCP_REGION: 'europe-west3',
      APP_BASE_URL: 'https://agnte.example.com',
      INTERNAL_TASKS_SECRET: 'a'.repeat(32),
    });
    const first = getDeferredJobs();
    const second = getDeferredJobs();
    expect(first).toBe(second);
  });
});
