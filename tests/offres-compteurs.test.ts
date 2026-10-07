import { describe, it, expect } from 'vitest';
import { CompteurDebitMemoire } from '../src/db/debit.memoire';
import type { CompteurDebit } from '../src/db/debit';
import { QuotaModeles, QuotaSuppressions, moisDeParis, bornesDuMois, creerModelesDuLancement } from '../src/offres/compteurs';
import { DROITS, type Offre } from '../src/offres/offres';
import type { SourceOffres } from '../src/offres/offre.pg';

/**
 * LES MODÈLES DU MOIS (lot 6, tâche 4, spec § 4) : 1 000 par mois civil de Paris en Base, sans limite ailleurs. Le
 * compteur est le compteur partagé des copies (`compteurs_debit`) : atomique, tout ou rien.
 */
const offres = (o: Record<string, Offre>): SourceOffres => ({
  offreDe: async (t) => ({ offre: o[t] ?? 'base', droits: DROITS[o[t] ?? 'base'], retourEnBaseLe: null }),
});
const OCT = Date.parse('2026-10-15T12:00:00Z');

describe('le mois civil de Paris', () => {
  it('le mois d’un instant, à l’heure de Paris', () => {
    // Le 31 octobre 2026, Paris est déjà à l'heure d'hiver (UTC+1) : 23 h 30 UTC est 0 h 30 le 1er novembre.
    expect(moisDeParis(Date.parse('2026-10-31T23:30:00Z'))).toBe('2026-11');
    expect(moisDeParis(Date.parse('2026-10-31T22:30:00Z'))).toBe('2026-10');
    expect(moisDeParis(Date.parse('2026-12-31T23:30:00Z'))).toBe('2027-01');
  });
  it('les bornes du mois tombent à minuit de Paris, changement d’heure compris', () => {
    const { debutMs, finMs } = bornesDuMois('2026-10');
    expect(new Date(debutMs).toISOString()).toBe('2026-09-30T22:00:00.000Z');
    expect(new Date(finMs).toISOString()).toBe('2026-10-31T23:00:00.000Z');
  });
});

describe('QuotaModeles', () => {
  it('🔴 le 1 001e modèle du mois est refusé en Base, le 1 000e passe', async () => {
    let t = OCT;
    const q = new QuotaModeles({ offres: offres({}), compteur: new CompteurDebitMemoire(() => t), maintenant: () => t });
    for (let i = 0; i < 999; i++) expect((await q.consommer('t1')).ok).toBe(true);
    expect(await q.consommer('t1')).toEqual({ ok: true });
    expect(await q.consommer('t1')).toEqual({ ok: false, max: 1000 });
    expect(await q.etatDuMois('t1')).toEqual({ max: 1000, reste: 0 });
  });

  it('🔴 l’état du mois compte les modèles même quand l’horloge de la base est en avance sur celle de la copie', async () => {
    // Relecture finale du lot 6 : la lecture filtrait sur « fenêtre >= maintenant de la base - (t - début du mois) », donc
    // la ligne du mois tombait dès que la base était plus de 1 ms en avance, c'est-à-dire presque toujours : la page de
    // l'offre affichait 0, et le refus anticipé au lancement ne voyait jamais rien de consommé.
    const t = OCT;
    const compteurDeLaBase = new CompteurDebitMemoire(() => t + 50);
    const q = new QuotaModeles({ offres: offres({}), compteur: compteurDeLaBase, maintenant: () => t });
    for (let i = 0; i < 3; i++) await q.consommer('t1');
    expect(await q.etatDuMois('t1')).toEqual({ max: 1000, reste: 997 });
  });

  it('🔴 le mois suivant repart à zéro', async () => {
    let t = OCT;
    const q = new QuotaModeles({ offres: offres({}), compteur: new CompteurDebitMemoire(() => t), maintenant: () => t });
    for (let i = 0; i < 1000; i++) await q.consommer('t1');
    expect((await q.consommer('t1')).ok).toBe(false);
    t = Date.parse('2026-11-01T00:30:00Z'); // 1 h 30 à Paris le 1er novembre
    expect((await q.consommer('t1')).ok).toBe(true);
    expect(await q.etatDuMois('t1')).toEqual({ max: 1000, reste: 999 });
  });

  it('un espace ne consomme jamais le quota d’un autre', async () => {
    const q = new QuotaModeles({ offres: offres({}), compteur: new CompteurDebitMemoire(() => OCT), maintenant: () => OCT });
    for (let i = 0; i < 1000; i++) await q.consommer('t1');
    expect((await q.consommer('t2')).ok).toBe(true);
  });

  it('🔴 sans limite (Pro, Entreprise) : rien n’est écrit, rien n’est refusé, l’état du mois est « sans limite »', async () => {
    let appels = 0;
    const compteur: CompteurDebit = {
      compter: async () => { appels += 1; throw new Error('jamais'); },
      lister: async () => { appels += 1; return []; },
    };
    const q = new QuotaModeles({ offres: offres({ t1: 'pro', t2: 'entreprise' }), compteur, maintenant: () => OCT });
    expect(await q.consommer('t1')).toEqual({ ok: true });
    expect(await q.consommer('t2')).toEqual({ ok: true });
    expect(await q.etatDuMois('t1')).toBeNull();
    expect(appels).toBe(0);
  });

  it('🔴 vigilance 2 : deux envois concurrents pour la dernière place, un seul passe', async () => {
    const q = new QuotaModeles({ offres: offres({}), compteur: new CompteurDebitMemoire(() => OCT), maintenant: () => OCT });
    for (let i = 0; i < 999; i++) await q.consommer('t1');
    const [a, b] = await Promise.all([q.consommer('t1'), q.consommer('t1')]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it('🔴 un compteur en panne laisse passer (une limite commerciale ne coupe pas les envois), et le journalise', async () => {
    const journal: string[] = [];
    const compteur: CompteurDebit = {
      compter: async () => { throw new Error('base injoignable'); },
      lister: async () => { throw new Error('base injoignable'); },
    };
    const q = new QuotaModeles({ offres: offres({}), compteur, maintenant: () => OCT, journaliser: (m) => journal.push(m) });
    expect(await q.consommer('t1')).toEqual({ ok: true });
    expect(await q.etatDuMois('t1')).toBeNull();
    expect(journal).toEqual(['quota_modeles_injoignable', 'quota_modeles_injoignable']);
  });
});

describe('creerModelesDuLancement', () => {
  it('sans limite : null, et la campagne n’est même pas comptée', async () => {
    let comptages = 0;
    const f = creerModelesDuLancement({ etatDuMois: async () => null }, async () => { comptages += 1; return 5; });
    expect(await f('t1', 'c1')).toBeNull();
    expect(comptages).toBe(0);
  });

  it('avec limite : la limite, le reste et les modèles de CETTE campagne de CET espace', async () => {
    const vus: string[] = [];
    const f = creerModelesDuLancement({ etatDuMois: async () => ({ max: 1000, reste: 40 }) }, async (c, t) => { vus.push(`${c}|${t}`); return 55; });
    expect(await f('t1', 'c1')).toEqual({ max: 1000, reste: 40, demandes: 55 });
    expect(vus).toEqual(['c1|t1']);
  });
});

describe('QuotaSuppressions (10 suppressions de contacts par jour en Base)', () => {
  it('🔴 la 11e suppression du jour est refusée, une purge qui dépasserait l’est en entier, le lendemain repart à zéro', async () => {
    let t = OCT;
    const q = new QuotaSuppressions({ offres: offres({}), compteur: new CompteurDebitMemoire(() => t), maintenant: () => t });
    expect(await q.consommer('t1', 8)).toEqual({ ok: true });
    expect(await q.consommer('t1', 3)).toEqual({ ok: false, max: 10 });
    expect(await q.consommer('t1', 2)).toEqual({ ok: true });
    expect(await q.consommer('t1', 1)).toEqual({ ok: false, max: 10 });
    t = OCT + 24 * 3_600_000;
    expect(await q.consommer('t1', 10)).toEqual({ ok: true });
  });

  it('sans limite (Pro) : rien n’est compté', async () => {
    const q = new QuotaSuppressions({ offres: offres({ t1: 'pro' }), compteur: { compter: async () => { throw new Error('jamais'); }, lister: async () => [] }, maintenant: () => OCT });
    expect(await q.consommer('t1', 500)).toEqual({ ok: true });
  });
});
