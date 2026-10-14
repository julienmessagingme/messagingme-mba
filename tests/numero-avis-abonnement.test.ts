import { describe, it, expect, vi, afterEach } from 'vitest';
import { creerAvisAbonnement, modeleDeLAvis, type DepsAvisAbonnement, type EtatPourAvis } from '../src/numero/avis-abonnement';
import type { Emission } from '../src/emails-produit/emission';
import { modeleDe } from '../src/emails-produit/catalogue';
import { rendre } from '../src/emails-produit/rendu';
import type { AvisAbonnement } from '../src/stripe/abonnements.pg';

/**
 * LES E-MAILS DE L'ABONNEMENT DU NUMÉRO (lot 4, livraison B, spec § 4.3 ; par les e-mails du produit depuis le lot 7) :
 * aux admins de l'espace, à la suspension, 2 jours avant la libération et à la libération. Une fois chacun, et une
 * émission ratée se rejoue au tour suivant. L'envoi lui-même (un admin refusé, Resend en panne) est celui de la file :
 * `tests/emails-produit.test.ts`.
 */
const FINI = new Date('2026-10-06T15:14:51Z');
const LIBERATION = new Date('2026-10-13T15:14:51Z');
const E: EtatPourAvis = { abonnementId: 'sub_1', finiLe: FINI, liberationLe: LIBERATION };

afterEach(() => { vi.restoreAllMocks(); });

function monter(o: { emettre?: (e: Emission) => void; dejaParti?: AvisAbonnement[]; maintenant?: () => Date } = {}) {
  const emissions: Emission[] = [];
  const notes: string[] = [];
  const deja = new Set<string>(o.dejaParti ?? []);
  const deps: DepsAvisAbonnement = {
    emettre: async (e) => { o.emettre?.(e); emissions.push(e); return { destinataires: 2, reserves: 2 }; },
    pageNumero: 'https://console.exemple/connecter-whatsapp',
    pageOffre: 'https://console.exemple/offre',
    avisDejaParti: async (_id, avis) => deja.has(avis),
    noterAvis: async (_id, avis) => { notes.push(avis); deja.add(avis); return true; },
    now: o.maintenant ?? (() => new Date('2026-10-14T10:00:00Z')),
  };
  return { avis: creerAvisAbonnement(deps), emissions, notes, deja };
}

describe('l’annonce de la suite du numéro à la fin prévue du Pro (lot 6, B2b)', () => {
  const FIN_PRO = new Date('2026-11-08T10:00:00Z');

  it('🔴 le texte : la date de fin du Pro, le numéro à 3,50 € HT par mois sur la même carte, ou le rendre depuis la page Offre', async () => {
    const m = monter();
    expect(await m.avis.annoncerSuite('t1', FIN_PRO)).toBe('parti');
    const e = m.emissions[0]!;
    expect(e).toMatchObject({ cle: 'pro_suite_numero', tenantId: 't1', a: 'admins', occasion: 'fin_pro:2026-11-08' });
    const r = rendre(modeleDe(e.cle)!, modeleDe(e.cle)!.textes.fr, { ...e.valeurs, _fuseau: 'Europe/Paris', espace: 'Atelier' }, 'fr');
    expect(r.sujet).toMatch(/8 novembre 2026/);
    expect(r.text).toMatch(/3,50 € HT par mois/);
    expect(r.text).toMatch(/même carte/);
    expect(r.text).toMatch(/rendre/);
    expect(r.text).toContain('https://console.exemple/offre');
    expect(r.html).toContain('href="https://console.exemple/offre"');
  });

  it('🔴 une émission qui échoue : à rejouer ; elle réussit : « parti »', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await monter({ emettre: () => { throw new Error('base injoignable'); } }).avis.annoncerSuite('t1', FIN_PRO)).toBe('non_envoye');
    expect(await monter().avis.annoncerSuite('t1', FIN_PRO)).toBe('parti');
  });
});

describe('les e-mails de l’abonnement du numéro', () => {
  it('🔴 une émission aux admins, une seule fois : le second tour n’émet rien', async () => {
    const m = monter();
    expect(await m.avis.envoyer('t1', E, 'suspension_mail')).toBe('parti');
    expect(m.emissions).toHaveLength(1);
    expect(m.emissions[0]).toMatchObject({ cle: 'numero_suspendu_fin', a: 'admins', occasion: 'sub_1:suspension_mail:2026-10-14' });
    expect(m.notes).toEqual(['suspension_mail']);
    expect(await m.avis.envoyer('t1', E, 'suspension_mail')).toBe('deja');
    expect(m.emissions).toHaveLength(1);
  });

  it('🔴 une émission ratée ne se note pas : elle se rejoue au tour suivant', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let enPanne = true;
    const m = monter({ emettre: () => { if (enPanne) throw new Error('base injoignable'); } });
    expect(await m.avis.envoyer('t1', E, 'liberation_mail')).toBe('non_envoye');
    expect(m.notes).toEqual([]);
    enPanne = false;
    expect(await m.avis.envoyer('t1', E, 'liberation_mail')).toBe('parti');
    expect(m.notes).toEqual(['liberation_mail']);
  });

  it('🔴 une seconde suspension du même abonnement, après un paiement qui a effacé l’avis, prévient de nouveau', async () => {
    let maintenant = new Date('2026-10-14T10:00:00Z');
    const m = monter({ maintenant: () => maintenant });
    const impaye = { ...E, finiLe: null, liberationLe: null };
    await m.avis.envoyer('t1', impaye, 'suspension_mail');
    // Le paiement efface l'avis (`majStatut('actif')`), puis le mois suivant le renouvellement est de nouveau impayé.
    m.deja.delete('suspension_mail');
    maintenant = new Date('2026-11-21T10:00:00Z');
    expect(await m.avis.envoyer('t1', impaye, 'suspension_mail')).toBe('parti');
    const occasions = m.emissions.map((e) => e.occasion);
    expect(occasions).toEqual(['sub_1:suspension_mail:2026-10-14', 'sub_1:suspension_mail:2026-11-21']);
    expect(new Set(occasions).size, 'deux occasions distinctes : le journal réserve les deux').toBe(2);
  });

  it('le modèle de chaque avis : la suspension a deux textes, fini ou impayé', () => {
    expect(modeleDeLAvis('suspension_mail', E)).toBe('numero_suspendu_fin');
    expect(modeleDeLAvis('suspension_mail', { ...E, finiLe: null })).toBe('numero_suspendu_impaye');
    expect(modeleDeLAvis('rappel_liberation_mail', E)).toBe('numero_rappel_liberation');
    expect(modeleDeLAvis('liberation_mail', E)).toBe('numero_libere');
  });

  it('🔴 les textes : la date de libération dans le fuseau, le lien, la voie Claude, et jamais de tiret long', async () => {
    const rendus = async (etat: typeof E, avis: Parameters<typeof modeleDeLAvis>[0]) => {
      const m = monter();
      await m.avis.envoyer('t1', etat, avis);
      const e = m.emissions[0]!;
      return rendre(modeleDe(e.cle)!, modeleDe(e.cle)!.textes.fr, { ...e.valeurs, _fuseau: 'Europe/Paris', espace: 'Atelier' }, 'fr');
    };
    const fini = await rendus(E, 'suspension_mail');
    expect(fini.text).toContain('13 octobre 2026');
    expect(fini.text).toContain('https://console.exemple/connecter-whatsapp');
    expect(fini.text).toContain('Claude');
    const impaye = await rendus({ ...E, finiLe: null, liberationLe: null }, 'suspension_mail');
    expect(impaye.text).toMatch(/impayé|pas été payé/);
    expect(impaye.text).not.toContain('libéré');
    const rappel = await rendus(E, 'rappel_liberation_mail');
    expect(rappel.sujet).toContain('13 octobre 2026');
    const libere = await rendus(E, 'liberation_mail');
    expect(libere.sujet).toMatch(/libéré/);
    for (const m of [fini, impaye, rappel, libere]) {
      expect(`${m.sujet}${m.text}${m.html}`).not.toMatch(/[\u2014\u2013]/);
      expect(m.html).toContain('<p ');
    }
  });
});
