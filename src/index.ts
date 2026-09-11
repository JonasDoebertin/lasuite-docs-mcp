#!/usr/bin/env node
import { main } from './server.js';

main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
