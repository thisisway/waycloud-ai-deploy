import { createServer, type Server } from "node:net";
import { strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clamdScanner, scanStream } from "../../apps/mcp-service/src/scan/clamav.js";
import type { ToolContext } from "../../apps/mcp-service/src/mcp/tools/define.js";
import { TOOLS } from "../../apps/mcp-service/src/mcp/tools/index.js";
import { testCtx } from "../helpers.js";

// A stand-in for clamd that speaks its INSTREAM protocol and flags the standard EICAR test string.
// (The test string is assembled at runtime: a real antivirus on a developer machine would quarantine this file otherwise.)
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE", "!$H+H*"].join("");

let clamd: Server;
let port: number;
let streams = 0;
let mode: "normal" | "error" = "normal";

function fakeClamd() {
  return createServer((socket) => {
    let buf = Buffer.alloc(0);
    let started = false;
    let payload = Buffer.alloc(0);
    socket.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (!started) {
        if (buf.length < 10) return;
        expect(buf.subarray(0, 10).toString("latin1")).toBe("zINSTREAM\0");
        buf = buf.subarray(10);
        started = true;
      }
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          streams++;
          const reply = mode === "error" ? "INSTREAM size limit exceeded. ERROR\0" : payload.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE") ? "stream: Win.Test.EICAR_HDB-1 FOUND\0" : "stream: OK\0";
          socket.end(reply);
          return;
        }
        if (buf.length < 4 + len) return;
        payload = Buffer.concat([payload, buf.subarray(4, 4 + len)]);
        buf = buf.subarray(4 + len);
      }
    });
  });
}

let base: Awaited<ReturnType<typeof testCtx>>;
let ctx: ToolContext;
beforeAll(async () => {
  clamd = fakeClamd();
  await new Promise<void>((r) => clamd.listen(0, "127.0.0.1", r));
  port = (clamd.address() as { port: number }).port;
  base = await testCtx();
  ctx = { ...base.ctx, av: clamdScanner({ host: "127.0.0.1", port, timeoutMs: 3000 }) };
});
afterAll(async () => {
  await new Promise((r) => clamd.close(r));
  await base.close();
});

const call = (c: ToolContext, name: string, args: unknown) => TOOLS.find((t) => t.name === name)!.handler(c, args as never);
const session = async (c: ToolContext) => ((await call(c, "iniciar_sessao", {})).dados as { sessao_id: string }).sessao_id;
const inline = (files: Record<string, string>) => Object.entries(files).map(([caminho, c]) => ({ caminho, conteudo_base64: Buffer.from(strToU8(c)).toString("base64") }));

describe("clamd client", () => {
  it("streams the bytes in framed chunks and reads the verdict, also for files larger than one chunk", async () => {
    expect(await scanStream({ host: "127.0.0.1", port }, strToU8("<h1>oi</h1>"))).toEqual({ status: "clean" });
    expect(await scanStream({ host: "127.0.0.1", port }, strToU8(EICAR))).toEqual({ status: "infected", signature: "Win.Test.EICAR_HDB-1" });
    const big = new Uint8Array(300 * 1024).fill(65);
    big.set(strToU8(EICAR), 200 * 1024 + 7); // the signature sits in the middle of a later chunk
    expect(await scanStream({ host: "127.0.0.1", port }, big)).toMatchObject({ status: "infected" });
  });

  it("an unreachable daemon or an ERROR answer is 'error', never 'clean'", async () => {
    expect(await scanStream({ host: "127.0.0.1", port: 1, timeoutMs: 500 }, strToU8("x"))).toEqual({ status: "error" });
    mode = "error";
    expect(await scanStream({ host: "127.0.0.1", port }, strToU8("x"))).toEqual({ status: "error" });
    mode = "normal";
  });

  it("the scanner reports every infected path and whether all files were scanned", async () => {
    const av = clamdScanner({ host: "127.0.0.1", port, concurrency: 3 });
    const files = new Map([["a.html", strToU8("ok")], ["dir/b.txt", strToU8(EICAR)], ["c.css", strToU8("ok")], ["d.js", strToU8(EICAR)]]);
    const v = await av(files);
    expect(v.complete).toBe(true);
    expect(v.infected.map((f) => f.path).sort()).toEqual(["d.js", "dir/b.txt"]);
  });
});

describe("uploads with the antivirus on", () => {
  it("a clean site passes and every published file went through the daemon", async () => {
    const before = streams;
    const sessao_id = await session(ctx);
    const r = await call(ctx, "enviar_arquivos", { sessao_id, arquivos: inline({ "index.html": "<h1>Meu site</h1>", "a.css": "body{}" }) });
    expect(r).toMatchObject({ ok: true, codigo: "ARQUIVOS_RECEBIDOS" });
    expect(streams - before).toBe(2);
  });

  it("a file the antivirus flags blocks the whole upload, with the fixed message and no file names", async () => {
    const sessao_id = await session(ctx);
    const r = await call(ctx, "enviar_arquivos", { sessao_id, arquivos: inline({ "index.html": "ok", "segredo.txt": EICAR }) });
    expect(r).toMatchObject({ ok: false, codigo: "ARQUIVOS_REPROVADOS" });
    expect(JSON.stringify(r)).not.toMatch(/segredo|EICAR/);
    const [u] = await base.ctx.db.query<{ scan_status: string; scan_report: { code: string }[] }>("SELECT scan_status, scan_report FROM uploads WHERE scan_status = 'blocked' ORDER BY created_at DESC LIMIT 1");
    expect([u!.scan_status, u!.scan_report.map((f) => f.code)]).toEqual(["blocked", ["MALWARE"]]);
  });

  it("with the daemon down the upload still goes through, marked as not fully scanned", async () => {
    const down: ToolContext = { ...base.ctx, av: clamdScanner({ host: "127.0.0.1", port: 1, timeoutMs: 500 }) };
    const sessao_id = await session(down);
    const r = await call(down, "enviar_arquivos", { sessao_id, arquivos: inline({ "index.html": "<h1>oi</h1>" }) });
    expect(r).toMatchObject({ ok: true });
    const [u] = await base.ctx.db.query<{ scan_report: { code: string }[] }>("SELECT scan_report FROM uploads ORDER BY created_at DESC LIMIT 1");
    expect(u!.scan_report.map((f) => f.code)).toContain("AV_INCOMPLETE");
  });

  it("without CLAMAV_HOST nothing changes", async () => {
    const sessao_id = await session(base.ctx);
    expect(await call(base.ctx, "enviar_arquivos", { sessao_id, arquivos: inline({ "index.html": "x" }) })).toMatchObject({ ok: true });
  });
});
