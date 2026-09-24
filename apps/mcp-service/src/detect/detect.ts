import semver from "semver";
import { AVISOS, type Analise, type AvisoCodigo, type Manifesto, type TipoProjeto } from "@waycloud/shared";
import type { Plan } from "../plans.js";
import { normalizePath, safeEchoPath } from "../security/sanitize.js";

const GB = 1024 ** 3;
const SPA_TOOLS = ["vite", "react-scripts", "@vue/cli-service", "@angular/cli", "astro", "parcel", "gatsby"];
const SERVER_DEPS = ["express", "fastify", "koa", "@nestjs/core", "@hapi/hapi", "hapi", "next", "nuxt"];
const DB_DEPS = ["mysql", "mysql2", "pg", "mongoose", "mongodb", "sequelize", "prisma", "@prisma/client", "typeorm", "knex", "better-sqlite3"];
const MAIL_DEPS = ["nodemailer", "@sendgrid/mail", "resend", "phpmailer/phpmailer", "symfony/mailer", "swiftmailer/swiftmailer"];
const FORBIDDEN_EXT = /\.(exe|dll|so|dylib|bat|cmd|scr|msi|com|vbs|ps1)$/i;
// Handlers installed on the Plesk server (verified 2026-09-23), in order of preference.
const PHP_VERSIONS = ["8.3", "8.4", "8.2", "8.1", "8.0", "7.4"];

type Json = Record<string, unknown>;
const parseJson = (s?: string): Json | null => {
  try {
    const v: unknown = s ? JSON.parse(s) : null;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
};
const keys = (o: unknown): string[] => (o && typeof o === "object" ? Object.keys(o) : []);
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

// Finds the shallowest folder (max 3 levels below a root) that holds an index.html, e.g. dist/app/browser.
function findIndexDir(paths: string[], roots: string[]): string | null {
  for (const root of roots) {
    const hits = paths.filter((p) => p.startsWith(root + "/") && base(p) === "index.html" && p.split("/").length <= 4);
    if (hits.length) return hits.reduce((a, b) => (a.length <= b.length ? a : b)).slice(0, -"/index.html".length);
  }
  return null;
}

function pickPhpVersion(constraint: string | undefined): { version: string; found: boolean } {
  if (!constraint) return { version: "8.3", found: true };
  // Composer allows a single "|" as OR and "," as AND; semver wants "||" and spaces.
  const range = constraint.replace(/(?<!\|)\|(?!\|)/g, "||").replace(/,/g, " ");
  const match = PHP_VERSIONS.find((v) => semver.validRange(range, { loose: true }) && semver.satisfies(`${v}.0`, range, { loose: true }));
  return match ? { version: match, found: true } : { version: "8.3", found: false };
}

// `folder` is the real output folder for internal use (previews, deploys); the public `pasta_publicar`
// is echoed to the AI and therefore sanitized (see safeEchoPath).
export function analyzeProject(m: Manifesto, plans: Plan[]): { analise: Analise; folder: string | null } {
  const avisos = new Set<AvisoCodigo>();
  const files: { path: string; size: number }[] = [];
  for (const f of m.arquivos) {
    const p = normalizePath(f.caminho);
    if (!p) avisos.add("CAMINHO_INVALIDO");
    else if (/(^|\/)node_modules(\/|$)/.test(p)) avisos.add("NODE_MODULES_IGNORADO");
    else if (!/(^|\/)\.git(\/|$)/.test(p)) files.push({ path: p, size: f.tamanho });
  }
  const paths = files.map((f) => f.path);
  const has = (name: string) => paths.includes(name);
  const total = files.reduce((s, f) => s + f.size, 0);

  const pkg = parseJson(m.package_json);
  const composer = parseJson(m.composer_json);
  const prodDeps = keys(pkg?.dependencies);
  const allDeps = [...prodDeps, ...keys(pkg?.devDependencies)];
  const composerReq = keys(composer?.require);

  const hasEnv = paths.some((p) => /^\.env(\..+)?$/.test(base(p)) && !/\.(example|sample|template|dist)$/.test(base(p)));
  const hasSql = paths.some((p) => p.toLowerCase().endsWith(".sql"));
  const phpFiles = paths.filter((p) => /\.(php|phtml)$/i.test(p) && !/(^|\/)vendor\//.test(p));
  if (hasEnv) avisos.add("ENV_EXCLUIDO");
  if (hasSql) avisos.add("SQL_DETECTADO");
  if (paths.some((p) => FORBIDDEN_EXT.test(p))) avisos.add("ARQUIVO_PROIBIDO");

  let tipo: TipoProjeto = "desconhecido";
  let pasta: string | null = null;
  let suportado = false;
  let phpVersion: string | null = null;

  const tool = allDeps.find((d) => SPA_TOOLS.includes(d));
  const outRoots = ["dist", "build", "out", ".output/public", ...(allDeps.includes("gatsby") ? ["public"] : [])];
  const built = pkg ? findIndexDir(paths, outRoots) : null;
  const serverDeps = prodDeps.filter((d) => SERVER_DEPS.includes(d));

  if (has("wp-config.php") || paths.some((p) => /^wp-(content|includes|admin)\//.test(p))) {
    tipo = "wordpress";
    avisos.add("WORDPRESS_NAO_SUPORTADO");
  } else if (pkg && serverDeps.length && !built) {
    tipo = "node";
    avisos.add("NODE_NAO_SUPORTADO");
  } else if (pkg && (tool || built)) {
    tipo = "spa";
    suportado = true;
    pasta = built;
    if (!built) avisos.add("PASTA_BUILD_AUSENTE");
  } else if (phpFiles.length || composer) {
    tipo = "php";
    if (composerReq.some((d) => d === "laravel/framework" || d === "symfony/framework-bundle")) {
      avisos.add("FRAMEWORK_PHP_NAO_SUPORTADO");
    } else {
      suportado = true;
      pasta = has("public/index.php") && !has("index.php") ? "public" : ".";
      const platform = (composer?.config as Json | undefined)?.platform as Json | undefined;
      const constraint = (composer?.require as Json | undefined)?.php ?? platform?.php;
      const picked = pickPhpVersion(typeof constraint === "string" ? constraint : undefined);
      phpVersion = picked.version;
      if (!picked.found) avisos.add("VERSAO_PHP_INDISPONIVEL");
    }
  } else if (has("index.html")) {
    tipo = "estatico";
    suportado = true;
    pasta = ".";
  } else {
    const dir = findIndexDir(paths, ["dist", "build", "out", "public", "docs", "www", "site"]);
    if (dir) {
      tipo = "estatico";
      suportado = true;
      pasta = dir;
    } else if (paths.some((p) => /\.html?$/i.test(p))) {
      tipo = "estatico";
      suportado = true;
      pasta = ".";
      avisos.add("SEM_INDEX");
    } else avisos.add("TIPO_DESCONHECIDO");
  }

  // Plans: the smallest one that fits the project and is meant for this type, else the next that fits.
  const fits = plans.filter((p) => p.diskGb * GB >= total);
  if (suportado && !fits.length) avisos.add("PROJETO_GRANDE");
  const rec = suportado ? (fits.find((p) => p.types.includes(tipo)) ?? fits[0] ?? null) : null;

  const analise: Analise = {
    tipo,
    suportado,
    pasta_publicar: pasta === null ? null : safeEchoPath(pasta),
    versao_php: phpVersion,
    precisa_banco: hasSql || allDeps.some((d) => DB_DEPS.includes(d)) || composerReq.some((d) => /^doctrine\/|^illuminate\/database$|^laravel\/framework$/.test(d)),
    precisa_email: [...allDeps, ...composerReq].some((d) => MAIL_DEPS.includes(d)),
    precisa_variaveis_ambiente: hasEnv || allDeps.includes("dotenv") || composerReq.includes("vlucas/phpdotenv"),
    quantidade_arquivos: files.length,
    tamanho_total_bytes: total,
    plano_recomendado: rec ? { pid: rec.pid, nome: rec.name } : null,
    alternativas: rec ? fits.filter((p) => p !== rec).map((p) => ({ pid: p.pid, nome: p.name })) : [],
    avisos: [...avisos].map((codigo) => ({ codigo, mensagem: AVISOS[codigo] })),
  };
  return { analise, folder: pasta };
}

export const detectProject = (m: Manifesto, plans: Plan[]): Analise => analyzeProject(m, plans).analise;
