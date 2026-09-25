import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
export const SLUG_RE = /^[a-z2-7]{10}$/;
export const SPA_MARKER = ".waycloud-spa"; // the preview server falls back to index.html (SPA routes) when this file exists

/** Matches <slug>.<base domain> for a preview host and captures the slug. */
export const newSlugRe = (baseHost: string) => new RegExp(`^([a-z2-7]{10})\\.${baseHost.replaceAll(".", "\\.")}$`); // a host name only holds letters, digits, "-" and "."

export const newSlug = () => Array.from(randomBytes(10), (b) => ALPHABET[b % 32]).join("");

// Writes the preview into a temp folder and renames it, so the edge never serves a half-written site.
export async function writePreview(root: string, slug: string, files: Map<string, Uint8Array>, spa: boolean): Promise<void> {
  if (!SLUG_RE.test(slug)) throw new Error("bad slug");
  const tmp = resolve(root, `.tmp-${slug}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  for (const [rel, data] of files) {
    const target = resolve(tmp, rel);
    if (!target.startsWith(tmp + sep)) throw new Error("path escapes the preview folder"); // defense in depth, paths are already normalized
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
  if (spa) await writeFile(join(tmp, SPA_MARKER), "");
  await rename(tmp, resolve(root, slug));
}

export async function removePreview(root: string, slug: string): Promise<void> {
  if (!SLUG_RE.test(slug)) return;
  await rm(resolve(root, slug), { recursive: true, force: true });
}

export const previewUrl = (template: string, slug: string) => template.replace("{slug}", slug);
