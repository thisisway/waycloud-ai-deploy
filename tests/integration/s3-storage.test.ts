import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { s3Storage } from "../../apps/mcp-service/src/storage.js";

// Runs against a real S3-compatible bucket (Cloudflare R2 or MinIO) only when configured:
//   TEST_S3_ENDPOINT, TEST_S3_ACCESS_KEY_ID, TEST_S3_SECRET_ACCESS_KEY, TEST_S3_BUCKET
// Objects are written under healthcheck/ and removed at the end.
const e = process.env;
const enabled = !!(e.TEST_S3_ENDPOINT && e.TEST_S3_ACCESS_KEY_ID && e.TEST_S3_SECRET_ACCESS_KEY && e.TEST_S3_BUCKET);

describe.skipIf(!enabled)("s3Storage against a real bucket", () => {
  const storage = s3Storage({ endpoint: e.TEST_S3_ENDPOINT!, region: "auto", accessKeyId: e.TEST_S3_ACCESS_KEY_ID!, secretAccessKey: e.TEST_S3_SECRET_ACCESS_KEY!, bucket: e.TEST_S3_BUCKET! });
  const prefix = `healthcheck/vitest-${randomBytes(4).toString("hex")}`;
  const keys: string[] = [];
  const key = (n: string) => (keys.push(`${prefix}/${n}`), `${prefix}/${n}`);
  afterAll(async () => void (await Promise.all(keys.map((k) => storage.remove(k)))));

  it("put / get / head / remove, and null for missing objects", async () => {
    const k = key("a.bin");
    expect(await storage.get(k)).toBeNull();
    expect(await storage.head(k)).toBeNull();
    await storage.put(k, new Uint8Array([1, 2, 3]));
    expect([...(await storage.get(k))!]).toEqual([1, 2, 3]);
    expect(await storage.head(k)).toBe(3);
    await storage.remove(k);
    expect(await storage.get(k)).toBeNull();
    await storage.remove(k); // removing a missing object is not an error
  });

  it("a presigned PUT only accepts the exact size that was signed", async () => {
    const k = key("signed.bin");
    const url = await storage.presignPut(k, 10, 60);
    const wrong = await fetch(url, { method: "PUT", body: new Uint8Array(11) });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(await storage.head(k)).toBeNull();
    const right = await fetch(url, { method: "PUT", body: new Uint8Array(10) });
    expect(right.status).toBe(200);
    expect(await storage.head(k)).toBe(10);
  });

  it("an expired presigned URL is refused", async () => {
    const k = key("expired.bin");
    const url = await storage.presignPut(k, 4, 1);
    await new Promise((r) => setTimeout(r, 2500));
    expect((await fetch(url, { method: "PUT", body: new Uint8Array(4) })).status).toBeGreaterThanOrEqual(400);
  });
});
