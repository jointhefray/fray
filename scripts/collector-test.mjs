import { spawnSync } from 'node:child_process';

const result = spawnSync('npm', ['test'], {
  cwd: new URL('../examples/collector/', import.meta.url),
  env: { ...process.env, REQUIRE_REDIS: '1' },
  stdio: 'inherit',
});

if (result.error) throw result.error;

process.exit(result.status ?? 1);
