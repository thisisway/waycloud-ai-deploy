import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sign } from "../../apps/mcp-service/src/security/hmac.js";

// The same vector is asserted by the PHP side (tests/php/run.php): both languages must sign identically.
const v = JSON.parse(readFileSync(new URL("../fixtures/hmac-vector.json", import.meta.url), "utf8")) as { secret: string; ts: number; nonce: string; body: string; signature: string };

describe("HMAC shared vector (Node <-> PHP)", () => {
  it("Node signs the fixture exactly as recorded, including non-ASCII bodies", () => {
    expect(v.body).toContain("ação");
    expect(sign(v.secret, v.body, v.ts, v.nonce).signature).toBe(v.signature);
  });
});
