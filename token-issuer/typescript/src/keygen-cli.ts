#!/usr/bin/env node
import { runKeygen } from './keygen.js';

try {
  await runKeygen(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'key generation failed'}\n`);
  process.exitCode = 1;
}
