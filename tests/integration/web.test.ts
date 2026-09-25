import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ESM served to the browser, without type declarations
import { Api, ensureSession, sendZip } from "../../apps/mcp-service/public/flow.js";
import { buildApp } from "../../apps/mcp-service/src/server.js";
import { MAX_WEB_ZIP_BYTES } from "../../apps/mcp-service/src/web.js";
import { testCtx } from "../helpers.js";

type T = Awaited<ReturnType<typeof testCtx>>;
let t: T;
let app: ReturnType<typeof buildApp>;
let base: string;
const api = () => new Api(base);
const memoryStore = () => {
  let v: unknown = null;
  return { get: () => v, set: (x: unknown) => void (v = x) };
};
const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

beforeAll(async () => {
  t = await testCtx();
  app = buildApp(t.ctx);
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await app.close();
  await t.close();
});

describe("public page", () => {
  it("serves the page and its assets with a strict CSP", async () => {
    for (const [path, type] of [["/", "text/html"], ["/site.css", "text/css"], ["/site.js", "text/javascript"], ["/flow.js", "text/javascript"], ["/ribbons.js", "text/javascript"], ["/waycloud-logo.svg", "image/svg+xml"], ["/fonts/plus-jakarta-sans-v12-latin.woff2", "font/woff2"]] as const) {
      const r = await fetch(base + path);
      expect(r.status, path).toBe(200);
      expect(r.headers.get("content-type"), path).toContain(type);
      expect(r.headers.get("content-security-policy"), path).toContain("script-src 'self'");
      expect(r.headers.get("content-security-policy"), path).toContain("frame-ancestors 'none'");
    }
    const home = await (await fetch(base + "/")).text();
    expect(home).toContain("Arraste o arquivo .zip aqui");
  });

  it("is fully self-contained: no inline scripts or styles, no external resources", () => {
    const html = readFileSync("apps/mcp-service/public/index.html", "utf8");
    const css = readFileSync("apps/mcp-service/public/site.css", "utf8");
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i); // every script has a src
    expect(html).not.toMatch(/\son[a-z]+\s*=/i); // no inline handlers
    expect(html).not.toMatch(/\sstyle\s*=/i); // no inline styles
    expect(html).not.toMatch(/\ssrc="https?:\/\//i); // no resource is loaded from elsewhere (links to the terms are plain anchors)
    expect(html).not.toMatch(/<link[^>]+href="https?:\/\//i);
    expect(css).not.toMatch(/@import/i);
    expect([...css.matchAll(/url\(([^)]*)\)/g)].every((m) => m[1]!.startsWith('"/fonts/'))).toBe(true); // only the self-hosted font
  });

  it("the page code never builds HTML from strings (no innerHTML / eval)", () => {
    for (const f of ["site.js", "flow.js", "ribbons.js"]) expect(readFileSync(`apps/mcp-service/public/${f}`, "utf8"), f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });

  it("llms.txt shows the public address (the preview domain), never a leftover placeholder or platform host", async () => {
    const text = await (await fetch(base + "/llms.txt")).text();
    expect(text).toContain("https://preview.test/mcp"); // the test context's preview domain
    expect(text).not.toMatch(/\{\{ORIGIN\}\}|easypanel/);
  });

  it("/llms is an alias of /llms.txt", async () => {
    expect(await (await fetch(base + "/llms")).text()).toBe(await (await fetch(base + "/llms.txt")).text());
  });

  it("previews on subdomains are still previews, not the page", async () => {
    const r = await fetch(base + "/", { headers: { "x-preview-host": "abcdefghij.preview.test" } });
    expect(r.status).toBe(404); // unknown slug on the preview domain
    expect(r.headers.get("x-robots-tag")).toContain("noindex");
  });
});

describe("browser flow (flow.js against the real service)", () => {
  it("session, upload through the service and preview; the session is reused", async () => {
    const a = api();
    const store = memoryStore();
    const s1 = await ensureSession(a, store);
    const s2 = await ensureSession(a, store);
    expect(s2.sessao_id).toBe(s1.sessao_id);

    const sent = await sendZip(a, s1.sessao_id, zip({ "index.html": "<html><body><h1>do navegador</h1></body></html>" }));
    expect(sent).toMatchObject({ ok: true });
    const pv = await a.tool("criar_previa", { sessao_id: s1.sessao_id, upload_id: sent.upload_id });
    expect(pv.codigo).toBe("PREVIA_CRIADA");
    const slug = new URL(pv.dados.url).hostname.split(".")[0];
    const page = await fetch(base + "/", { headers: { "x-preview-host": `${slug}.preview.test` } });
    expect(await page.text()).toContain("do navegador");
  });

  it("a PHP project gets no preview, and plans say which ones fit", async () => {
    const a = api();
    const s = await ensureSession(a, memoryStore());
    const sent = await sendZip(a, s.sessao_id, zip({ "index.php": "<?php echo 'oi';" }));
    const pv = await a.tool("criar_previa", { sessao_id: s.sessao_id, upload_id: sent.upload_id });
    expect(pv.codigo).toBe("PREVIA_INDISPONIVEL_PHP");
    const plans = (await a.tool("listar_planos")).dados.planos as { pid: number; tipos: string[] }[];
    expect(plans.find((p) => p.tipos.includes("php"))).toBeTruthy();
    expect(plans.find((p) => p.tipos.includes("spa"))).toBeTruthy();
  });

  it("rejects a bad session, someone else's upload, a non-zip body and an oversized body", async () => {
    const a = api();
    const mine = await ensureSession(a, memoryStore());
    const other = await ensureSession(a, memoryStore());
    const up = await a.tool("obter_url_upload", { sessao_id: mine.sessao_id, tamanho_bytes: 100 });
    const put = (sessao: string, id: string, body: Uint8Array) => fetch(`${base}/web/upload/${id}`, { method: "PUT", headers: { "content-type": "application/zip", "x-sessao-id": sessao }, body: Buffer.from(body) });
    const good = zip({ "index.html": "x" });

    expect((await put("token-invalido", up.dados.upload_id, good)).status).toBe(401);
    expect((await put(other.sessao_id, up.dados.upload_id, good)).status).toBe(404); // not their upload
    expect((await put(mine.sessao_id, "../etc/passwd", good)).status).toBe(404);
    expect((await put(mine.sessao_id, "00000000-0000-4000-8000-000000000000", good)).status).toBe(404);
    expect((await put(mine.sessao_id, up.dados.upload_id, strToU8("isto não é um zip, só texto comum aqui"))).status).toBe(400);
    // Too big: the server refuses (413) and may cut the connection while the client is still sending.
    const big = await put(mine.sessao_id, up.dados.upload_id, new Uint8Array(MAX_WEB_ZIP_BYTES + 1)).then((r) => r.status, () => "reset");
    expect([413, "reset"]).toContain(big);
    expect((await put(mine.sessao_id, up.dados.upload_id, good)).status).toBe(200); // still usable after the failed attempts
  });

  it("an upload that was already processed cannot be overwritten", async () => {
    const a = api();
    const s = await ensureSession(a, memoryStore());
    const sent = await sendZip(a, s.sessao_id, zip({ "index.html": "<body>ok</body>" }));
    await a.tool("criar_previa", { sessao_id: s.sessao_id, upload_id: sent.upload_id }); // scans it: status leaves awaiting_upload
    const again = await fetch(`${base}/web/upload/${sent.upload_id}`, { method: "PUT", headers: { "content-type": "application/zip", "x-sessao-id": s.sessao_id }, body: Buffer.from(zip({ "index.html": "trocado" })) });
    expect(again.status).toBe(404);
  });

  it("the scan still applies: a zip with a web shell is refused at preview time", async () => {
    const a = api();
    const s = await ensureSession(a, memoryStore());
    const shell = "<?php " + "ev" + "al(" + "$_POST['x']);";
    const sent = await sendZip(a, s.sessao_id, zip({ "index.php": shell, "index.html": "x" }));
    const pv = await a.tool("criar_previa", { sessao_id: s.sessao_id, upload_id: sent.upload_id });
    expect(pv.ok).toBe(false);
  });
});
