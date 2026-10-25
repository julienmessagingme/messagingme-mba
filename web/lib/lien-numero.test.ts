import { describe, it, expect } from 'vitest';
import { connexionFinie, lireLien, repriseDuNumeroFourni } from './lien-numero';
import type { EtatConnexion } from './api/connexion-numero';

/**
 * Ce que la page `/brancher` lit dans le jeton du lien (lot 3c) : l'espace et le mode, pour l'affichage et pour
 * construire ses adresses. 🔴 Elle ne le VÉRIFIE pas, c'est le serveur qui le fait : un jeton forgé ici n'ouvre rien,
 * il fait seulement afficher une page dont chaque appel sera refusé.
 */
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jeton = (charge: unknown) => `${b64({ alg: 'HS256' })}.${b64(charge)}.signature`;

describe('lireLien', () => {
  it('rend l’espace et le mode d’un jeton de lien', () => {
    expect(lireLien(jeton({ kind: 'lien_numero', tenantId: 't-1', userId: 'u-1', mode: 'fourni' }))).toEqual({ tenantId: 't-1', mode: 'fourni', filiere: 'api' });
    // La filière application (2026-10-22) : seule la valeur « application » la donne, tout le reste est l'API.
    expect(lireLien(jeton({ kind: 'lien_numero', tenantId: 't-1', userId: 'u-1', mode: 'apporte', filiere: 'application' }))?.filiere).toBe('application');
    expect(lireLien(jeton({ kind: 'lien_numero', tenantId: 't-1', userId: 'u-1', mode: 'apporte', filiere: 'autre' }))?.filiere).toBe('api');
    expect(lireLien(jeton({ kind: 'lien_numero', tenantId: 't-1', userId: 'u-1', mode: 'apporte' }))?.mode).toBe('apporte');
  });

  it('🔴 le mode coexistence (plan 2026-10-24) : la page l’ouvre en gardant l’application WhatsApp Business', () => {
    expect(lireLien(jeton({ kind: 'lien_numero', tenantId: 't-1', userId: 'u-1', mode: 'coexistence' }))).toEqual({ tenantId: 't-1', mode: 'coexistence', filiere: 'api' });
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

/**
 * QUAND LA PAGE DU LIEN A FINI (plan 2026-10-24, tâche 4) : un numéro connecté et activé. 🔴 En coexistence, un espace relié
 * par QR code est déjà « connecté » par son compte de l'application : la page attend le numéro de Meta, sans quoi elle
 * dirait « retournez dans Claude Code » avant même d'avoir montré la fenêtre de Meta.
 */
describe('connexionFinie', () => {
  const VIDE: EtatConnexion = { fourni: null, code: null, connecte: null, abonnement: null };
  const QR_CODE: EtatConnexion = { ...VIDE, connecte: { chiffres: '441555479304', aActiver: false }, application: { statut: 'relie', numero: '441555479304' } };
  const META: EtatConnexion = { ...VIDE, connecte: { chiffres: '441555479304', aActiver: false } };

  it('un numéro connecté et activé finit la page, quel que soit le mode ; rien de connecté, ou à activer, non', () => {
    for (const mode of ['fourni', 'apporte', 'coexistence'] as const) {
      expect(connexionFinie(META, mode), mode).toBe(true);
      expect(connexionFinie(VIDE, mode), mode).toBe(false);
      expect(connexionFinie({ ...META, connecte: { chiffres: '441555479304', aActiver: true } }, mode), mode).toBe(false);
    }
  });

  it('🔴 en coexistence, le compte relié par QR code ne finit pas la page ; hors coexistence, si (la filière application)', () => {
    expect(connexionFinie(QR_CODE, 'coexistence')).toBe(false);
    expect(connexionFinie(QR_CODE, 'apporte')).toBe(true);
  });
});

/**
 * CE QUE LA PAGE REPREND À SON RETOUR (rechargement, onglet rouvert) quand l'espace a déjà un numéro fourni : le numéro et
 * son code, sous le choix « fourni ». 🔴 Jamais pour un lien de coexistence (relecture du lot 1) : son numéro peut être
 * justement un numéro fourni relié par QR code (celui de newCompany, +44 1555 479304), et la page quitterait la fenêtre
 * de coexistence pour l'écran du numéro fourni.
 */
describe('repriseDuNumeroFourni', () => {
  it('🔴 un lien de coexistence reste sur la coexistence, même avec un numéro fourni attribué', () => {
    expect(repriseDuNumeroFourni('coexistence', { numero: '+441555479304', code: '123456' })).toBeNull();
  });

  it('sinon, un numéro attribué reprend avec son code ; sans numéro, rien ne change', () => {
    for (const choix of [null, 'fourni', 'apporte'] as const) {
      expect(repriseDuNumeroFourni(choix, { numero: '+441555479304', code: '123456' }), String(choix)).toEqual({ numero: '+441555479304', code: '123456' });
      expect(repriseDuNumeroFourni(choix, { numero: null, code: null }), String(choix)).toBeNull();
    }
  });
});
