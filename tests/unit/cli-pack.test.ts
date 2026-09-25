import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM without type declarations
import { compileIgnore, packProject, PackError } from "../../packages/cli/src/pack.mjs";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function project(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "wc-cli-"));
  dirs.push(dir);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}
const names = (dir: string) => Object.keys(unzipSync(packProject(dir).zip)).sort();

describe("compileIgnore (gitignore syntax)", () => {
  const ig = compileIgnore("# comment\n*.log\n/secret.txt\ncache/\ndocs/**/tmp\n!keep.log\n*.tmp\n");
  it.each([
    ["a.log", false, true],
    ["deep/dir/a.log", false, true],
    ["keep.log", false, false], // negation
    ["secret.txt", false, true],
    ["sub/secret.txt", false, false], // leading slash anchors to the root
    ["cache", true, true],
    ["cache", false, false], // "cache/" only matches directories
    ["docs/a/b/tmp", false, true],
    ["docs/tmp", false, true],
    ["x.tmp", false, true],
    ["src/index.html", false, false],
    ["a.logx", false, false], // the dot is literal
  ])("%s (dir=%s) -> ignored=%s", (path, isDir, expected) => expect(ig(path, isDir)).toBe(expected));
});

describe("packProject", () => {
  it("skips VCS data, dependencies, secrets and its own state, keeps examples", () => {
    const dir = project({ "index.html": "x", ".git/config": "x", "node_modules/a/i.js": "x", ".env": "SECRET=1", ".env.local": "SECRET=1", ".env.example": "A=", "sub/.env": "SECRET=1", ".waycloud/session.json": "{}" });
    expect(names(dir)).toEqual([".env.example", "index.html"]);
  });

  it("honours .gitignore and .waycloudignore, but keeps a git-ignored build folder", () => {
    const dir = project({ ".gitignore": "dist\n*.md\nlogs/\n", ".waycloudignore": "draft/\n", "package.json": "{}", "README.md": "x", "logs/a.txt": "x", "draft/a.html": "x", "dist/index.html": "<p>", "dist/a.md": "x", "src/app.js": "x" });
    // *.md still applies outside the build folder; inside dist nothing is dropped by .gitignore
    expect(names(dir)).toEqual([".gitignore", ".waycloudignore", "dist/a.md", "dist/index.html", "package.json", "src/app.js"]);
  });

  it(".waycloudignore wins over the build-folder exception", () => {
    const dir = project({ ".gitignore": "dist\n", ".waycloudignore": "dist\n", "index.html": "x", "dist/index.html": "x" });
    expect(names(dir)).toEqual([".gitignore", ".waycloudignore", "index.html"]);
  });

  it("does not follow symlinks", () => {
    const dir = project({ "index.html": "x", "outside/secret.txt": "TOP" });
    const inner = join(dir, "site");
    mkdirSync(inner);
    writeFileSync(join(inner, "index.html"), "y");
    try {
      symlinkSync(join(dir, "outside"), join(inner, "link"), "dir");
      symlinkSync(join(dir, "outside", "secret.txt"), join(inner, "file-link"));
    } catch (e) {
      if ((e as { code?: string }).code === "EPERM") return; // no symlink privilege on this Windows setup
      throw e;
    }
    expect(names(inner)).toEqual(["index.html"]);
  });

  it("refuses a project with nothing to send", () => {
    expect(() => packProject(project({ ".env": "x" }))).toThrow(PackError);
  });
});
