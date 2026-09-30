import { writeFile } from 'node:fs/promises';
import { KeyConfig } from 'ohttp-ts';
import { cipherSuite, type StoredKey } from './crypto.js';

const path = process.argv[2];

if (!path) throw new Error('Usage: npm run keygen -- /private/path/gateway-keys.json [key-id]');

const suite = cipherSuite();
const key = await KeyConfig.generate(suite, Number(process.argv[3] ?? 1), true);

const stored: StoredKey = {
  keyId: key.keyId,
  publicKey: Buffer.from(key.publicKey).toString('base64'),
  privateKey: Buffer.from(await suite.SerializePrivateKey(key.keyPair.privateKey)).toString(
    'base64',
  ),
};

// Never overwrite a running gateway's keys or print private material to terminal logs.
await writeFile(path, JSON.stringify([stored], null, 2) + '\n', { flag: 'wx', mode: 0o600 });
