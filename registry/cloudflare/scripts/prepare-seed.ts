import { writeFile } from 'node:fs/promises';
import { downloadSnapshot, parseSnapshot } from '../src/index.js';

const target = process.argv[2];
if (!target || process.argv.length !== 3)
  throw new Error('Usage: npm run prepare-seed -- /tmp/fray-watchlist.json');
const body = await downloadSnapshot(process.env.UPSTREAM_URL);
const document = parseSnapshot(body);
await writeFile(target, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
console.log(`Prepared public registry version ${document.version}, expires ${document.expires}.`);
