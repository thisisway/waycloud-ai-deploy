import type { MensagemCodigo } from "@waycloud/shared";
import { analyzeProject } from "./detect/detect.js";
import type { Plan } from "./plans.js";

const text = (b: Uint8Array | undefined) => (b ? Buffer.from(b).toString("utf8").slice(0, 200_000) : undefined);

export type PreviewSite = { ok: true; site: Map<string, Uint8Array>; spa: boolean } | { ok: false; codigo: MensagemCodigo };

/**
 * What a preview shows for a set of project files: only the site folder (build output for SPAs), never PHP.
 * Shared by criar_previa (first publish) and by the on-demand rebuild after a redeploy wiped the folder.
 */
export function previewSiteFromFiles(files: Map<string, Uint8Array>, plans: Plan[]): PreviewSite {
  const { analise, folder } = analyzeProject(
    { arquivos: [...files].map(([caminho, b]) => ({ caminho, tamanho: b.length })), package_json: text(files.get("package.json")), composer_json: text(files.get("composer.json")) },
    plans,
  );
  if (analise.tipo === "php") return { ok: false, codigo: "PREVIA_INDISPONIVEL_PHP" };
  if (analise.avisos.some((v) => v.codigo === "PASTA_BUILD_AUSENTE")) return { ok: false, codigo: "PASTA_BUILD_AUSENTE" };
  if (!analise.suportado || folder === null) return { ok: false, codigo: "PROJETO_NAO_SUPORTADO" };

  const prefix = folder === "." ? "" : `${folder}/`;
  const site = new Map<string, Uint8Array>();
  for (const [path, data] of files) if (path.startsWith(prefix)) site.set(path.slice(prefix.length), data);
  return { ok: true, site, spa: analise.tipo === "spa" };
}
