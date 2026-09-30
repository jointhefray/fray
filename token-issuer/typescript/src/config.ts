/** Configuration for the local example only; the library takes explicit options. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env) {
  if (env.FRAY_LOCAL_DEMO !== '1' || !env.LOCAL_DEMO_TOKEN || env.LOCAL_DEMO_TOKEN.length < 16) {
    throw new Error(
      'Local demo only: set FRAY_LOCAL_DEMO=1 and LOCAL_DEMO_TOKEN (at least 16 characters). Production must supply validateUser.',
    );
  }

  if (env.NODE_ENV === 'production') {
    throw new Error('The mocked validateUser must not run in production');
  }

  const port = Number(env.PORT ?? 8081);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be 1..65535');
  }

  return {
    host: env.HOST ?? '127.0.0.1',
    port,
    keysDir: env.KEYS_DIR ?? './keys',
    token: env.LOCAL_DEMO_TOKEN,
    dailyQuota: Number(env.DAILY_QUOTA ?? 64),
    maxBatch: Number(env.MAX_BATCH ?? 64),
  };
}
