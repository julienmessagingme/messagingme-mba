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

/**
 * 🔴 LE TAG TRONQUE, trouve par semgrep a la premiere execution du controle d analyse statique ajoute le
 * 2026-09-10. Sans `authTagLength` explicite, `createDecipheriv` accepte un tag PLUS COURT que 16 octets,
 * ce qui divise d autant le travail d une forge pour qui peut fournir le texte chiffre.
 *
 * ⚠️ Ces tests gardent les DEUX sens : un tag tronque est refuse, et un secret ecrit AVANT le correctif
 * reste lisible. Le second compte autant que le premier : les huit secrets chiffres de la production
 * (jetons Meta, PIN, mot de passe SMTP, jetons RCS, secrets Channels Me, cle AI Gateway) ont tous ete
 * ecrits avec le defaut de Node, mesure a 16 octets avant d ecrire la ligne.
 */
describe('secretbox — longueur du tag GCM', () => {
  const CLE = 'a'.repeat(64);

  it('🔴 un tag TRONQUE est refuse', () => {
    const paye = encryptSecret('un secret', CLE);
    const [v, iv, tag, data] = paye.split('.');
    // Huit octets au lieu de seize : la moitie du tag, donc un espace de forge divise par 2^64.
    const tronque = Buffer.from(tag!, 'base64').subarray(0, 8).toString('base64');
    expect(() => decryptSecret(`${v}.${iv}.${tronque}.${data}`, CLE)).toThrow();
  });

  it('🔴 un secret ecrit AVANT le correctif reste lisible', () => {
    // Le defaut de Node etait deja 16 : un payload produit sans l option doit se dechiffrer a l identique,
    // sinon la ligne ajoutee rendrait illisibles des secrets de production sans retour arriere possible.
    const { createCipheriv, randomBytes } = require('node:crypto') as typeof import('node:crypto');
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', Buffer.from(CLE, 'hex'), iv); // SANS authTagLength, comme avant
    const enc = Buffer.concat([c.update('secret historique', 'utf8'), c.final()]);
    const ancien = `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
    expect(decryptSecret(ancien, CLE)).toBe('secret historique');
  });
});
