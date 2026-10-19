// Key-generation command. Generates each epoch's four RSABSSA keys ahead of time; the issuer
// itself never generates keys while serving.

import { epochIdFor, isValidEpoch, nextEpochIdFor } from './epoch.js';
import { generateEpochKeys } from './keys.js';

export const KEYGEN_USAGE =
  'usage: fray-token-issuer-keygen --keys-dir DIR [--epoch current|next|ep-YYYY-MM]...';

/** Parse `--keys-dir DIR` (or KEYS_DIR) and any number of `--epoch` values (default: current). */
export function parseKeygenArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): { keysDir: string; epochs: string[] } {
  let keysDir = env.KEYS_DIR;
  const epochs: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag !== '--keys-dir' && flag !== '--epoch') || value === undefined) {
      throw new Error(KEYGEN_USAGE);
    }
    index++;

    if (flag === '--keys-dir') {
      keysDir = value;
    } else if (value === 'current') {
      epochs.push(epochIdFor(now));
    } else if (value === 'next') {
      epochs.push(nextEpochIdFor(now));
    } else if (isValidEpoch(value)) {
      epochs.push(value);
    } else {
      throw new Error(KEYGEN_USAGE);
    }
  }

  if (!keysDir) {
    throw new Error(KEYGEN_USAGE);
  }

  return { keysDir, epochs: epochs.length ? [...new Set(epochs)] : [epochIdFor(now)] };
}

/** Generate each requested epoch's missing keys. Prints no key material. */
export async function runKeygen(
  argv: readonly string[],
  write: (line: string) => void = (line) => process.stdout.write(line + '\n'),
): Promise<void> {
  const { keysDir, epochs } = parseKeygenArgs(argv);

  for (const epoch of epochs) {
    const started = Date.now();
    const keys = await generateEpochKeys(keysDir, epoch);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    write(
      `${epoch}: ${keys.created.length ? `created ${keys.created.join(', ')} in ${seconds}s` : 'all four keys exist, kept'}; ` +
        `public JWKS ${keys.jwksPath}`,
    );
    for (const [kid, digest] of Object.entries(keys.modulusSha256)) {
      write(`  ${kid} modulus SHA-256 ${digest}`);
    }
  }
}
