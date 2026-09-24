import { createHash } from "node:crypto";
import { zipSync, type Zippable } from "fflate";

// Builds the clean, deterministic package the Plesk agent receives: regular files only, sorted,
// fixed timestamps, so the same site always yields the same SHA-256.
export function packZip(files: Map<string, Uint8Array>) {
  const fixed = new Date(2020, 0, 1);
  const entries: Zippable = {};
  for (const path of [...files.keys()].sort()) entries[path] = [files.get(path)!, { level: 6, mtime: fixed }];
  const zip = zipSync(entries);
  return { zip, sha256: createHash("sha256").update(zip).digest("hex"), fileCount: files.size };
}
