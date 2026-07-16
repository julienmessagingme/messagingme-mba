import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret } from '../src/crypto/secretbox';

const KEY = 'a'.repeat(64); // 32 octets hex
const OTHER = 'b'.repeat(64);

describe('secretbox (AES-256-GCM, tokens business ES)', () => {
  it('round-trip chiffre/déchiffre', () => {
    const enc = encryptSecret('EAAG-token-secret', KEY);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc).not.toContain('EAAG'); // jamais le clair dans le payload
    expect(decryptSecret(enc, KEY)).toBe('EAAG-token-secret');
  });

  it('deux chiffrements du même clair diffèrent (IV aléatoire)', () => {
    expect(encryptSecret('x', KEY)).not.toBe(encryptSecret('x', KEY));
  });

  it('mauvaise clé -> throw (auth tag GCM)', () => {
    const enc = encryptSecret('secret', KEY);
    expect(() => decryptSecret(enc, OTHER)).toThrow();
  });

  it('clé invalide (pas 64 hex) -> throw explicite', () => {
    expect(() => encryptSecret('x', 'court')).toThrow(/ENCRYPTION_KEY invalide/);
  });

  it('payload malformé -> throw explicite', () => {
    expect(() => decryptSecret('nimporte-quoi', KEY)).toThrow(/malformé/);
  });
});
