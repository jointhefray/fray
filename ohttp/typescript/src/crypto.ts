import { AEAD_AES_128_GCM, CipherSuite, KDF_HKDF_SHA256, KEM_DHKEM_P256_HKDF_SHA256 } from 'hpke';
import { KeyConfig, type KeyConfigWithPrivate } from 'ohttp-ts';

// P-256 is available in extension WebCrypto implementations without experimental flags.
export function cipherSuite(): CipherSuite {
  return new CipherSuite(KEM_DHKEM_P256_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_128_GCM);
}

export interface StoredKey {
  keyId: number;
  publicKey: string;
  privateKey: string;
}

export async function importKeys(keys: StoredKey[]): Promise<KeyConfigWithPrivate[]> {
  if (!Array.isArray(keys) || !keys.length) throw new Error('At least one gateway key is required');

  return Promise.all(
    keys.map((key) => {
      if (!Number.isInteger(key.keyId) || key.keyId < 0 || key.keyId > 255)
        throw new Error('Invalid key ID');

      const decode = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

      return KeyConfig.import(
        cipherSuite(),
        key.keyId,
        decode(key.publicKey),
        decode(key.privateKey),
      );
    }),
  );
}
