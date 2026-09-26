import { execFile } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { strToU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Envelope, ToolName } from "../../packages/shared/src/index.js";
import { syncAgentTokens } from "../../apps/mcp-service/src/agent.js";
import type { Db } from "../../apps/mcp-service/src/db/index.js";
import { TOOLS } from "../../apps/mcp-service/src/mcp/tools/index.js";
import type { ToolContext } from "../../apps/mcp-service/src/mcp/tools/define.js";
import { requestDomain } from "../../apps/mcp-service/src/domains.js";
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
  async function agent(env: Record<string, string> = {}, script = "/agent/waycloud-agent.sh") {
    const args = ["exec", "-e", `WC_API=http://host.docker.internal:${port}/agent/v1`, "-e", `WC_TOKEN=${TOKEN}`, "-e", "WC_ONCE=1", "-e", "WC_AUTOUPDATE=0", "-e", "WC_PLESK=/usr/local/bin/plesk", "-e", "WC_LE_EMAIL=ops@test.local", "-e", "WC_CHECK_HTTP_PORT=8088", "-e", "WC_CHECK_HTTPS_PORT=8443"];
    for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
    try {
      const r = await run("docker", [...args, ctr, script]);
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
  const makeDue = (file: string) => dx(`f=/var/lib/waycloud-agent/ssl-pending/${file}; awk '{$4=0; print}' $f > $f.new && mv $f.new $f`); // next attempt: now
  const dnsOk = { resolve4: async () => ["203.0.113.5"], resolveNs: async () => Promise.reject(new Error("no ns")) }; // every name (target, domain, www) points to "us"
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
    expect(await dx(`cat /var/lib/waycloud-agent/ssl-pending/${s.domain}@deploy`)).toMatch(new RegExp(`^${id} \\d+ 0 \\d+ false$`));
    expect(await statusOf(s, id)).toMatchObject({ https_ativo: false });

    // Not due yet: another poll changes nothing.
    expect((await agent()).code).toBe(0);
    expect(await dxFail(`test -e /var/lib/waycloud-agent/ssl-pending/${s.domain}@deploy`)).toBe(0);

    // The certificate shows up (a self-signed one whose issuer is "Let's Encrypt") and the retry becomes due.
    await dx(`openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/le.key -out /tmp/le.crt -days 1 -subj "/O=Let's Encrypt/CN=${s.domain}" 2>/dev/null`);
    await dx(`(openssl s_server -accept 8443 -cert /tmp/le.crt -key /tmp/le.key -www >/tmp/s_server.log 2>&1 &) ; sleep 1`);
    await makeDue(`${s.domain}@deploy`);
    expect((await agent()).code).toBe(0);
    await dx("pkill -x openssl || true");

    expect(await plesk()).toContain(`bin site --update ${s.domain} -ssl-redirect true`);
    expect(await dxFail(`test -e /var/lib/waycloud-agent/ssl-pending/${s.domain}@deploy`)).toBe(1); // no longer pending
    expect(await statusOf(s, id)).toMatchObject({ https_ativo: true, url: `https://${s.domain}` });
  }, 180_000);

  describe("the customer's own domain", () => {
    const state = async (uuid: string) => (await db.query<{ status: string; error_code: string | null; ssl: boolean | null; id: string }>("SELECT c.id, c.status, c.error_code, c.ssl FROM domain_changes c JOIN subscriptions s ON s.whmcs_service_id = c.subscription_id WHERE s.session_id = $1 ORDER BY c.created_at DESC LIMIT 1", [uuid]))[0]!;
    const subDomain = async (uuid: string) => (await db.query<{ domain: string }>("SELECT domain FROM subscriptions WHERE session_id = $1", [uuid]))[0]!.domain;
    /** A site that is live on its provisional domain, with a request for `dom` whose DNS is already right. */
    async function readyForSwitch(dom: string) {
      ctx.resolver = dnsOk;
      const s = await site("OLD");
      const id = await publish(s, { "index.html": `LIVE-${dom}` });
      expect((await agent()).code).toBe(0); // the deploy
      const r = await requestDomain(ctx, s.uuid, dom);
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect((await state(s.uuid)).status).toBe("ready");
      return { s, id };
    }

    it("switches the site: Plesk renames it, the folder and the rollback snapshots follow, HTTPS is asked for the domain and www, the service is told and the redirect turns on once the certificate exists", async () => {
      const dom = "cliente-um.test";
      const { s, id } = await readyForSwitch(dom);
      const old = s.domain;
      expect((await agent()).code).toBe(0);

      expect(await dx(`cat ${doc(dom)}/index.html`)).toBe(`LIVE-${dom}`);
      expect(await dxFail(`test -e ${V}/${old}`)).toBe(1); // the provisional domain is gone
      expect(await dxFail(`test -d ${V}/.waycloud-agent/${dom}/snapshots`)).toBe(0); // snapshots followed the site
      expect(await dxFail(`test -e ${V}/.waycloud-agent/${old}`)).toBe(1);
      const plesk = await dx("cat /tmp/plesk.log");
      expect(plesk).toContain(`subscription --update ${old} -new-name ${dom}`);
      expect(plesk).toContain(`letsencrypt cli.php -d ${dom} -d www.${dom} -m ops@test.local`);
      expect(plesk).toContain(`bin site --update ${dom} -ssl-redirect false`);

      const st = await state(s.uuid);
      expect([st.status, st.ssl, await subDomain(s.uuid)]).toEqual(["active", false, dom]);
      expect((await statusOf(s, id)).url).toBe(`http://${dom}`); // one address for everything: the deploy status follows the new domain
      expect(await dx(`cat /var/lib/waycloud-agent/ssl-pending/${dom}@domain`)).toMatch(new RegExp(`^${st.id} \\d+ 0 \\d+ true$`));

      // A later deploy lands on the new domain's folder.
      const id2 = await publish(s, { "index.html": "SECOND" });
      expect((await agent()).code).toBe(0);
      expect(await dx(`cat ${doc(dom)}/index.html`)).toBe("SECOND");
      expect((await statusOf(s, id2)).status).toBe("publicado");

      // The certificate shows up: the retry reports it for the DOMAIN job and turns the redirect on.
      await dx(`openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/le2.key -out /tmp/le2.crt -days 1 -subj "/O=Let's Encrypt/CN=${dom}" 2>/dev/null`);
      await dx(`(openssl s_server -accept 8443 -cert /tmp/le2.crt -key /tmp/le2.key -www >/tmp/s_server2.log 2>&1 &) ; sleep 1`);
      await makeDue(`${dom}@domain`);
      await makeDue(`${dom}@deploy`);
      expect((await agent()).code).toBe(0);
      await dx("pkill -x openssl || true");
      expect(await dx("cat /tmp/plesk.log")).toContain(`bin site --update ${dom} -ssl-redirect true`);
      expect((await state(s.uuid)).ssl).toBe(true);
      expect(await dxFail(`test -e /var/lib/waycloud-agent/ssl-pending/${dom}@domain`)).toBe(1);
      expect(await dxFail(`test -e /var/lib/waycloud-agent/ssl-pending/${dom}@deploy`)).toBe(1); // the second deploy is told as well
    }, 240_000);

    it("a rename that Plesk refuses changes nothing, and the agent sends its diagnostics to the service", async () => {
      const dom = "cliente-dois.test";
      const { s } = await readyForSwitch(dom);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await dx("touch /tmp/plesk-fail-rename");
      expect((await agent()).code).toBe(0);
      await dx("rm -f /tmp/plesk-fail-rename");
      const diag = log.mock.calls.flat().map(String).filter((l) => l.includes("agent diag")).map((l) => JSON.parse(l) as { kind: string; text: string });
      log.mockRestore();
      const text = diag.find((d) => d.kind === "rename_failed")?.text ?? "";
      expect(text).toContain(`switching ${s.domain} -> ${dom}`); // the tail of the agent's own log says what it was doing
      expect(text).toContain("report=failed step=rename code=rename_failed");
      expect(await state(s.uuid)).toMatchObject({ status: "failed", error_code: "rename_failed" });
      expect(await subDomain(s.uuid)).toBe(s.domain);
      expect(await dx(`cat ${doc(s.domain)}/index.html`)).toBe(`LIVE-${dom}`); // the site is still where it was
    }, 240_000);

    it("nameserver mode: the switch runs before any A record exists, and the agent checks that Plesk has the DNS zone", async () => {
      ctx.resolver = { resolve4: async () => Promise.reject(new Error("no A yet")), resolveNs: async (h) => (h === "cliente-ns.test" ? ctx.settings.nameservers : Promise.reject(new Error("no ns"))) };
      const s = await site("OLD");
      await publish(s, { "index.html": "LIVE-NS" });
      expect((await agent()).code).toBe(0);
      const r = await requestDomain(ctx, s.uuid, "cliente-ns.test");
      expect(r.ok, JSON.stringify(r)).toBe(true);
      expect((await state(s.uuid)).status).toBe("ready");
      expect((await agent()).code).toBe(0);
      expect(await state(s.uuid)).toMatchObject({ status: "active" });
      expect(await dx(`cat ${doc("cliente-ns.test")}/index.html`)).toBe("LIVE-NS");
      const plesk = await dx("cat /tmp/plesk.log");
      expect(plesk).toContain("bin dns --info cliente-ns.test"); // the zone check of nameserver mode
      expect(plesk).toContain("letsencrypt cli.php -d cliente-ns.test -d www.cliente-ns.test"); // www is in our zone
    }, 240_000);

    it("if the folder does not move with the rename, Plesk is put back and the site stays as it was", async () => {
      const dom = "cliente-tres.test";
      const { s } = await readyForSwitch(dom);
      await dx("touch /tmp/plesk-keep-dir");
      expect((await agent()).code).toBe(0);
      await dx("rm -f /tmp/plesk-keep-dir");
      expect(await state(s.uuid)).toMatchObject({ status: "failed", error_code: "docroot_not_moved" });
      expect(await dx("cat /tmp/plesk.log")).toContain(`subscription --update ${dom} -new-name ${s.domain}`); // reverted
      expect(await subDomain(s.uuid)).toBe(s.domain);
      expect(await dx(`cat ${doc(s.domain)}/index.html`)).toBe(`LIVE-${dom}`);
    }, 240_000);
  });

  describe("self-update from the service (signed, newer, parses, passes its self-test)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wc-agent-dir-"));
    const good = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = good.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
    const base = readFileSync("agent/waycloud-agent.sh", "utf8");
    /** The real script with the test public key and a given version. */
    const variant = (version: string, extra = "") => base.replace(/WC_SIGN_PUB='[^']+'/, `WC_SIGN_PUB='${pem}'`).replace(/WC_AGENT_VERSION="[^"]+"/, `WC_AGENT_VERSION="${version}"`) + extra;
    const serve = (script: string, signer = good.privateKey) => {
      writeFileSync(join(dir, "waycloud-agent.sh"), script);
      writeFileSync(join(dir, "waycloud-agent.sh.sig"), createSign("sha256").update(script).sign(signer).toString("base64"));
    };
    const installOld = async (version = "2000-01-01.01") => {
      writeFileSync(join(dir, "old.sh"), variant(version));
      await run("docker", ["cp", join(dir, "old.sh"), `${ctr}:/tmp/old-agent.sh`]);
      await dx("chmod 750 /tmp/old-agent.sh");
    };
    const update = () => agent({ WC_AUTOUPDATE: "1", WC_UPDATE_INTERVAL: "0" }, "/tmp/old-agent.sh");
    const versionOf = () => dx(`sed -n 's/^WC_AGENT_VERSION="\\(.*\\)"$/\\1/p' /tmp/old-agent.sh`);
    beforeAll(() => void (ctx.settings.agentDir = dir));
    afterAll(() => void (ctx.settings.agentDir = undefined));

    it("installs a newer, correctly signed version and keeps working", async () => {
      await installOld();
      serve(variant("2999-01-01.01"));
      const r = await update();
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("update: installed 2999-01-01.01 (was 2000-01-01.01), restarting");
      expect(r.out).toContain("agent started version=2999-01-01.01"); // the new one took over in the same run
      expect(await versionOf()).toBe("2999-01-01.01");
      expect(await dx("stat -c '%U %a' /tmp/old-agent.sh")).toBe("root 750");
    }, 120_000);

    it("ignores a script signed with another key", async () => {
      await installOld();
      serve(variant("2999-01-01.01"), other.privateKey);
      const r = await update();
      expect(r.out).toContain("signature check FAILED");
      expect(await versionOf()).toBe("2000-01-01.01");
    }, 120_000);

    it("ignores a correctly signed but older (replayed) version, and a newer one that does not parse or fails its self-test", async () => {
      await installOld("2500-01-01.01");
      serve(variant("2400-01-01.01"));
      expect((await update()).out).toContain("is not newer than");

      serve(variant("2999-01-01.01", "\nthis is ( not valid bash\n"));
      expect((await update()).out).toContain("does not parse");

      serve(variant("2999-01-01.01").replace('echo "waycloud-agent $WC_AGENT_VERSION ok"', 'echo "broken"'));
      expect((await update()).out).toContain("failed its self-test");
      expect(await versionOf()).toBe("2500-01-01.01");
    }, 180_000);

    it("does nothing when the script is already current", async () => {
      await installOld("2000-01-01.01");
      serve(variant("2000-01-01.01"));
      const r = await update();
      expect(r.out).not.toContain("update:");
      expect(await versionOf()).toBe("2000-01-01.01");
    }, 120_000);
  });

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
