import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { MediaBlobStore, StoredObjectInfo, UploadTarget } from '../domain/ports';

/** How long a presigned upload URL is good for. The client uses it within
 * seconds of asking, so this is generous headroom, not a real window. */
const UPLOAD_URL_TTL_SECONDS = 5 * 60;

export class R2MediaBlobStore implements MediaBlobStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly prefix: string,
  ) {}

  private path(key: string): string {
    return `${this.prefix}${key}`;
  }

  async presignUpload(input: {
    key: string;
    contentType: string;
  }): Promise<UploadTarget> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.path(input.key),
      ContentType: input.contentType,
    });

    const url = await getSignedUrl(this.client, command, {
      expiresIn: UPLOAD_URL_TTL_SECONDS,
    });

    return {
      url,
      method: 'PUT',
      headers: { 'content-type': input.contentType },
    };
  }

  async presignDownload(key: string, expiresInSeconds: number): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: this.path(key) });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.path(key) }),
      );
      return {
        sizeBytes: response.ContentLength ?? 0,
        contentType: response.ContentType ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async readBuffer(key: string): Promise<Buffer | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.path(key) }),
      );
      const bytes = await response.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async writeBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.path(key),
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.path(key) }),
    );
  }
}

/**
 * The S3 SDK reports a missing key as a thrown error rather than a null
 * return, and names it differently depending on which operation asked —
 * `NoSuchKey` from a GET, `NotFound` from a HEAD, both for the same
 * underlying 404. Both are checked so a caller of either method gets a null
 * rather than a crash for the same real-world condition.
 */
function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'NoSuchKey' || error.name === 'NotFound')
  );
}
