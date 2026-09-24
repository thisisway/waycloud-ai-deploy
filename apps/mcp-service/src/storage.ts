import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Object storage. Two implementations on purpose: S3-compatible (Cloudflare R2 in production,
// MinIO in dev) and an in-memory one used by the unit tests.
export interface Storage {
  /** Pre-signed PUT URL that only accepts a body of exactly `sizeBytes` bytes. */
  presignPut(key: string, sizeBytes: number, ttlSeconds: number): Promise<string>;
  put(key: string, body: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  /** Size in bytes, or null when the object does not exist. */
  head(key: string): Promise<number | null>;
  remove(key: string): Promise<void>;
}

export interface S3Config {
  endpoint: string;
  /** Host that clients use for pre-signed URLs when it differs from `endpoint` (e.g. MinIO inside Docker). */
  publicEndpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

const isNotFound = (e: unknown) => {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err.name === "NoSuchKey" || err.name === "NotFound" || err.$metadata?.httpStatusCode === 404;
};

export function s3Storage(c: S3Config): Storage {
  const client = (endpoint: string) =>
    new S3Client({ region: c.region, endpoint, credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }, forcePathStyle: true });
  const s3 = client(c.endpoint);
  const signer = c.publicEndpoint ? client(c.publicEndpoint) : s3; // the signature covers the host, so sign with the one the client will call
  const Bucket = c.bucket;
  return {
    // Signing content-length makes the storage reject any other size (the upload cap is enforced there).
    presignPut: (Key, size, ttl) =>
      getSignedUrl(signer, new PutObjectCommand({ Bucket, Key, ContentLength: size }), { expiresIn: ttl, signableHeaders: new Set(["content-length"]) }),
    put: async (Key, Body) => void (await s3.send(new PutObjectCommand({ Bucket, Key, Body }))),
    get: async (Key) => {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket, Key }));
        return await r.Body!.transformToByteArray();
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    head: async (Key) => {
      try {
        return (await s3.send(new HeadObjectCommand({ Bucket, Key }))).ContentLength ?? 0;
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    remove: async (Key) => void (await s3.send(new DeleteObjectCommand({ Bucket, Key }))),
  };
}
