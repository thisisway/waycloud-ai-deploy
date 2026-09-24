// Builds dist/waycloud_ai-<version>.zip. Extract it at the WHMCS root: it creates modules/addons/waycloud_ai/.
// Entries keep each file's real modification time: PHP's opcache decides whether to reload a file by its mtime,
// so a fixed date would make the server keep running the old code after an update.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { zipSync } from "fflate";

const src = "whmcs/modules/addons/waycloud_ai";
const version = /'version' => '([^']+)'/.exec(readFileSync(join(src, "waycloud_ai.php"), "utf8"))?.[1];
if (!version) throw new Error("addon version not found in waycloud_ai.php");

const entries = {};
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else entries[relative("whmcs", path).split(sep).join("/")] = [readFileSync(path), { level: 6, mtime: statSync(path).mtime }];
  }
};
walk(src);

mkdirSync("dist", { recursive: true });
const zip = zipSync(entries);
const out = `dist/waycloud_ai-${version}.zip`;
writeFileSync(out, zip);
console.log(`${out}  ${zip.length} bytes  ${Object.keys(entries).length} files  sha256=${createHash("sha256").update(zip).digest("hex")}`);
console.log(Object.keys(entries).join("\n"));
