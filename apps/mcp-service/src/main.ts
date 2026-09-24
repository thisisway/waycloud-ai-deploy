import { migrate, openPostgres } from "./db/index.js";
import { startMaintenance } from "./jobs/maintenance.js";
import { httpAddonClient } from "./addon.js";
import { planCatalog } from "./plans.js";
import { buildApp } from "./server.js";
import { loadConfig } from "./settings.js";
import { s3Storage } from "./storage.js";

const config = loadConfig(process.env);
const log = (o: object) => console.log(JSON.stringify(o));

const db = openPostgres(config.databaseUrl);
const applied = await migrate(db);
if (applied.length) log({ msg: "migrations applied", applied });

const addon = config.addon && httpAddonClient(config.addon);
const ctx = { db, plans: planCatalog({ addon }), storage: s3Storage(config.s3), settings: config.settings, addon };
startMaintenance(ctx, 10 * 60_000, log);

const app = buildApp(ctx, { webhookSecret: config.addon?.secret });
await app.listen({ port: config.port, host: config.host });
log({ msg: "listening", port: config.port });
