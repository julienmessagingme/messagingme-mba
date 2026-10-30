import { describe, it, expect, beforeAll } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import type { OpsRouteDeps } from '../src/http/ops';
import type { OpsCreditWhatsappDeps } from '../src/http/ops-credit-whatsapp';
import type { ChargementGrille, ResumeGrille } from '../src/credit-whatsapp/reglages.pg';
import type { LigneCredit, NumeroPourLaLigne } from '../src/credit-whatsapp/lignes.pg';
import type { ProvisionVue } from '../src/credit-whatsapp/credit';
import { exploitationInerte, opsInerte } from './routes-inertes';
import { accesOps, ADRESSE_OPS } from './acces-ops';

/**
 * LES RÉGLAGES DU CRÉDIT WHATSAPP DANS /ops (plan du Crédit WhatsApp, tâche 2) : la grille de Meta, lue depuis le fichier
 * que Meta publie, et la commission des messages. Même autorité que la grille de prix, même note signée.
 */
const acces = accesOps();
let OPS = '';
beforeAll(async () => {
  const s = buildServer({ queue: new FakeQueue(), auth: acces.auth });
  OPS = await acces.jeton(s);
  await s.close();
});
const withTok = (t: string) => ({ headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` } });

const CSV = [
  'Market,Currency,Marketing,Utility,Authentication,Authentication-International,Service',
  'France,EUR,0.0712,0.0248,0.0248,,0.0248',
  'Other,EUR,0.0558,0.0071,0.0071,,0.0071',
].join('\n');

const RESUME: ResumeGrille = {
  id: 'g1', enVigueurLe: '2026-10-01', chargeeLe: '2026-10-30T10:00:00.000Z', chargeePar: ADRESSE_OPS, note: 'grille T4',
  tarifs: 8, perimee: false, prochaine: null,
};

/** Les journaux de l'espace écrits par les routes de la ligne (tâche 8). */
type Trace = { tenant: string; email: string | null; action: string; detail: Record<string, unknown> | undefined };

function app(
  reglages: Partial<OpsCreditWhatsappDeps['reglages']> = {}, monter = true, lignes: Partial<OpsCreditWhatsappDeps['lignes']> = {}, traces: Trace[] = [],
  credit: Partial<OpsCreditWhatsappDeps['credit']> = {},
) {
  const creditWhatsapp: OpsCreditWhatsappDeps = {
    reglages: {
      resumeGrille: async () => RESUME,
      grilleEnVigueur: async () => ({ id: 'g1', enVigueurLe: '2026-10-01', tarifs: [] }),
      chargerGrille: async () => 'g1',
      commission: async () => 5,
      reglerCommission: async () => undefined,
      ...reglages,
    },
    lignes: {
      numeroDeLEspace: async () => null,
      lignesDeLEspace: async () => [],
      poser: async () => true,
      retirer: async () => true,
      ...lignes,
    },
    audit: async (tenant, acteur, action, _cible, detail) => { traces.push({ tenant, email: acteur.email, action, detail }); },
    credit: { solde: async () => 0, dernieresProvisions: async () => [], ...credit },
  };
  const deps: OpsRouteDeps = {
    ...opsInerte,
    exploitation: { ...exploitationInerte, getTenantOverview: async () => [], getGlobalDaily: async () => [], getQueueLoad: async () => [] },
    ...(monter ? { creditWhatsapp } : {}),
  };
  return buildServer({ queue: new FakeQueue(), ops: deps, auth: acces.auth });
}

describe('GET /ops/credit-whatsapp/reglages', () => {
  it('rend la grille en vigueur et la commission', async () => {
    const a = app();
    const res = await a.inject({ method: 'GET', url: '/ops/credit-whatsapp/reglages', ...withTok(OPS) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ grille: RESUME, commissionPct: 5 });
    await a.close();
  });

  it('🔴 sans la session d’exploitation : refus avant toute lecture', async () => {
    let lu = false;
    const a = app({ resumeGrille: async () => { lu = true; return null; } });
    const res = await a.inject({ method: 'GET', url: '/ops/credit-whatsapp/reglages' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(lu).toBe(false);
    await a.close();
  });

  it('sans les réglages câblés : 404, la carte de /ops se masque', async () => {
    const a = app({}, false);
    const res = await a.inject({ method: 'GET', url: '/ops/credit-whatsapp/reglages', ...withTok(OPS) });
    expect(res.statusCode).toBe(404);
    await a.close();
  });
});

describe('PUT /ops/credit-whatsapp/grille', () => {
  it('lit le fichier ICI et charge les tarifs, signés de leur auteur', async () => {
    let recu: ChargementGrille | null = null;
    const a = app({ chargerGrille: async (c) => { recu = c; return 'g2'; } });
    const res = await a.inject({ method: 'PUT', url: '/ops/credit-whatsapp/grille', payload: { csv: CSV, enVigueurLe: '2026-10-01', note: 'grille T4 de Meta' }, ...withTok(OPS) });
    expect(res.statusCode).toBe(200);
    expect(recu).toMatchObject({ enVigueurLe: '2026-10-01', auteur: ADRESSE_OPS, note: 'grille T4 de Meta' });
    expect(recu!.tarifs).toHaveLength(8);
    expect(recu!.tarifs.find((t) => t.marche === 'FR' && t.categorie === 'marketing')?.prixMicroEur).toBe(71200);
    await a.close();
  });

  it('🔴 un fichier faux ne s’enregistre pas, et la réponse nomme la ligne', async () => {
    let charge = false;
    const a = app({ chargerGrille: async () => { charge = true; return 'x'; } });
    const res = await a.inject({ method: 'PUT', url: '/ops/credit-whatsapp/grille', payload: { csv: CSV.replace('Other', 'Atlantis'), enVigueurLe: '2026-10-01', note: 'grille T4' }, ...withTok(OPS) });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toContain('ligne 3 : marché inconnu « Atlantis »');
    expect(charge).toBe(false);
    await a.close();
  });

  it('refuse sans note, avec une date qui n’existe pas, ou avec un champ de trop', async () => {
    const a = app();
    const corps = { csv: CSV, enVigueurLe: '2026-10-01', note: 'grille T4' };
    for (const payload of [{ ...corps, note: ' ' }, { ...corps, enVigueurLe: '2026-02-30' }, { ...corps, enPlus: 1 }]) {
      const res = await a.inject({ method: 'PUT', url: '/ops/credit-whatsapp/grille', payload, ...withTok(OPS) });
      expect(res.statusCode).toBe(400);
    }
    await a.close();
  });
});

describe('PUT /ops/credit-whatsapp/commission', () => {
  it('règle la commission, la note signée de son auteur', async () => {
    let recu: [number, string] | null = null;
    const a = app({ reglerCommission: async (pct, par) => { recu = [pct, par]; } });
    const res = await a.inject({ method: 'PUT', url: '/ops/credit-whatsapp/commission', payload: { commissionPct: 7, note: 'décision du 30/10' }, ...withTok(OPS) });
    expect(res.statusCode).toBe(200);
    expect(recu).toEqual([7, `${ADRESSE_OPS} : décision du 30/10`]);
    await a.close();
  });

  it('refuse une commission hors de 0 à 100, ou décimale', async () => {
    const a = app();
    for (const commissionPct of [-1, 101, 5.5]) {
      const res = await a.inject({ method: 'PUT', url: '/ops/credit-whatsapp/commission', payload: { commissionPct, note: 'essai' }, ...withTok(OPS) });
      expect(res.statusCode).toBe(400);
    }
    await a.close();
  });
});

const T1 = '4169c753-311a-43bb-a334-d8a2cb7caf6f';
const PN = '106540352242922';
const NUMERO: NumeroPourLaLigne = { wabaId: 'w1', fournisseur: 'meta', coexistence: false, delie: false };
const LIGNE: LigneCredit = { id: 'l1', tenantId: T1, phoneNumberId: PN, wabaId: 'w1', origine: 'ops', depuis: '2026-10-30T10:00:00.000Z', arreteeLe: null };
const corpsLigne = (poser = true, note = 'numéro d’essai de la ligne') => ({ phoneNumberId: PN, poser, note });
const URL_LIGNE = `/ops/credit-whatsapp/ligne/${T1}`;

/**
 * UN NUMÉRO SUR LA LIGNE, POSÉ À LA MAIN (tâche 8) : un numéro d'essai avant l'option du lot 2. Le numéro se lit DANS
 * l'espace, et ce que la garde ne saurait pas compter ne passe pas.
 */
describe('POST /ops/credit-whatsapp/ligne/:tenantId', () => {
  it('🔴 pose un numéro de l’espace : la note signée de son auteur, et le journal de l’espace', async () => {
    const poses: unknown[][] = [];
    const lus: string[] = [];
    const traces: Trace[] = [];
    const a = app({}, true, {
      numeroDeLEspace: async (t, pn) => { lus.push(`${t}:${pn}`); return NUMERO; },
      poser: async (...args) => { poses.push(args); return true; },
      lignesDeLEspace: async () => [LIGNE],
    }, traces);
    const res = await a.inject({ method: 'POST', url: URL_LIGNE, ...withTok(OPS), payload: corpsLigne() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId: T1, lignes: [LIGNE], soldeMicroEur: 0, provisions: [] });
    expect(lus).toEqual([`${T1}:${PN}`]);
    expect(poses).toEqual([[T1, PN, 'w1', 'ops', `${ADRESSE_OPS} : numéro d’essai de la ligne`]]);
    expect(traces).toEqual([{ tenant: T1, email: ADRESSE_OPS, action: 'ops.ligne_credit_posee', detail: { phoneNumberId: PN } }]);
    await a.close();
  });

  it('🔴 un numéro d’un autre espace, ou inconnu : 404, rien n’est posé ni tracé', async () => {
    let pose = false;
    const traces: Trace[] = [];
    const a = app({}, true, { numeroDeLEspace: async () => null, poser: async () => { pose = true; return true; } }, traces);
    const res = await a.inject({ method: 'POST', url: URL_LIGNE, ...withTok(OPS), payload: corpsLigne() });
    expect(res.statusCode).toBe(404);
    expect([pose, traces.length]).toEqual([false, 0]);
    await a.close();
  });

  it('🔴 refuse un numéro 360dialog, en coexistence ou délié : 409, rien n’est posé', async () => {
    const cas: Array<[string, NumeroPourLaLigne]> = [
      ['360dialog', { ...NUMERO, fournisseur: '360dialog' }],
      ['coexistence', { ...NUMERO, coexistence: true }],
      ['délié', { ...NUMERO, delie: true }],
    ];
    for (const [nom, numero] of cas) {
      let pose = false;
      const a = app({}, true, { numeroDeLEspace: async () => numero, poser: async () => { pose = true; return true; } });
      const res = await a.inject({ method: 'POST', url: URL_LIGNE, ...withTok(OPS), payload: corpsLigne() });
      expect(res.statusCode, nom).toBe(409);
      expect(pose, nom).toBe(false);
      await a.close();
    }
  });

  it('🔴 aucune grille de Meta en vigueur : 409, rien n’est posé (la garde refuserait tous ses envois)', async () => {
    let pose = false;
    const a = app({ grilleEnVigueur: async () => null }, true, { numeroDeLEspace: async () => NUMERO, poser: async () => { pose = true; return true; } });
    const res = await a.inject({ method: 'POST', url: URL_LIGNE, ...withTok(OPS), payload: corpsLigne() });
    expect(res.statusCode).toBe(409);
    expect(pose).toBe(false);
    await a.close();
  });

  it('🔴 un numéro sorti de l’espace (déconnecté, relié ailleurs) se retire encore de sa ligne', async () => {
    const retraits: string[] = [];
    const a = app({}, true, { numeroDeLEspace: async () => null, retirer: async (t, pn) => { retraits.push(`${t}:${pn}`); return true; } });
    const res = await a.inject({ method: 'POST', url: URL_LIGNE, ...withTok(OPS), payload: corpsLigne(false, 'numéro rendu') });
    expect(res.statusCode).toBe(200);
    expect(retraits).toEqual([`${T1}:${PN}`]);
    await a.close();
  });

  it('un numéro déjà sur la ligne : 409', async () => {
    const a = app({}, true, { numeroDeLEspace: async () => NUMERO, poser: async () => false });
    const res = await a.inject({ method: 'POST', url: URL_LIGNE, ...withTok(OPS), payload: corpsLigne() });
    expect(res.statusCode).toBe(409);
    await a.close();
  });

  it('retire un numéro, même en coexistence : la trace du retrait ; 404 s’il n’est plus sur la ligne', async () => {
    const traces: Trace[] = [];
    const retraits: string[] = [];
    const a = app({}, true, {
      numeroDeLEspace: async () => ({ ...NUMERO, coexistence: true }),
      retirer: async (t, pn) => { retraits.push(`${t}:${pn}`); return retraits.length === 1; },
    }, traces);
    const res = await a.inject({ method: 'POST', url: URL_LIGNE, ...withTok(OPS), payload: corpsLigne(false, 'fin de l’essai') });
    expect(res.statusCode).toBe(200);
    expect(traces.map((x) => x.action)).toEqual(['ops.ligne_credit_retiree']);
    const encore = await a.inject({ method: 'POST', url: URL_LIGNE, ...withTok(OPS), payload: corpsLigne(false, 'fin de l’essai') });
    expect(encore.statusCode).toBe(404);
    expect(traces).toHaveLength(1);
    await a.close();
  });

  it('refuse sans note, un identifiant qui n’est pas de Meta, un champ de trop, un espace mal formé', async () => {
    let lu = false;
    const a = app({}, true, { numeroDeLEspace: async () => { lu = true; return NUMERO; } });
    for (const payload of [
      corpsLigne(true, '  '),
      { ...corpsLigne(), phoneNumberId: '+33612345678' },
      { ...corpsLigne(), poser: 'oui' },
      { ...corpsLigne(), origine: 'option' },
    ]) {
      const res = await a.inject({ method: 'POST', url: URL_LIGNE, ...withTok(OPS), payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await a.inject({ method: 'POST', url: '/ops/credit-whatsapp/ligne/pas-un-uuid', ...withTok(OPS), payload: corpsLigne() })).statusCode).toBe(404);
    expect(lu).toBe(false);
    await a.close();
  });

  it('🔴 sans la session d’exploitation : refus avant toute lecture ; GET rend les lignes, le solde et les dernières provisions', async () => {
    let lu = false;
    const PROVISION: ProvisionVue = {
      id: 'p1', creeLe: '2026-10-30T10:00:00.000Z', phoneNumberId: PN, wamid: 'wamid.1', pays: 'FR', categorie: 'utility',
      montantMicroEur: 26_040, etat: 'rendu', livreLe: null,
    };
    const demandes: number[] = [];
    const a = app({}, true, { numeroDeLEspace: async () => { lu = true; return NUMERO; }, lignesDeLEspace: async () => [LIGNE] }, [], {
      solde: async () => 973_960,
      dernieresProvisions: async (_t, n) => { demandes.push(n ?? -1); return [PROVISION]; },
    });
    const refus = await a.inject({ method: 'POST', url: URL_LIGNE, headers: { 'content-type': 'application/json' }, payload: corpsLigne() });
    expect(refus.statusCode).toBeGreaterThanOrEqual(400);
    expect(lu).toBe(false);
    const res = await a.inject({ method: 'GET', url: URL_LIGNE, ...withTok(OPS) });
    expect(res.json()).toEqual({ tenantId: T1, lignes: [LIGNE], soldeMicroEur: 973_960, provisions: [PROVISION] });
    expect(demandes).toEqual([50]);
    await a.close();
  });
});
