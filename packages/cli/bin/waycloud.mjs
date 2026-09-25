#!/usr/bin/env node
import { main } from "../src/cli.mjs";

process.exitCode = await main(process.argv.slice(2), process.env, console);
