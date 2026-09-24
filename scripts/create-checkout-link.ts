// Dev tool: asks the WHMCS addon for a checkout link, exactly like the MCP service does.
// Useful to test the addon before the MCP service is deployed:
//   ADDON_URL=https://app.waycloud.com.br/modules/addons/waycloud_ai/api.php ADDON_HMAC_SECRET=... pnpm checkout:dev 173 monthly
import { randomUUID } from "node:crypto";
import { httpAddonClient } from "../apps/mcp-service/src/addon.js";

const url = process.env.ADDON_URL;
const secret = process.env.ADDON_HMAC_SECRET;
const [pid, cycle] = process.argv.slice(2);
if (!url || !secret || !pid || (cycle !== "monthly" && cycle !== "annually")) {
  console.error("usage: ADDON_URL=... ADDON_HMAC_SECRET=... pnpm checkout:dev <pid> <monthly|annually>");
  process.exit(1);
}
const r = await httpAddonClient({ url, secret }).createCheckout({ sessionId: randomUUID(), pid: Number(pid), cycle });
console.log(JSON.stringify(r, null, 2));
