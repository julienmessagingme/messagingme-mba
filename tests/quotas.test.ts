import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { familleDe, jourDeParis, bornesDuJour, comptageQuota, raisonDuRefus } from '../src/api/quotas';
import { GardeUsage, ALERTE_QUOTA_MS, type QuotasEspace } from '../src/api/usage-guard.compteur';
import { CompteurDebitMemoire } from '../src/db/debit.memoire';
import { debutDeFenetre, memoireDesPleines, type CompteurDebit } from '../src/db/debit';
import type { DemandeUsage, OperationApi } from '../src/api/usage-guard';
import { ReglagesPlafondEnCache, REGLAGE_INCONNU, SANS_REGLAGE } from '../src/auth/plafond-espace';

/**
 * Les quotas quotidiens de l'API publique par espace (`src/api/quotas.ts`, décision de Julien du 2026-10-04).
 */
const H = 3_600_000;

describe('le jour civil de Paris', () => {
  it('🔴 le jour change à minuit à PARIS, pas à minuit UTC', () => {
    // 22 h 30 UTC un jour d'été = 0 h 30 à Paris le lendemain.
    expect(jourDeParis(Date.parse('2026-07-10T22:30:00Z'))).toBe('2026-07-11');
    expect(jourDeParis(Date.parse('2026-07-10T21:59:59Z'))).toBe('2026-07-10');
    // L'hiver, une heure d'écart seulement.
    expect(jourDeParis(Date.parse('2026-01-10T23:00:00Z'))).toBe('2026-01-11');
    expect(jourDeParis(Date.parse('2026-01-10T22:59:59Z'))).toBe('2026-01-10');
  });

  it('🔴 un jour dure 24 h, 23 h au passage à l’heure d’été, 25 h au retour', () => {
    const duree = (j: string) => { const b = bornesDuJour(j); return (b.finMs - b.debutMs) / H; };
    expect(duree('2026-07-10')).toBe(24);
    expect(duree('2026-03-29')).toBe(23);
    expect(duree('2026-10-25')).toBe(25);
    expect(new Date(bornesDuJour('2026-07-10').debutMs).toISOString()).toBe('2026-07-09T22:00:00.000Z');
  });

  it('le comptage porte le jour dans sa clé, son minuit pour origine, et finit au minuit suivant', () => {
    const t = Date.parse('2026-10-05T09:00:00Z');
    const c = comptageQuota('envois', 't1', 2000, 50, t);
    expect(c.cle).toBe('quota.envois|t1|2026-10-05');
    expect(c.origineMs).toBe(Date.parse('2026-10-04T22:00:00Z'));
    expect(c.origineMs! + c.dureeMs).toBe(Date.parse('2026-10-05T22:00:00Z'));
    expect([c.max, c.pas]).toEqual([2000, 50]);
    expect(debutDeFenetre(t, c.dureeMs, c.origineMs!)).toBe(c.origineMs);
  });

  it('les familles : envois et fiches seulement ; lectures, catalogues et MCP hors quota', () => {
    const attendu: Record<OperationApi, 'envois' | 'fiches' | null> = {
      'sends.create': 'envois', 'messages.send': 'envois', 'messages.reponse_application': null, 'contacts.batch': 'fiches', 'contacts.upsert': 'fiches',
      'contacts.read': null, 'sends.read': null, 'catalogues.read': null, 'conversations.read': null, 'mcp.call': null, 'mcp.refus': null,
      'templates.create': null, 'templates.read': null, 'webhooks.read': null, 'webhooks.write': null,
    };
    for (const [op, f] of Object.entries(attendu)) expect(familleDe(op as OperationApi), op).toBe(f);
    expect(raisonDuRefus('envois', 2000)).toMatch(/2000 envois .*par jour, remise à zéro à minuit \(heure de Paris\)/);
  });
});

describe('le compteur, avec une origine de fenêtre', () => {
  it('🔴 la fenêtre part de l’origine donnée, en mémoire comme la base, et sa fin est le minuit suivant', async () => {
    let t = Date.parse('2026-10-05T09:00:00Z');
    const compteur = new CompteurDebitMemoire(() => t);
    const c = comptageQuota('fiches', 't1', 3, 2, t);
    const v = await compteur.compter([c]);
    expect(v.accepte).toBe(true);
    expect(v.fenetres[0]!.finMs).toBe(Date.parse('2026-10-05T22:00:00Z'));
    expect((await compteur.compter([comptageQuota('fiches', 't1', 3, 2, t)])).accepte).toBe(false);
    // Le lendemain à Paris : une autre clé, une autre fenêtre.
    t = Date.parse('2026-10-05T22:00:01Z');
    expect((await compteur.compter([comptageQuota('fiches', 't1', 3, 2, t)])).accepte).toBe(true);
  });

  it('la mémoire des fenêtres pleines rend la fin du jour, pas une fin calée sur l’époque', async () => {
    const t = Date.parse('2026-10-05T09:00:00Z');
    const compteur = memoireDesPleines(new CompteurDebitMemoire(() => t), () => t);
    await compteur.compter([comptageQuota('envois', 't1', 1, 1, t)]);
    expect((await compteur.compter([comptageQuota('envois', 't1', 1, 1, t)])).accepte).toBe(false);
    const memorise = await compteur.compter([comptageQuota('envois', 't1', 1, 1, t), { cle: 'autre', dureeMs: 60_000, max: null }]);
    expect(memorise.accepte).toBe(false);
    expect(memorise.fenetres[0]!.finMs).toBe(Date.parse('2026-10-05T22:00:00Z'));
  });

  it('refus rendu par la mémoire : la fenêtre de quota NON pleine garde elle aussi sa fin au minuit de Paris', async () => {
    const t = Date.parse('2026-10-05T09:00:00Z');
    const compteur = memoireDesPleines(new CompteurDebitMemoire(() => t), () => t);
    const plein = { cle: 'plein', dureeMs: 60_000, max: 1 };
    await compteur.compter([plein]);
    expect((await compteur.compter([plein])).accepte).toBe(false);
    const v = await compteur.compter([plein, comptageQuota('envois', 't1', 100, 1, t)]);
    expect(v.accepte).toBe(false);
    expect(v.fenetres[1]).toMatchObject({ pleine: false, finMs: Date.parse('2026-10-05T22:00:00Z') });
  });
});

describe('🔴 le garde d’usage applique les quotas', () => {
  const demande = (operation: OperationApi, unites = 1, tenantId = 't1'): DemandeUsage => ({ tenantId, cleId: 'k1', operation, unites });
  function garde(o: { envois?: number; fiches?: number; reglage?: { envoisJour: number | null; fichesJour: number | null }; compteur?: CompteurDebit } = {}) {
    let t = Date.parse('2026-10-05T09:00:00Z');
    const alertes: string[] = [];
    const quotas: QuotasEspace = {
      reglages: { reglage: async () => o.reglage ?? { envoisJour: null, fichesJour: null } },
      defauts: { envois: o.envois ?? 3, fiches: o.fiches ?? 100 },
      alerter: (texte) => { alertes.push(texte); },
      maintenant: () => t,
    };
    const g = new GardeUsage(o.compteur ?? new CompteurDebitMemoire(() => t), quotas);
    return { g, alertes, avancer: (ms: number) => { t += ms; } };
  }

  it('accepte jusqu’au quota, puis refuse avec l’attente jusqu’à minuit à Paris', async () => {
    const { g } = garde({ envois: 3 });
    for (let i = 0; i < 3; i += 1) expect((await g.demander(demande('messages.send'))).accepte).toBe(true);
    const refus = await g.demander(demande('messages.send'));
    expect(refus.accepte).toBe(false);
    expect(refus.raison).toMatch(/3 envois/);
    // 9 h UTC le 5 octobre : minuit à Paris est à 22 h UTC, dans 13 h.
    expect(refus.quota?.attenteMs).toBe(13 * H);
  });

  it('🔴 un lot qui dépasserait est refusé EN ENTIER, sans rien consommer : un lot plus petit passe ensuite', async () => {
    const { g } = garde({ envois: 10 });
    expect((await g.demander(demande('sends.create', 8))).accepte).toBe(true);
    expect((await g.demander(demande('sends.create', 3))).accepte).toBe(false);
    expect((await g.demander(demande('sends.create', 2))).accepte).toBe(true);
    expect((await g.demander(demande('messages.send'))).accepte).toBe(false);
  });

  it('les deux familles sont indépendantes, et les autres opérations ne comptent pas', async () => {
    const { g } = garde({ envois: 1, fiches: 1 });
    expect((await g.demander(demande('messages.send'))).accepte).toBe(true);
    expect((await g.demander(demande('contacts.upsert'))).accepte).toBe(true);
    expect((await g.demander(demande('contacts.batch', 1))).accepte).toBe(false);
    for (let i = 0; i < 5; i += 1) expect((await g.demander(demande('contacts.read'))).accepte).toBe(true);
    expect((await g.demander(demande('mcp.call'))).accepte).toBe(true);
  });

  it('🔴 un espace ne paie pas pour son voisin', async () => {
    const { g } = garde({ envois: 1 });
    expect((await g.demander(demande('messages.send', 1, 't1'))).accepte).toBe(true);
    expect((await g.demander(demande('messages.send', 1, 't1'))).accepte).toBe(false);
    expect((await g.demander(demande('messages.send', 1, 't2'))).accepte).toBe(true);
  });

  it('le réglage de l’espace l’emporte sur le défaut, et un quota à 0 désactive', async () => {
    const releve = garde({ envois: 1, reglage: { envoisJour: 3, fichesJour: null } });
    for (let i = 0; i < 3; i += 1) expect((await releve.g.demander(demande('messages.send'))).accepte).toBe(true);
    expect((await releve.g.demander(demande('messages.send'))).accepte).toBe(false);
    const coupe = garde({ envois: 0 });
    for (let i = 0; i < 20; i += 1) expect((await coupe.g.demander(demande('messages.send'))).accepte).toBe(true);
  });

  it('🔴 le jour suivant, à Paris, le quota repart', async () => {
    const { g, avancer } = garde({ envois: 1 });
    expect((await g.demander(demande('messages.send'))).accepte).toBe(true);
    expect((await g.demander(demande('messages.send'))).accepte).toBe(false);
    avancer(13 * H);
    expect((await g.demander(demande('messages.send'))).accepte).toBe(true);
  });

  it('🔴 compteur en panne : l’appel passe, et UNE alerte par demi-heure dit que les quotas ne sont plus tenus', async () => {
    const enPanne: CompteurDebit = { compter: async () => { throw new Error('base indisponible'); }, lister: async () => [] };
    const { g, alertes } = garde({ compteur: enPanne });
    for (let i = 0; i < 5; i += 1) expect((await g.demander(demande('messages.send'))).accepte).toBe(true);
    expect(alertes).toHaveLength(1);
    expect(alertes[0]).toMatch(/quotas quotidiens ne sont plus tenus .*base indisponible/);
    expect(ALERTE_QUOTA_MS).toBe(30 * 60_000);
    // Une lecture hors quota ne déclenche aucune alerte de quota.
    const lecture = garde({ compteur: enPanne });
    await lecture.g.demander(demande('contacts.read'));
    expect(lecture.alertes).toEqual([]);
  });

  it('🔴 un réglage qu’on n’a pas pu lire laisse passer le quota, au lieu de retomber au défaut', async () => {
    const t = Date.parse('2026-10-05T09:00:00Z');
    // Première lecture en échec, aucun réglage connu : le cache rend le repli INCONNU, pas le « sans réglage ».
    const cache = new ReglagesPlafondEnCache(async () => { throw new Error('pool saturé'); });
    const lu = await cache.reglage('t1');
    expect(lu).toBe(REGLAGE_INCONNU);
    expect(lu).not.toBe(SANS_REGLAGE);
    const g = new GardeUsage(new CompteurDebitMemoire(() => t), { reglages: cache, defauts: { envois: 1, fiches: 1 }, alerter: () => {}, maintenant: () => t });
    for (let i = 0; i < 5; i += 1) expect((await g.demander(demande('messages.send'))).accepte).toBe(true);
    // Un espace connu, lui, est tenu.
    const connu = new GardeUsage(new CompteurDebitMemoire(() => t), { reglages: new ReglagesPlafondEnCache(async () => SANS_REGLAGE), defauts: { envois: 1, fiches: 1 }, alerter: () => {}, maintenant: () => t });
    expect((await connu.demander(demande('messages.send'))).accepte).toBe(true);
    expect((await connu.demander(demande('messages.send'))).accepte).toBe(false);
  });

  it('🔴 la première fois qu’un espace bute sur un quota dans la journée, UNE alerte ; une autre le lendemain', async () => {
    const { g, alertes, avancer } = garde({ envois: 1 });
    await g.demander(demande('messages.send'));
    for (let i = 0; i < 4; i += 1) await g.demander(demande('messages.send'));
    expect(alertes).toHaveLength(1);
    expect(alertes[0]).toMatch(/quota quotidien de l’API atteint : espace t1, 1 envois par jour/);
    await g.demander(demande('messages.send', 1, 't2'));
    await g.demander(demande('messages.send', 1, 't2'));
    expect(alertes).toHaveLength(2);
    avancer(14 * H);
    await g.demander(demande('messages.send'));
    await g.demander(demande('messages.send'));
    expect(alertes).toHaveLength(3);
  });

  it('sans quotas (null, dit explicitement), rien n’est refusé au-delà', async () => {
    const t = Date.parse('2026-10-05T09:00:00Z');
    const g = new GardeUsage(new CompteurDebitMemoire(() => t), null);
    for (let i = 0; i < 30; i += 1) expect((await g.demander(demande('sends.create', 50))).accepte).toBe(true);
  });
});

describe('câblage des quotas', () => {
  it('🔴 le serveur de production donne une alerte Telegram aux quotas', () => {
    const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(index).toContain('alerter: (texte) => { void sendTelegram(`[mba-${NOM_API}] ${texte}`); },');
    const serveur = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    expect(serveur).toMatch(/new GardeUsage\(debit, \{\n\s+reglages: plafond\.reglages,/);
  });
});
