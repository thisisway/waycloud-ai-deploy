import { createPublicKey, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The agents on the Plesk servers only accept a new script that is signed. If this fails after editing
// agent/waycloud-agent.sh, run `pnpm sign:agent` (needs the private key, kept outside the repository).
describe("agent script signature", () => {
  const script = readFileSync("agent/waycloud-agent.sh");
  const text = script.toString("utf8");

  it("the committed signature matches the script and the public key embedded in it", () => {
    const pub = /WC_SIGN_PUB='(-----BEGIN PUBLIC KEY-----[^']+-----END PUBLIC KEY-----)'/.exec(text)?.[1];
    expect(pub, "embedded public key").toBeTruthy();
    const sig = Buffer.from(readFileSync("agent/waycloud-agent.sh.sig", "utf8").trim(), "base64");
    expect(createVerify("sha256").update(script).verify(createPublicKey(pub!), sig), "signature (run pnpm sign:agent)").toBe(true);
  });

  it("has a version in the format the updater compares (YYYY-MM-DD.NN)", () => {
    expect(/^WC_AGENT_VERSION="\d{4}-\d{2}-\d{2}\.\d{2}"$/m.test(text)).toBe(true);
  });

  it("uses LF line endings (the signature covers the exact bytes)", () => expect(text.includes("\r")).toBe(false));
});
