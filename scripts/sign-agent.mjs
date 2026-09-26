// Signs agent/waycloud-agent.sh (writes agent/waycloud-agent.sh.sig, base64). Run after ANY change to the agent script:
//   node scripts/sign-agent.mjs        (private key: WC_SIGN_KEY or ~/.ssh/waycloud-agent-signing.pem, kept off the repository)
// The agents installed on the Plesk servers only accept a new version whose signature checks out.
import { createPublicKey, createSign, createVerify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const script = readFileSync("agent/waycloud-agent.sh");
const embedded = /WC_SIGN_PUB='(-----BEGIN PUBLIC KEY-----[^']+-----END PUBLIC KEY-----)'/.exec(script.toString("utf8"))?.[1];
if (!embedded) throw new Error("no embedded public key in the agent script");
const key = readFileSync(process.env.WC_SIGN_KEY ?? join(homedir(), ".ssh", "waycloud-agent-signing.pem"));
const sig = createSign("sha256").update(script).sign(key);
if (!createVerify("sha256").update(script).verify(createPublicKey(embedded), sig)) throw new Error("this private key does not match the public key embedded in the script");
writeFileSync("agent/waycloud-agent.sh.sig", sig.toString("base64") + "\n");
console.log("signed agent/waycloud-agent.sh");
