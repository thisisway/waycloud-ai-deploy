import type { z } from "zod";
import { entradas, type Envelope, type ToolName } from "@waycloud/shared";
import type { AddonClient } from "../../addon.js";
import type { Db } from "../../db/index.js";
import type { PlanProvider } from "../../plans.js";
import type { Settings } from "../../settings.js";
import type { Storage } from "../../storage.js";

export interface ToolContext {
  db: Db;
  /** Current plans (from the WHMCS addon in production). May throw PlansUnavailable. */
  plans: PlanProvider;
  storage: Storage;
  settings: Settings;
  /** Signed client of the WHMCS addon; absent when the addon is not configured. */
  addon?: AddonClient;
  /** fetch used by verificar_site (injectable in tests). */
  fetchFn?: typeof fetch;
}

export interface ToolDef {
  name: ToolName;
  description: string; // in Portuguese: it tells the AI WHEN to use the tool
  handler: (ctx: ToolContext, args: never) => Promise<Envelope>;
}

export const defineTool = <N extends ToolName>(
  name: N,
  description: string,
  handler: (ctx: ToolContext, args: z.infer<(typeof entradas)[N]>) => Promise<Envelope>,
): ToolDef => ({ name, description, handler: handler as ToolDef["handler"] });
