import type { TipoProjeto } from "@waycloud/shared";
import type { AddonClient } from "./addon.js";

export interface Plan {
  pid: number;
  name: string;
  diskGb: number;
  domains: number;
  monthlyCents: number;
  annualCents: number;
  types: TipoProjeto[];
  blurb: string;
}

/** Plans for local development and tests (public catalog pids). In production plans come from the WHMCS addon. */
// ATENÇÃO: the annual price of pid 215 equals pid 175 in WHMCS (1078.92), which looks like a
// registration mistake. Fix it in WHMCS before going live.
export const PLANS: Plan[] = [
  { pid: 173, name: "Speed BR", diskGb: 20, domains: 1, monthlyCents: 3590, annualCents: 38770, types: ["estatico", "spa"], blurb: "Sites estáticos, landing pages e aplicativos web já compilados." },
  { pid: 174, name: "Boost BR", diskGb: 50, domains: 2, monthlyCents: 5590, annualCents: 60372, types: ["php"], blurb: "Sites em PHP e projetos com mais tráfego." },
  { pid: 175, name: "Pro BR", diskGb: 120, domains: 5, monthlyCents: 9990, annualCents: 107892, types: [], blurb: "Vários sites ou projetos maiores." },
  { pid: 215, name: "Premium BR", diskGb: 200, domains: 10, monthlyCents: 19590, annualCents: 107892, types: [], blurb: "Maior capacidade de disco e domínios." },
];

// Limits are not exposed by the WHMCS API, so they live here, per project type. They mirror the
// Plesk service plans of the hidden products (Speed = 20 GB / 1 domain, Boost = 50 GB / 2 domains).
const META = {
  static: { diskGb: 20, domains: 1, types: ["estatico", "spa"] as TipoProjeto[], blurb: "Sites estáticos, landing pages e aplicativos web já compilados." },
  php: { diskGb: 50, domains: 2, types: ["php"] as TipoProjeto[], blurb: "Sites em PHP e projetos com mais tráfego." },
} as const;

export class PlansUnavailable extends Error {}

export type PlanProvider = () => Promise<Plan[]>;

/**
 * Plans from the WHMCS addon (prices and product ids stay a single source of truth in WHMCS),
 * cached for a few minutes. If the addon is down, the last good answer keeps serving; with no
 * cache at all it fails instead of showing stale or wrong ids. Without an addon (dev) it uses `fallback`.
 */
export function planCatalog(opts: { addon?: AddonClient; fallback?: Plan[]; ttlMs?: number; now?: () => number }): PlanProvider {
  const ttl = opts.ttlMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  let cached: { at: number; plans: Plan[] } | undefined;
  let failedAt = -Infinity;
  return async () => {
    if (!opts.addon) return opts.fallback ?? PLANS;
    if (cached && now() - cached.at < ttl) return cached.plans;
    if (now() - failedAt < 30_000) {
      // the addon just failed: do not make every request wait for its timeout again
      if (cached) return cached.plans;
      throw new PlansUnavailable();
    }
    try {
      const plans = (await opts.addon.plans()).map<Plan>((p) => ({ pid: p.pid, name: p.name, monthlyCents: p.monthlyCents, annualCents: p.annualCents, ...META[p.type] }));
      cached = { at: now(), plans };
      return plans;
    } catch {
      failedAt = now();
      if (cached) return cached.plans;
      throw new PlansUnavailable();
    }
  };
}
