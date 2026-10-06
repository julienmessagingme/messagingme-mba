import { describe, it, expect } from 'vitest';
import { creerAvisAbonnement, messageAvis, type DepsAvisAbonnement } from '../src/numero/avis-abonnement';
import type { AvisAbonnement } from '../src/stripe/abonnements.pg';

/**
 * LES E-MAILS DE L'ABONNEMENT DU NUMÉRO (lot 4, livraison B, spec § 4.3) : à chaque admin de l'espace, à la suspension,
 * 2 jours avant la libération et à la libération. Une fois chacun, et un envoi raté se rejoue au tour suivant.
 */
const FINI = new Date('2026-10-06T15:14:51Z');
const LIBERATION = new Date('2026-10-13T15:14:51Z');
const E = { abonnementId: 'sub_1', finiLe: FINI, liberationLe: LIBERATION };

function monter(o: { admins?: string[]; envoi?: (to: string) => void; sansResend?: boolean; dejaParti?: AvisAbonnement[] } = {}) {
  const envois: Array<{ to: string; subject: string; text: string }> = [];
  const notes: string[] = [];
  const deja = new Set<string>(o.dejaParti ?? []);
  const deps: DepsAvisAbonnement = {
    admins: async () => o.admins ?? ['a@exemple.fr', 'b@exemple.fr'],
    fuseau: async () => 'Europe/Paris',
    envoyer: o.sansResend ? null : async (m) => { o.envoi?.(m.to); envois.push({ to: m.to, subject: m.subject, text: m.text }); },
    pageNumero: 'https://console.exemple/connecter-whatsapp',
    avisDejaParti: async (_id, avis) => deja.has(avis),
    noterAvis: async (_id, avis) => { notes.push(avis); deja.add(avis); return true; },
  };
  return { avis: creerAvisAbonnement(deps), envois, notes };
}

describe('les e-mails de l’abonnement du numéro', () => {
  it('🔴 chaque admin le reçoit, une seule fois : le second tour ne renvoie rien', async () => {
    const m = monter();
    expect(await m.avis.envoyer('t1', E, 'suspension_mail')).toBe('parti');
    expect(m.envois.map((e) => e.to)).toEqual(['a@exemple.fr', 'b@exemple.fr']);
    expect(m.notes).toEqual(['suspension_mail']);
    expect(await m.avis.envoyer('t1', E, 'suspension_mail')).toBe('deja');
    expect(m.envois).toHaveLength(2);
  });

  it('🔴 un envoi raté pour TOUS les admins ne se note pas : il se rejoue au tour suivant', async () => {
    let enPanne = true;
    const m = monter({ envoi: () => { if (enPanne) throw new Error('Resend 500'); } });
    expect(await m.avis.envoyer('t1', E, 'liberation_mail')).toBe('non_envoye');
    expect(m.notes).toEqual([]);
    enPanne = false;
    expect(await m.avis.envoyer('t1', E, 'liberation_mail')).toBe('parti');
    expect(m.notes).toEqual(['liberation_mail']);
  });

  it('un admin refusé ne prive pas les autres, et l’avis se note', async () => {
    const m = monter({ envoi: (to) => { if (to === 'a@exemple.fr') throw new Error('adresse refusée'); } });
    expect(await m.avis.envoyer('t1', E, 'rappel_liberation_mail')).toBe('parti');
    expect(m.envois.map((e) => e.to)).toEqual(['b@exemple.fr']);
  });

  it('sans Resend sur l’instance : rien ne part, rien ne se note ; sans admin : noté, il n’y aura personne à prévenir', async () => {
    const sans = monter({ sansResend: true });
    expect(await sans.avis.envoyer('t1', E, 'suspension_mail')).toBe('non_envoye');
    expect(sans.notes).toEqual([]);
    const personne = monter({ admins: [] });
    expect(await personne.avis.envoyer('t1', E, 'suspension_mail')).toBe('parti');
    expect(personne.notes).toEqual(['suspension_mail']);
    expect(personne.envois).toEqual([]);
  });

  it('🔴 les textes : la date de libération dans le fuseau, le lien, la voie Claude, et jamais de tiret long', () => {
    const fini = messageAvis('suspension_mail', E, 'https://console.exemple/connecter-whatsapp', 'Europe/Paris');
    expect(fini.text).toContain('13 octobre 2026');
    expect(fini.text).toContain('https://console.exemple/connecter-whatsapp');
    expect(fini.text).toContain('Claude');
    const impaye = messageAvis('suspension_mail', { ...E, finiLe: null, liberationLe: null }, 'https://console.exemple/connecter-whatsapp', 'Europe/Paris');
    expect(impaye.text).toMatch(/impayé|pas été payé/);
    expect(impaye.text).not.toContain('libéré');
    const rappel = messageAvis('rappel_liberation_mail', E, 'https://x', 'Europe/Paris');
    expect(rappel.subject).toContain('13 octobre 2026');
    const libere = messageAvis('liberation_mail', E, 'https://x', 'Europe/Paris');
    expect(libere.subject).toMatch(/libéré/);
    for (const m of [fini, impaye, rappel, libere]) {
      expect(`${m.subject}${m.text}${m.html}`).not.toMatch(/[\u2014\u2013]/);
      expect(m.html).toContain('<p>');
    }
  });
});
