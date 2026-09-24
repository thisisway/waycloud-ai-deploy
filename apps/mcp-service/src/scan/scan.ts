import { normalizePath } from "../security/sanitize.js";

export type FindingCode = "EXECUTABLE" | "WEBSHELL" | "DISGUISED_PHP" | "PHISHING" | "PHISHING_SUSPECT" | "ENV_REMOVED" | "JUNK_REMOVED" | "BAD_PATH";
export interface Finding {
  code: FindingCode;
  severity: "block" | "warn";
  path?: string; // internal only (logs/admin); never returned to the AI
}
export interface ScanResult {
  approved: boolean;
  findings: Finding[];
  files: Map<string, Uint8Array>; // what is safe to publish
}

const FORBIDDEN_EXT = /\.(exe|dll|so|dylib|bat|cmd|scr|msi|com|vbs|ps1)$/i;
const PHP_EXT = /\.(php[3-8]?|phtml|pht|phar|inc)$/i;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|zip|mp4|mp3)$/i;
const DISGUISED_NAME = /\.php[3-8]?\.[a-z0-9]{2,4}$/i;
const JUNK = /(^|\/)(node_modules|\.git|\.svn|\.hg)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db)$/;
const ENV_FILE = /(^|\/)\.env(\..+)?$/;
const ENV_SAMPLE = /\.(example|sample|template|dist)$/;

const WEBSHELL = [
  /eval\s*\(\s*(base64_decode|gzinflate|gzuncompress|str_rot13)\s*\(/i,
  /assert\s*\(\s*\$_(POST|GET|REQUEST|COOKIE)/i,
  /\b(system|shell_exec|passthru|exec|popen|proc_open)\s*\(\s*\$_(GET|POST|REQUEST|COOKIE)/i,
  /preg_replace\s*\(\s*['"][^'"]*\/e['"]/i,
  /\$_(GET|POST|REQUEST|COOKIE)\s*\[[^\]]*\]\s*\(/,
  /\b(c99shell|r57shell|b374k|FilesMan|IndoXploit|WSO\s*Shell)\b/i,
];

const BRANDS =
  /paypal|ita[uú]|bradesco|nubank|santander|caixa econ|banco do brasil|bancodobrasil|mercado ?pago|mercado ?livre|netflix|microsoft|office ?365|outlook|apple id|icloud|facebook|instagram|whatsapp|correios|gov\.br|receita federal|serasa|sicredi|sicoob|banco inter|binance|metamask/i;
const PASSWORD_INPUT = /<input[^>]+type\s*=\s*["']?password/i;
const EXTERNAL_ACTION = /<form[^>]+action\s*=\s*["']https?:\/\//i;

const text = (b: Uint8Array) => Buffer.from(b).toString("latin1"); // latin1 keeps every byte, no decode errors

export function scan(input: Map<string, Uint8Array>): ScanResult {
  const findings: Finding[] = [];
  const files = new Map<string, Uint8Array>();
  let junk = 0;
  let envs = 0;

  for (const [rawPath, data] of input) {
    const path = normalizePath(rawPath);
    if (!path) {
      findings.push({ code: "BAD_PATH", severity: "warn" });
      continue;
    }
    if (JUNK.test(path)) {
      junk++;
      continue;
    }
    if (ENV_FILE.test(path) && !ENV_SAMPLE.test(path)) {
      envs++; // secrets: dropped from the package, the customer is warned
      continue;
    }
    if (FORBIDDEN_EXT.test(path)) {
      findings.push({ code: "EXECUTABLE", severity: "block", path });
      continue;
    }
    if (DISGUISED_NAME.test(path)) findings.push({ code: "DISGUISED_PHP", severity: "block", path });

    const isPhp = PHP_EXT.test(path);
    // ponytail: signature list, not a real AV. Add a ClamAV container when abuse shows up.
    if (isPhp && data.length <= 2 * 1024 * 1024) {
      const t = text(data);
      if (WEBSHELL.some((r) => r.test(t))) findings.push({ code: "WEBSHELL", severity: "block", path });
    } else if (BINARY_EXT.test(path) && data.length <= 1024 * 1024 && text(data).includes("<?php")) {
      findings.push({ code: "DISGUISED_PHP", severity: "block", path });
    }

    if (/\.(html?|php)$/i.test(path) && data.length <= 2 * 1024 * 1024) {
      const t = text(data);
      if (PASSWORD_INPUT.test(t) && BRANDS.test(t)) {
        // ponytail: brand + password field is only blocked when the form posts to another site.
        findings.push({ code: EXTERNAL_ACTION.test(t) ? "PHISHING" : "PHISHING_SUSPECT", severity: EXTERNAL_ACTION.test(t) ? "block" : "warn", path });
      }
    }
    files.set(path, data);
  }
  if (junk) findings.push({ code: "JUNK_REMOVED", severity: "warn" });
  if (envs) findings.push({ code: "ENV_REMOVED", severity: "warn" });

  return { approved: !findings.some((f) => f.severity === "block"), findings, files };
}
