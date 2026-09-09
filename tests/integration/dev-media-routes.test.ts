import { afterEach, describe, expect, it } from 'vitest';
import { resetConfigForTests } from '@/shared/infra/config';
import { handleDevMediaDownload, handleDevMediaUpload } from '@/modules/media';

/**
 * `handleDevMediaUpload`/`handleDevMediaDownload` build their own
 * `LocalMediaBlobStore` rooted at the same `.local-storage/` directory the
 * filesystem `ObjectStorage` adapter uses (see `tests/integration/object-
 * storage.test.ts`), so keys here are namespaced under `media/dev-route-
 * test/` to stay out of that adapter's way.
 */
const ORIGINAL = { ...process.env };

const useEnv = (env: Record<string, string | undefined>) => {
  process.env = { ...ORIGINAL, ...env };
  resetConfigForTests();
};

afterEach(() => {
  process.env = { ...ORIGINAL };
  resetConfigForTests();
});

const KEY = 'media/dev-route-test/original.jpg';

describe('dev media routes outside APP_ENV=local', () => {
  it('404s an upload', async () => {
    useEnv({ APP_ENV: 'production', DATABASE_URL: undefined });
    const request = new Request('http://localhost/dev/media/x', {
      method: 'PUT',
      body: Buffer.from('x'),
    });
    const response = await handleDevMediaUpload(request, [KEY]);
    expect(response.status).toBe(404);
  });

  it('404s a download', async () => {
    useEnv({ APP_ENV: 'production', DATABASE_URL: undefined });
    const response = await handleDevMediaDownload([KEY]);
    expect(response.status).toBe(404);
  });
});

describe('dev media routes under APP_ENV=local', () => {
  it('round-trips an upload through a download', async () => {
    useEnv({ APP_ENV: 'local', DATABASE_URL: undefined });
    const body = Buffer.from('fake-jpeg-bytes');

    const uploadResponse = await handleDevMediaUpload(
      new Request('http://localhost/dev/media/x', { method: 'PUT', body }),
      [KEY],
    );
    expect(uploadResponse.status).toBe(200);

    const downloadResponse = await handleDevMediaDownload([KEY]);
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await downloadResponse.arrayBuffer())).toEqual(body);
  });

  it('404s a download for a key that was never uploaded', async () => {
    useEnv({ APP_ENV: 'local', DATABASE_URL: undefined });
    const response = await handleDevMediaDownload(['media/dev-route-test/nope.jpg']);
    expect(response.status).toBe(404);
  });
});
