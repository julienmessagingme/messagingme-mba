import { describe, it, expect } from 'vitest';
import {
  base32, base32Decode, codeAuPas, pasDe, verifierCode, uriOtpauth, genererSecret,
  genererCodesSecours, empreinteCodeSecours, NOMBRE_CODES_SECOURS, PAS_SECONDES,
} from '../src/auth/totp';

/**
 * LE SECOND FACTEUR, SANS DÉPENDANCE (`src/auth/totp.ts`). Ce qui compte ici n'est pas notre lecture de la RFC,
 * c'est qu'une application d'authentification tombe sur le MÊME code que nous : d'où les vecteurs officiels.
 */

/** Le secret ASCII de l'annexe B de la RFC 6238 pour SHA-1, en base32. */
const SECRET_RFC = base32(Buffer.from('12345678901234567890', 'ascii'));

describe('base32 (RFC 4648)', () => {
  it('encode les vecteurs de la RFC 4648 (sans bourrage) et décode dans l’autre sens', () => {
    const vecteurs: Array<[string, string]> = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
    for (const [clair, code] of vecteurs) {
      expect(base32(Buffer.from(clair))).toBe(code);
      expect(base32Decode(code)?.toString()).toBe(clair);
    }
  });

  it('le décodage tolère casse, espaces et bourrage, et refuse un caractère hors alphabet (pas l’alphabet Crockford)', () => {
    expect(base32Decode('mzxw 6ytb oi======')?.toString()).toBe('foobar');
    // `1`, `8`, `0` n'existent pas en RFC 4648 : les accepter serait lire l'alphabet de `src/ids/code.ts`.
    expect(base32Decode('MZXW1')).toBeNull();
  });

  it('un secret tiré fait 160 bits : 32 caractères base32', () => {
    const s = genererSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    expect(genererSecret()).not.toBe(s);
  });
});

describe('TOTP (RFC 6238, annexe B, SHA-1, ramené à 6 chiffres)', () => {
  // Les six derniers chiffres des codes à 8 de la RFC : la troncature est la même, seul le modulo change.
  const VECTEURS: Array<[number, string]> = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];

  it('rend le code officiel à chaque instant de l’annexe', () => {
    for (const [secondes, code] of VECTEURS) {
      expect(codeAuPas(SECRET_RFC, pasDe(secondes * 1000)), `T=${secondes}`).toBe(code);
    }
  });

  it('accepte le code du pas courant et rend CE pas', () => {
    for (const [secondes, code] of VECTEURS) {
      expect(verifierCode(SECRET_RFC, code, secondes * 1000, null)).toBe(pasDe(secondes * 1000));
    }
  });

  it('fenêtre de plus ou moins UN pas, pas davantage', () => {
    const t = 1234567890 * 1000;
    const pas = pasDe(t);
    expect(verifierCode(SECRET_RFC, codeAuPas(SECRET_RFC, pas - 1), t, null)).toBe(pas - 1);
    expect(verifierCode(SECRET_RFC, codeAuPas(SECRET_RFC, pas + 1), t, null)).toBe(pas + 1);
    expect(verifierCode(SECRET_RFC, codeAuPas(SECRET_RFC, pas - 2), t, null)).toBeNull();
    expect(verifierCode(SECRET_RFC, codeAuPas(SECRET_RFC, pas + 2), t, null)).toBeNull();
    // Le pas précédent reste valable jusqu'à la fin du pas courant, pas une seconde de plus.
    expect(verifierCode(SECRET_RFC, codeAuPas(SECRET_RFC, pas), (pas + 1) * PAS_SECONDES * 1000 + 29_999, null)).toBe(pas);
  });

  it('🔴 anti-rejeu : un code juste d’un pas DÉJÀ accepté (ou antérieur) est refusé', () => {
    const t = 1111111111 * 1000;
    const pas = pasDe(t);
    const code = codeAuPas(SECRET_RFC, pas);
    expect(verifierCode(SECRET_RFC, code, t, pas - 1)).toBe(pas);
    expect(verifierCode(SECRET_RFC, code, t, pas)).toBeNull();
    expect(verifierCode(SECRET_RFC, codeAuPas(SECRET_RFC, pas - 1), t, pas)).toBeNull();
    // Le pas SUIVANT reste utilisable : deux connexions dans la même demi-minute ne se bloquent pas l'une l'autre.
    expect(verifierCode(SECRET_RFC, codeAuPas(SECRET_RFC, pas + 1), t, pas)).toBe(pas + 1);
  });

  it('refuse ce qui n’est pas six chiffres, et tolère les espaces', () => {
    const t = 59_000;
    expect(verifierCode(SECRET_RFC, '287 082', t, null)).toBe(1);
    for (const faux of ['', '28708', '2870821', 'abcdef', '94287082', '287O82']) {
      expect(verifierCode(SECRET_RFC, faux, t, null), faux).toBeNull();
    }
    expect(verifierCode(SECRET_RFC, '287083', t, null)).toBeNull();
  });

  it('l’URI porte le secret, l’émetteur et l’adresse, et rien d’exotique', () => {
    const brute = uriOtpauth('Engage Me', 'julie@exemple.fr', 'MZXW6YTBOI');
    // Le libellé est « émetteur:adresse », chaque moitié encodée : c'est ce que les applications affichent.
    expect(brute.startsWith('otpauth://totp/Engage%20Me:julie%40exemple.fr?')).toBe(true);
    const uri = new URL(brute);
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: 'MZXW6YTBOI', issuer: 'Engage Me', algorithm: 'SHA1', digits: '6', period: '30',
    });
  });
});

describe('codes de secours', () => {
  it('dix codes de 80 bits, affichés en deux groupes de huit', () => {
    const { clairs, empreintes } = genererCodesSecours();
    expect(clairs).toHaveLength(NOMBRE_CODES_SECOURS);
    for (const c of clairs) expect(c).toMatch(/^[A-Z2-7]{8}-[A-Z2-7]{8}$/);
    expect(new Set(clairs).size).toBe(NOMBRE_CODES_SECOURS);
    expect(empreintes).toEqual(clairs.map((c) => empreinteCodeSecours(c)));
  });

  it('🔴 seule l’EMPREINTE est stockable : SHA-256 hexadécimal, jamais le code', () => {
    const { clairs, empreintes } = genererCodesSecours();
    for (const [i, e] of empreintes.entries()) {
      expect(e).toMatch(/^[0-9a-f]{64}$/);
      expect(e).not.toContain(clairs[i]!.replace('-', ''));
    }
  });

  it('la saisie tolère tiret, espaces et casse, et un code TOTP ou une faute ne donnent aucune empreinte', () => {
    const e = empreinteCodeSecours('ABCDEFGH-IJKLMNOP');
    expect(empreinteCodeSecours('abcdefgh ijklmnop')).toBe(e);
    expect(empreinteCodeSecours(' ABCDEFGHIJKLMNOP ')).toBe(e);
    for (const faux of ['123456', 'ABCDEFGH-IJKLMNO', 'ABCDEFGH-IJKLMNO1', '']) {
      expect(empreinteCodeSecours(faux), faux).toBeNull();
    }
  });
});
