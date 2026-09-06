/**
 * s3rver ships no type declarations. Only the surface this project uses is
 * declared — a local S3-compatible server for exercising the R2 adapter in
 * tests (see tests/integration/object-storage.test.ts).
 */
declare module 's3rver' {
  interface S3rverOptions {
    port?: number;
    address?: string;
    silent?: boolean;
    directory: string;
    configureBuckets?: { name: string; configs: string[] }[];
  }

  export default class S3rver {
    constructor(options: S3rverOptions);
    run(): Promise<unknown>;
    close(): Promise<unknown>;
  }
}
