import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";

// What is never uploaded, whatever the ignore files say: VCS data, dependencies, our own state and secrets.
const ALWAYS_SKIP = new Set([".git", "node_modules", ".waycloud", ".DS_Store"]);
const isSecret = (name) => /^\.env(\..+)?$/.test(name) && !/\.(example|sample|template|dist)$/.test(name);
// Build output is usually git-ignored but is exactly what a static/SPA site needs to publish.
const BUILD_DIRS = new Set(["dist", "build", "out", ".output"]);
const MAX_FILES = 10_000;
const MAX_ZIP_BYTES = 100 * 1024 * 1024;

export class PackError extends Error {}

// "**/" = any leading directories, "/**" = everything below, "*" and "?" stay inside one path segment.
function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    if (glob.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 2;
    } else if (glob.startsWith("/**", i) && i + 3 === glob.length) {
      re += "/.*";
      i += 2;
    } else if (glob[i] === "*") re += "[^/]*";
    else if (glob[i] === "?") re += "[^/]";
    else re += glob[i].replace(/[.+^${}()|[\]\\]/, "\\$&");
  }
  return re;
}

// .gitignore syntax, covering the common cases: comments, "!" negation, "dir/" patterns, anchoring, * ** ?.
// ponytail: only the ignore file at the project root is read (no nested .gitignore); add if projects need it.
export function compileIgnore(text) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes("/");
    line = line.replace(/^\//, "");
    const body = globToRegex(line);
    rules.push({ negate, dirOnly, re: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`) });
  }
  return (path, isDir) => {
    let ignored = false;
    for (const r of rules) if (!(r.dirOnly && !isDir) && r.re.test(path)) ignored = !r.negate;
    return ignored;
  };
}

const readOptional = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};

/** Zips a project folder, honouring .gitignore and .waycloudignore. Symlinks are skipped. */
export function packProject(dir) {
  const git = compileIgnore(readOptional(join(dir, ".gitignore")));
  const own = compileIgnore(readOptional(join(dir, ".waycloudignore")));
  const files = {};
  let count = 0;

  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (ALWAYS_SKIP.has(e.name) || (!e.isDirectory() && isSecret(e.name))) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      const isDir = e.isDirectory();
      if (!isDir && !e.isFile()) continue; // symlinks, sockets...
      const forced = BUILD_DIRS.has(path.split("/")[0]);
      if (own(path, isDir) || (!forced && git(path, isDir))) continue;
      if (isDir) walk(path);
      else {
        if (++count > MAX_FILES) throw new PackError(`O projeto tem arquivos demais (limite de ${MAX_FILES}). Adicione pastas pesadas ao .waycloudignore.`);
        files[path] = readFileSync(join(dir, path));
      }
    }
  };
  walk("");

  if (!count) throw new PackError("Nenhum arquivo para enviar. Confira a pasta e o .gitignore.");
  const zip = zipSync(files, { level: 6 });
  if (zip.length > MAX_ZIP_BYTES) throw new PackError("O pacote passou de 100 MB. Adicione pastas pesadas ao .waycloudignore (ou envie só a pasta de build).");
  return { zip, count };
}
