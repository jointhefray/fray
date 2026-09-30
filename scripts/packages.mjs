import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const action = process.argv[2];

if (!['ci', 'build', 'typecheck', 'test'].includes(action)) {
  throw new Error('Expected ci, build, typecheck or test');
}

const packages = [
  'token-issuer/typescript',
  'ohttp/typescript',
  'ohttp/cloudflare',
  'registry/cloudflare',
];

for (const name of packages) {
  const cwd = resolve(root, name);
  const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));

  if (action !== 'ci' && !pkg.scripts?.[action]) continue;

  console.log(`\n${name}: ${action}`);

  const result = spawnSync('npm', action === 'ci' ? ['ci'] : ['run', action], {
    cwd,
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
