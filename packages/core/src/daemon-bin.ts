#!/usr/bin/env node
import { runDaemon } from "./daemon-start.js";

runDaemon(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`diffectd: ${err?.message ?? err}\n`);
  process.exit(1);
});
