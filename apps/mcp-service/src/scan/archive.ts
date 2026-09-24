import { unzipSync } from "fflate";
import { normalizePath } from "../security/sanitize.js";

const MB = 1024 * 1024;
export const DEFAULT_LIMITS = { maxZipBytes: 50 * MB, maxFiles: 10_000, maxFileBytes: 25 * MB, maxTotalBytes: 200 * MB };
export type Limits = typeof DEFAULT_LIMITS;

export type ArchiveErrorCode = "ZIP_TOO_BIG" | "ZIP_TOO_MANY_FILES" | "ZIP_FILE_TOO_BIG" | "ZIP_EXPANDS_TOO_MUCH" | "ZIP_BAD_PATH" | "ZIP_CORRUPT";

export class ArchiveError extends Error {
  constructor(public code: ArchiveErrorCode) {
    super(code);
  }
}

// Reads an uploaded zip into memory, enforcing limits from the central directory BEFORE inflating
// (zip bombs) and rejecting any path that could escape the site root (zip-slip).
// Symlinks are harmless here: fflate never creates them, they come out as tiny regular files.
export function readZip(bytes: Uint8Array, limits: Limits = DEFAULT_LIMITS): Map<string, Uint8Array> {
  if (bytes.length > limits.maxZipBytes) throw new ArchiveError("ZIP_TOO_BIG");
  let count = 0;
  let total = 0;
  const seen = new Map<string, string>(); // normalized path -> raw entry name
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(bytes, {
      filter: (f) => {
        if (f.name.endsWith("/")) return false; // directory entry
        const p = normalizePath(f.name);
        if (!p) throw new ArchiveError("ZIP_BAD_PATH");
        if (++count > limits.maxFiles) throw new ArchiveError("ZIP_TOO_MANY_FILES");
        if (f.originalSize > limits.maxFileBytes) throw new ArchiveError("ZIP_FILE_TOO_BIG");
        total += f.originalSize;
        if (total > limits.maxTotalBytes) throw new ArchiveError("ZIP_EXPANDS_TOO_MUCH");
        seen.set(p, f.name);
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ArchiveError) throw e;
    throw new ArchiveError("ZIP_CORRUPT");
  }

  const out = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(raw)) {
    // The central directory can lie about sizes: re-check what was really inflated.
    if (data.length > limits.maxFileBytes) throw new ArchiveError("ZIP_FILE_TOO_BIG");
    out.set(normalizePath(name)!, data);
  }
  return stripSingleRoot(out);
}

// Zipping a folder usually wraps everything in one top-level directory: drop it.
function stripSingleRoot(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const paths = [...files.keys()];
  const root = paths[0]?.split("/")[0];
  if (!root || !paths.every((p) => p.startsWith(root + "/"))) return files;
  return new Map([...files].map(([p, d]) => [p.slice(root.length + 1), d]));
}
