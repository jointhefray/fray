import { AEAD_AES_128_GCM, CipherSuite, KDF_HKDF_SHA256, KEM_DHKEM_P256_HKDF_SHA256 } from 'hpke';

// P-256 is available in extension WebCrypto implementations without experimental flags.
export function cipherSuite(): CipherSuite {
  return new CipherSuite(KEM_DHKEM_P256_HKDF_SHA256, KDF_HKDF_SHA256, AEAD_AES_128_GCM);
}
