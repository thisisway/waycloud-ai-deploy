import { z } from "zod";
import type { S3Config } from "./storage.js";

export interface Settings {
  previewRoot: string; // where preview folders are written (shared volume with the Nginx edge)
  previewUrlTemplate: string; // e.g. https://{slug}.waypreview.com.br
  previewTtlHours: number;
  uploadUrlTtlSeconds: number;
  maxInlineBytes: number;
  maxUploadsPerDay: number;
  maxActivePreviews: number;
}

export const DEFAULT_SETTINGS: Settings = {
  previewRoot: "/srv/previews",
  previewUrlTemplate: "https://{slug}.waypreview.com.br",
  previewTtlHours: 24,
  uploadUrlTtlSeconds: 15 * 60,
  maxInlineBytes: 5 * 1024 * 1024,
  maxUploadsPerDay: 20,
  maxActivePreviews: 3,
};

const env = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default("0.0.0.0"),
  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default("auto"),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  ADDON_URL: z.string().url().optional(),
  ADDON_HMAC_SECRET: z.string().min(32).optional(),
  AGENT_TOKENS: z.string().optional(),
  PREVIEW_ROOT: z.string().default(DEFAULT_SETTINGS.previewRoot),
  PREVIEW_URL_TEMPLATE: z.string().includes("{slug}").default(DEFAULT_SETTINGS.previewUrlTemplate),
  PREVIEW_TTL_HOURS: z.coerce.number().positive().default(DEFAULT_SETTINGS.previewTtlHours),
});

export function loadConfig(source: NodeJS.ProcessEnv) {
  const e = env.parse(source);
  const s3: S3Config = { endpoint: e.S3_ENDPOINT, publicEndpoint: e.S3_PUBLIC_ENDPOINT, region: e.S3_REGION, accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY, bucket: e.S3_BUCKET };
  const settings: Settings = { ...DEFAULT_SETTINGS, previewRoot: e.PREVIEW_ROOT, previewUrlTemplate: e.PREVIEW_URL_TEMPLATE, previewTtlHours: e.PREVIEW_TTL_HOURS };
  if (!!e.ADDON_URL !== !!e.ADDON_HMAC_SECRET) throw new Error("ADDON_URL and ADDON_HMAC_SECRET must be set together");
  const addon = e.ADDON_URL && e.ADDON_HMAC_SECRET ? { url: e.ADDON_URL, secret: e.ADDON_HMAC_SECRET } : undefined;
  return { databaseUrl: e.DATABASE_URL, port: e.PORT, host: e.HOST, s3, settings, addon, agentTokens: e.AGENT_TOKENS };
}
