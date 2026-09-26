import { execFile } from "node:child_process";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Envelope, ToolName } from "../../packages/shared/src/index.js";
import { syncAgentTokens } from "../../apps/mcp-service/src/agent.js";
import type { Db } from "../../apps/mcp-service/src/db/index.js";
import { TOOLS } from "../../apps/mcp-service/src/mcp/tools/index.js";
import type { ToolContext } from "../../apps/mcp-service/src/mcp/tools/define.js";
import { buildApp } from "../../apps/mcp-service/src/server.js";
import { findSession } from "../../apps/mcp-service/src/sessions.js";
import { testCtx, type MemoryStorage } from "../helpers.js";

// The REAL deploy agent (bash, run as root) against the REAL Node service, inside a container that mimics a
// Plesk server (site user + psacln group, fake `plesk` CLI, Host-based web server). Async execFile on purpose:
// the service lives in this process and must keep answering while the container works.
// Needs Docker; opt in with:  AGENT_E2E=1 pnpm test
const enabled = process.env.AGENT_E2E === "1";
const run = promisify(execFile);
const TOKEN = "f6".repeat(32);
const V = "/var/www/vhosts";

describe.skipIf(!enabled)("deploy agent (bash, root) against the real service", () => {
  let ctx: ToolContext;
  let db: Db;
  let storage: MemoryStorage;
  let close: () => Promise<void>;
  let app: ReturnType<typeof buildApp>;
  let port: number;
  let ctr = "";

  const dx = async (cmd: string) => (await run("docker", ["exec", ctr, "bash", "-c", cmd])).stdout.trim();
  const dxFail = async (cmd: string) => {
    try {
      await run("docker", ["exec", ctr, "bash", "-c", cmd]);
      return 0;
    } catch (e) {
      return (e as { code: number }).code;
    }
  };
  async function agent(env: Record<string, string> = {}) {
    const args = ["exec", "-e", `WC_API=http://host.docker.internal:${port}/agent/v1`, "-e", `WC_TOKEN=${TOKEN}`, "-e", "WC_ONCE=1", "-e", "WC_PLESK=/usr/local/bin/plesk", "-e", "WC_LE_EMAIL=ops@test.local", "-e", "WC_CHECK_HTTP_PORT=8088", "-e", "WC_CHECK_HTTPS_PORT=8443"];
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    try {
      const r = await run("docker", [...args, ctr, "/agent/waycloud-agent.sh"]);
      if (process.env.DEBUG_AGENT) console.log("AGENT>>", r.stdout);
      return { code: 0, out: r.stdout };
    } catch (e) {
      const x = e as { code: number; stdout: string };
      return { code: x.code, out: x.stdout };
    }
  }

  beforeAll(async () => {
    ({ ctx, db, storage, close } = await testCtx());
    app = buildApp(ctx);
    await app.listen({ port: 0, host: "0.0.0.0" });
    port = (app.server.address() as AddressInfo).port;
    await syncAgentTokens(db, `agent-test:${TOKEN}`);
    await run("docker", ["build", "-q", "-t", "wc-agent-test", "tests/agent"]);
    ctr = (await run("docker", ["run", "-d", "--rm", "-v", `${process.cwd()}/agent:/agent:ro`, "wc-agent-test"])).stdout.trim();
    await run("docker", ["exec", "-d", ctr, "python3", "/usr/local/bin/webserver.py"]);
    await new Promise((r) => setTimeout(r, 1000));
  }, 300_000);
  afterAll(async () => {
    if (ctr) await run("docker", ["rm", "-f", ctr]).catch(() => {});
    await app.close();
    await close();
  });

  const call = (name: ToolName, args: unknown) => TOOLS.find((t) => t.name === name)!.handler(ctx, args as never);
  const b64 = (s: string) => Buffer.from(strToU8(s)).toString("base64");
  const files = (o: Record<string, string>) => Object.entries(o).map(([caminho, c]) => ({ caminho, conteudo_base64: b64(c) }));

  let n = 0;
  /** A paid session whose site already lives on the fake Plesk server with an OLD version. */
  async function site(old = "OLD") {
    const domain = `site${++n}.sites.test`;
    await dx(`mkdir -p ${V}/${domain}/httpdocs && echo '${old}' > ${V}/${domain}/httpdocs/index.html && chown -R wcuser:psacln ${V}/${domain} && chmod 750 ${V}/${domain}/httpdocs`);
    const token = ((await call("iniciar_sessao", {})).dados as { sessao_id: string }).sessao_id;
    const uuid = (await findSession(db, token))!.id;
    const service = 9000 + n;
    await db.query("INSERT INTO orders (session_id, status, whmcs_service_id) VALUES ($1, 'active', $2)", [uuid, service]);
    await db.query("INSERT INTO subscriptions (whmcs_service_id, session_id, server_id, domain, plan_pid) VALUES ($1, $2, 'agent-test', $3, 223)", [service, uuid, domain]);
    return { token, uuid, domain };
  }
  const publish = async (s: { token: string }, f: Record<string, string>) => {
    await call("enviar_arquivos", { sessao_id: s.token, arquivos: files(f) });
    const r = (await call("publicar", { sessao_id: s.token })) as Envelope<{ deploy_id: string }>;
    expect(r.codigo, JSON.stringify(r)).toBe("DEPLOY_INICIADO");
    return r.dados!.deploy_id;
  };
  const statusOf = async (s: { token: string }, id: string) => (await call("status_deploy", { sessao_id: s.token, deploy_id: id })).dados as { status: string; url: string | null; https_ativo: boolean | null };
  const doc = (d: string) => `${V}/${d}/httpdocs`;
  const snaps = (d: string) => dx(`ls ${V}/.waycloud-agent/${d}/snapshots 2>/dev/null | wc -l`);

  it("publishes atomically: new files in place, previous version kept as a snapshot, ownership and permissions preserved", async () => {
    const s = await site("OLD");
    const id = await publish(s, { "index.html": "NEW-1", "css/a.css": "b{}" });
    const r = await agent();
    expect(r.code, r.out).toBe(0);

    expect(await dx(`cat ${doc(s.domain)}/index.html`)).toBe("NEW-1");
    expect(await dx(`cat ${doc(s.domain)}/css/a.css`)).toBe("b{}");
    expect(await dx(`stat -c '%U:%G %a' ${doc(s.domain)}`)).toBe("wcuser:psacln 750"); // same as the previous docroot
    expect(await dx(`stat -c '%U:%G %a' ${doc(s.domain)}/index.html`)).toBe("wcuser:psacln 644");
    expect(await dx(`stat -c '%U %a' ${V}/.waycloud-agent`)).toBe("root 700"); // work area is root-only
    expect(await snaps(s.domain)).toBe("1");
    expect(await dx(`cat ${V}/.waycloud-agent/${s.domain}/snapshots/*/index.html`)).toBe("OLD");
    expect(await dx(`ls ${V}/.waycloud-agent/${s.domain}/releases | wc -l`)).toBe("0"); // nothing left behind
    expect(await dx(`ls /var/lib/waycloud-agent | grep -c zip || true`)).toBe("0");

    // no real certificate in the fake server: the site is live over http and the agent asked Plesk for one
    expect(await dx("cat /tmp/plesk.log")).toContain(`bin extension --exec letsencrypt cli.php -d ${s.domain} -m ops@test.local`);
    expect(await statusOf(s, id)).toEqual({ status: "publicado", url: `http://${s.domain}`, https_ativo: false, intervalo_sugerido_segundos: 0 });
  }, 120_000);

  it("without a certificate the HTTP->HTTPS redirect stays off and the site is retried; once the certificate exists the redirect turns on and the service is told", async () => {
    const s = await site("OLD");
    const id = await publish(s, { "index.html": "NEW-SSL" });
    expect((await agent()).code).toBe(0);
    const plesk = () => dx("cat /tmp/plesk.log");
    expect(await plesk()).toContain(`bin site --update ${s.domain} -ssl-redirect false`); // a redirect to a missing certificate would lock visitors out
    expect(await plesk()).not.toContain(`${s.domain} -ssl-redirect true`);
    expect(await dx(`cat /var/lib/waycloud-agent/ssl-pending/${s.domain}`)).toMatch(new RegExp(`^${id} \\d+ 0 \\d+$`));
    expect(await statusOf(s, id)).toMatchObject({ https_ativo: false });

    // Not due yet: another poll changes nothing.
    expect((await agent()).code).toBe(0);
    expect(await dxFail(`test -e /var/lib/waycloud-agent/ssl-pending/${s.domain}`)).toBe(0);

    // The certificate shows up (a self-signed one whose issuer is "Let's Encrypt") and the retry becomes due.
    await dx(`openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/le.key -out /tmp/le.crt -days 1 -subj "/O=Let's Encrypt/CN=${s.domain}" 2>/dev/null`);
    await dx(`(openssl s_server -accept 8443 -cert /tmp/le.crt -key /tmp/le.key -www >/tmp/s_server.log 2>&1 &) ; sleep 1`);
    await dx(`sed -i 's/ [0-9]*$/ 0/' /var/lib/waycloud-agent/ssl-pending/${s.domain}`); // next attempt: now
    expect((await agent()).code).toBe(0);
    await dx("pkill -x openssl || true");

    expect(await plesk()).toContain(`bin site --update ${s.domain} -ssl-redirect true`);
    expect(await dxFail(`test -e /var/lib/waycloud-agent/ssl-pending/${s.domain}`)).toBe(1); // no longer pending
    expect(await statusOf(s, id)).toMatchObject({ https_ativo: true, url: `https://${s.domain}` });
  }, 180_000);

  it("a corrupted package (hash mismatch) fails before touching the live site", async () => {
    const s = await site("KEEP-ME");
    const id = await publish(s, { "index.html": "EVIL" });
    const [d] = await db.query<{ package_key: string }>("SELECT package_key FROM deploys WHERE id = $1", [id]);
    const zip = new Uint8Array(storage.objects.get(d!.package_key)!);
    zip[zip.length - 30] = (zip[zip.length - 30]! + 1) % 256; // same size, different bytes
    storage.objects.set(d!.package_key, zip);

    expect((await agent()).code).toBe(0);
    expect(await dx(`cat ${doc(s.domain)}/index.html`)).toBe("KEEP-ME");
    expect(await snaps(s.domain)).toBe("0");
    expect(await statusOf(s, id)).toMatchObject({ status: "falhou", url: null });
    const [row] = await db.query<{ error_code: string }>("SELECT error_code FROM deploys WHERE id = $1", [id]);
    expect(row!.error_code).toBe("sha256_mismatch");
  }, 120_000);

  it("a site that answers 500 after the swap is rolled back automatically (never half-published)", async () => {
    const s = await site("GOOD-OLD");
    const id = await publish(s, { "index.html": "BROKEN-NEW", ".fail": "" });
    expect((await agent()).code).toBe(0);

    expect(await dx(`cat ${doc(s.domain)}/index.html`)).toBe("GOOD-OLD"); // the previous version is back
    expect(await dx(`test -e ${doc(s.domain)}/.fail && echo present || echo absent`)).toBe("absent");
    expect(await dx(`cat ${V}/.waycloud-agent/${s.domain}/failed/${id}/index.html`)).toBe("BROKEN-NEW"); // kept for diagnosis
    expect(await statusOf(s, id)).toMatchObject({ status: "revertido", url: null });
    expect(await dx(`stat -c '%U:%G' ${doc(s.domain)}`)).toBe("wcuser:psacln");
    // and the site can be published again afterwards
    const again = await publish(s, { "index.html": "FIXED" });
    expect((await agent()).code).toBe(0);
    expect(await dx(`cat ${doc(s.domain)}/index.html`)).toBe("FIXED");
    expect((await statusOf(s, again)).status).toBe("publicado");
  }, 180_000);

  it("a package without an index file is refused", async () => {
    const s = await site("KEEP-ME");
    const id = await publish(s, { "about.html": "<p>about</p>" });
    expect((await agent()).code).toBe(0);
    expect(await dx(`cat ${doc(s.domain)}/index.html`)).toBe("KEEP-ME");
    const [row] = await db.query<{ error_code: string; status: string }>("SELECT error_code, status FROM deploys WHERE id = $1", [id]);
    expect(row).toEqual({ error_code: "no_index", status: "failed" });
  }, 120_000);

  it("PHP: sets the Plesk PHP handler for the site; if Plesk refuses, the deploy is rolled back", async () => {
    const php = { "index.php": "<?php echo 1;", "composer.json": JSON.stringify({ require: { php: "^8.1" } }) };
    const ok = await site("OLD-PHP");
    await dx("rm -f /tmp/plesk.log /tmp/plesk-fail-php");
    const id = await publish(ok, php);
    expect((await agent()).code).toBe(0);
    expect(await dx("cat /tmp/plesk.log")).toContain(`bin site --update ${ok.domain} -php_handler_id plesk-php83-fpm`);
    expect((await statusOf(ok, id)).status).toBe("publicado");

    const bad = await site("OLD-PHP-2");
    await dx("touch /tmp/plesk-fail-php");
    const id2 = await publish(bad, php);
    expect((await agent()).code).toBe(0);
    await dx("rm -f /tmp/plesk-fail-php");
    expect(await dx(`cat ${doc(bad.domain)}/index.html`)).toBe("OLD-PHP-2");
    expect((await statusOf(bad, id2)).status).toBe("revertido");
  }, 180_000);

  it("keeps only the newest N snapshots", async () => {
    const s = await site("V0");
    for (let i = 1; i <= 4; i++) {
      const id = await publish(s, { "index.html": `V${i}` });
      await db.query("UPDATE deploys SET params = jsonb_set(params, '{keep}', '2') WHERE id = $1", [id]);
      expect((await agent()).code).toBe(0);
    }
    expect(await dx(`cat ${doc(s.domain)}/index.html`)).toBe("V4");
    expect(await snaps(s.domain)).toBe("2");
    expect(await dx(`cat $(ls -1dt ${V}/.waycloud-agent/${s.domain}/snapshots/* | head -1)/index.html`)).toBe("V3"); // the newest snapshot is the previous version
  }, 300_000);

  it("refuses hostile jobs: bad domains and symlinked vhosts touch nothing outside the site", async () => {
    await dx("mkdir -p /etc/wc-canary/httpdocs && echo safe > /etc/wc-canary/httpdocs/index.html"); // a REAL docroot behind the symlink
    const a = await site();
    const idA = await publish(a, { "index.html": "X" });
    await db.query("UPDATE subscriptions SET domain = '../../../tmp/pwn' WHERE session_id = $1", [a.uuid]);
    expect((await agent()).code).toBe(0);
    expect(await dx("test -e /tmp/pwn && echo created || echo untouched")).toBe("untouched");
    expect((await db.query<{ error_code: string }>("SELECT error_code FROM deploys WHERE id = $1", [idA]))[0]!.error_code).toBe("invalid_domain");

    const b = await site();
    const idB = await publish(b, { "index.html": "Y" });
    await dx(`rm -rf ${V}/${b.domain} && ln -s /etc/wc-canary ${V}/${b.domain}`);
    expect((await agent()).code).toBe(0);
    expect(await dx("cat /etc/wc-canary/httpdocs/index.html")).toBe("safe");
    expect(await dx("ls /etc/wc-canary")).toBe("httpdocs"); // nothing was swapped or written through the symlink
    expect(await dx("ls -A /etc/wc-canary/httpdocs")).toBe("index.html");
    expect((await db.query<{ error_code: string }>("SELECT error_code FROM deploys WHERE id = $1", [idB]))[0]!.error_code).toBe("vhost_not_found");

    for (const bad of ["UPPER.sites.test", "a..b.sites.test", "-x.sites.test", "single", "a b.sites.test", "x.sites.test/../y"]) {
      const c = await site();
      const idC = await publish(c, { "index.html": "Z" });
      await db.query("UPDATE subscriptions SET domain = $2 WHERE session_id = $1", [c.uuid, bad]);
      expect((await agent()).code).toBe(0);
      expect((await db.query<{ error_code: string }>("SELECT error_code FROM deploys WHERE id = $1", [idC]))[0]!.error_code, bad).toBe("invalid_domain");
    }
  }, 300_000);

  it("a wrong token never gets a job (exit 2) and leaves the queue alone", async () => {
    const s = await site("STAY");
    const id = await publish(s, { "index.html": "NOPE" });
    const r = await agent({ WC_TOKEN: "00".repeat(32) });
    expect(r.code).toBe(2);
    expect(r.out).toContain("token rejected");
    expect(await dx(`cat ${doc(s.domain)}/index.html`)).toBe("STAY");
    expect((await db.query<{ status: string }>("SELECT status FROM deploys WHERE id = $1", [id]))[0]!.status).toBe("queued");
    expect((await agent()).code).toBe(0); // with the right token it proceeds
  }, 120_000);

  it("only one agent instance runs at a time", async () => {
    const holder = run("docker", ["exec", "-e", "WC_API=http://host.docker.internal:1/agent/v1", "-e", `WC_TOKEN=${TOKEN}`, "-e", "WC_INTERVAL=30", ctr, "timeout", "8", "/agent/waycloud-agent.sh"]).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
    const second = await agent();
    expect(second.code).toBe(1);
    expect(second.out).toContain("another agent instance");
    await holder;
    expect(await dxFail("true")).toBe(0);
  }, 60_000);
});
