import { describe, it, expect } from 'vitest';
import { lireLien } from './lien-numero';

/**
 * Ce que la page `/brancher` lit dans le jeton du lien (lot 3c) : l'espace et le mode, pour l'affichage et pour
 * construire ses adresses. 🔴 Elle ne le VÉRIFIE pas, c'est le serveur qui le fait : un jeton forgé ici n'ouvre rien,
 * il fait seulement afficher une page dont chaque appel sera refusé.
 */
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jeton = (charge: unknown) => `${b64({ alg: 'HS256' })}.${b64(charge)}.signature`;

describe('lireLien', () => {
  it('rend l’espace et le mode d’un jeton de lien', () => {
    expect(lireLien(jeton({ kind: 'lien_numero', tenantId: 't-1', userId: 'u-1', mode: 'fourni' }))).toEqual({ tenantId: 't-1', mode: 'fourni' });
    expect(lireLien(jeton({ kind: 'lien_numero', tenantId: 't-1', userId: 'u-1', mode: 'apporte' }))?.mode).toBe('apporte');
  });

  it('rend null pour tout ce qui n’est pas un jeton de lien', () => {
    for (const j of [
      '', 'pas-un-jeton', 'a.b', 'a.!!!.c',
      jeton({ tenantId: 't-1', role: 'admin' }),
      jeton({ kind: 'oauth_choix', tenantId: 't-1', mode: 'fourni' }),
      jeton({ kind: 'lien_numero', tenantId: '', mode: 'fourni' }),
      jeton({ kind: 'lien_numero', tenantId: 't-1', mode: 'autre' }),
      jeton({ kind: 'lien_numero', tenantId: '../ops', mode: 'fourni' }),
    ]) expect(lireLien(j), j).toBeNull();
  });
});
