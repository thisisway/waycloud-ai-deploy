import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expirePreviews } from "../../apps/mcp-service/src/jobs/maintenance.js";
import { TOOLS } from "../../apps/mcp-service/src/mcp/tools/index.js";
import type { ToolContext } from "../../apps/mcp-service/src/mcp/tools/define.js";
import { previewBaseHost } from "../../apps/mcp-service/src/preview-serve.js";
import { buildApp } from "../../apps/mcp-service/src/server.js";
import { testCtx } from "../helpers.js";

let ctx: ToolContext;
let root: string;
let close: () => Promise<void>;
let app: ReturnType<typeof buildApp>;
beforeAll(async () => {
  ({ ctx, root, close } = await testCtx());
  app = buildApp(ctx);
});
afterAll(async () => {
  await app.close();
  await close();
});

const call = (name: string, args: unknown) => TOOLS.find((t) => t.name === name)!.handler(ctx, args as never);
const b64 = (s: string | Uint8Array) => Buffer.from(typeof s === "string" ? strToU8(s) : s).toString("base64");

/** Publishes a preview through the real tool and returns its slug. */
async function preview(files: Record<string, string | Uint8Array>) {
  const sessao_id = ((await call("iniciar_sessao", {})).dados as { sessao_id: string }).sessao_id;
  await call("enviar_arquivos", { sessao_id, arquivos: Object.entries(files).map(([caminho, c]) => ({ caminho, conteudo_base64: b64(c) })) });
  const r = await call("criar_previa", { sessao_id });
  expect(r.codigo, JSON.stringify(r)).toBe("PREVIA_CRIADA");
  return (r.dados as { url: string }).url.match(/^https:\/\/([a-z2-7]{10})\.preview\.test$/)![1]!;
}
const get = (host: string, url = "/", method: "GET" | "HEAD" | "POST" = "GET") => app.inject({ method, url, headers: { host } });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 128]);

describe("preview host", () => {
  it("derives the base domain from the URL template", () => {
    expect(previewBaseHost("https://{slug}.waypreview.com.br")).toBe("waypreview.com.br");
    expect(previewBaseHost("http://{slug}.localhost:13000")).toBe("localhost");
  });

  it("serves pages with the banner, noindex and the right types; assets are not touched", async () => {
    const slug = await preview({ "index.html": "<html><body><h1>oi</h1></body></html>", "sobre/index.html": "<p>sem body</p>", "css/a.css": "b{color:red}", "img/x.png": PNG, "d.json": '{"a":1}' });
    const host = `${slug}.preview.test`;

    const home = await get(host);
    expect(home.statusCode).toBe(200);
    expect(home.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(home.body).toContain("<h1>oi</h1>");
    expect(home.body).toContain("Prévia Way Cloud");
    expect(home.body.indexOf("Prévia Way Cloud")).toBeLessThan(home.body.indexOf("</body>")); // banner sits inside the page
    expect(home.headers).toMatchObject({ "x-robots-tag": "noindex, nofollow, noarchive", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-store" });

    expect((await get(host, "/sobre/")).body).toContain("Prévia Way Cloud"); // no </body>: banner is appended
    expect((await get(host, "/sobre")).statusCode).toBe(200); // directory without trailing slash

    const css = await get(host, "/css/a.css");
    expect([css.headers["content-type"], css.body]).toEqual(["text/css; charset=utf-8", "b{color:red}"]);
    const png = await get(host, "/img/x.png");
    expect([png.statusCode, png.headers["content-type"]]).toEqual([200, "image/png"]);
    expect(Buffer.from(png.rawPayload).equals(Buffer.from(PNG))).toBe(true); // bytes untouched
    expect((await get(host, "/d.json")).headers["content-type"]).toBe("application/json; charset=utf-8");
    expect((await get(host, "/index.html?x=1")).statusCode).toBe(200); // query strings are ignored
  });

  it("HEAD works, other methods are refused, missing files are 404 with noindex", async () => {
    const slug = await preview({ "index.html": "<body>x</body>" });
    const host = `${slug}.preview.test`;
    const head = await get(host, "/", "HEAD");
    expect([head.statusCode, head.body]).toEqual([200, ""]);
    const post = await get(host, "/", "POST");
    expect([post.statusCode, post.headers.allow]).toEqual([405, "GET, HEAD"]);
    const miss = await get(host, "/nao-existe");
    expect(miss.statusCode).toBe(404);
    expect(miss.headers["x-robots-tag"]).toContain("noindex");
    expect(miss.body).toContain("Prévia não encontrada");
  });

  it("SPA: deep links fall back to index.html, missing assets do not", async () => {
    const slug = await preview({ "package.json": JSON.stringify({ devDependencies: { vite: "5" } }), "index.html": "src", "dist/index.html": "<div id=root></div>", "dist/assets/a.js": "1" });
    const host = `${slug}.preview.test`;
    const deep = await get(host, "/rota/que/nao/existe");
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain("id=root");
    expect((await get(host, "/assets/a.js")).body).toBe("1");
    expect((await get(host, "/assets/sumiu.js")).statusCode).toBe(404); // an html page in place of a script would hide the error
    expect((await get(host, "/package.json")).statusCode).toBe(404); // project files outside the build are not there
    const plain = await preview({ "index.html": "<body>x</body>" });
    expect((await get(`${plain}.preview.test`, "/rota")).statusCode).toBe(404); // a static site has real 404s
  });

  it("never serves dotfiles, escapes, symlinks or paths outside the preview folder", async () => {
    const slug = await preview({ "index.html": "<body>x</body>", ".hidden": "secret", "a/.env.txt": "secret" });
    const host = `${slug}.preview.test`;
    await writeFile(join(root, "canary.txt"), "OUTSIDE");
    for (const url of ["/.hidden", "/a/.env.txt", "/.waycloud-spa", "/../canary.txt", "/..%2fcanary.txt", "/%2e%2e/canary.txt", "/a/../../canary.txt", "/%00", "/a%5c..%5ccanary.txt", "/%zz"]) {
      const r = await get(host, url);
      expect([404, 400], url).toContain(r.statusCode);
      expect(r.body, url).not.toMatch(/secret|OUTSIDE/);
    }
    try {
      await symlink(join(root, "canary.txt"), join(root, slug, "link.txt"));
      const r = await get(host, "/link.txt");
      expect([r.statusCode, r.body]).not.toContain("OUTSIDE");
      expect(r.statusCode).toBe(404); // a symlink is never followed
    } catch (e) {
      if ((e as { code?: string }).code !== "EPERM") throw e; // creating symlinks needs privileges on some Windows setups
    }
  });

  it("unknown, expired and foreign hosts", async () => {
    const slug = await preview({ "index.html": "<body>x</body>" });
    expect((await get("aaaaaaaaaa.preview.test")).statusCode).toBe(404); // valid shape, no such preview
    await ctx.db.query("UPDATE previews SET expires_at = now() - interval '1 minute' WHERE slug = $1", [slug]);
    expect((await get(`${slug}.preview.test`)).statusCode).toBe(404); // expired
    for (const host of ["preview.test", "www.preview.test", "abc.preview.test", "abcdefghij.other.test"]) {
      const r = await get(host, "/healthz");
      expect(r.statusCode, host).toBe(host === "preview.test" || host.endsWith("other.test") ? 200 : 404); // subdomains of the preview domain are previews; the bare domain is the public site
    }
  });

  it("the preview host never exposes the service's own routes", async () => {
    const slug = await preview({ "index.html": "<body>x</body>" });
    const host = `${slug}.preview.test`;
    for (const url of ["/healthz", "/mcp", "/agent/v1/ping", "/webhooks/whmcs"]) expect((await get(host, url)).statusCode, url).toBe(404);
    expect((await get("localhost", "/healthz")).json()).toEqual({ ok: true }); // while the normal host still has them
  });

  it("takes the original host from X-Preview-Host when Cloudflare rewrote Host", async () => {
    const slug = await preview({ "index.html": "<body>via cf</body>" });
    const r = await app.inject({ method: "GET", url: "/", headers: { host: "servico.easypanel.host", "x-preview-host": `${slug}.preview.test` } });
    expect([r.statusCode, r.body.includes("via cf")]).toEqual([200, true]);
    expect((await app.inject({ method: "GET", url: "/mcp", headers: { host: "servico.easypanel.host", "x-preview-host": `${slug}.preview.test` } })).statusCode).toBe(404);
  });

  it("rebuilds the folder from the stored package after a redeploy wiped the disk (and only once for concurrent requests)", async () => {
    const slug = await preview({ "index.html": "<body>voltei</body>", "css/a.css": "b{}" });
    const host = `${slug}.preview.test`;
    expect((await get(host)).statusCode).toBe(200);
    await rm(join(root, slug), { recursive: true, force: true }); // what a new container looks like
    expect(existsSync(join(root, slug))).toBe(false);
    const [a, b] = await Promise.all([get(host), get(host, "/css/a.css")]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.body).toContain("voltei");
    expect(existsSync(join(root, slug, "index.html"))).toBe(true);
  });

  it("an expired preview is gone for good, even after the folder was rebuilt", async () => {
    const slug = await preview({ "index.html": "<body>x</body>" });
    await ctx.db.query("UPDATE previews SET expires_at = now() - interval '1 minute' WHERE slug = $1", [slug]);
    expect(await expirePreviews(ctx)).toBeGreaterThanOrEqual(1);
    await rm(join(root, slug), { recursive: true, force: true });
    expect((await get(`${slug}.preview.test`)).statusCode).toBe(404);
    expect(existsSync(join(root, slug))).toBe(false); // it was not resurrected
  });
});

// keep the imports used when a platform skips the symlink case
void mkdir;
