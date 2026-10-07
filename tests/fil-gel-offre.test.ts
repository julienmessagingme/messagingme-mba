import { describe, it, expect, vi } from 'vitest';
import { bancDuFil } from './banc-du-fil';
import { sousLOffre, modeEffectif, leMbaRepond, type ReglageDuRepondeur } from '../src/repondeur/mode';
import { DROITS } from '../src/offres/offres';

/**
 * 🔴 LE GEL DE L'AGENT DE META ET DU SCÉNARIO RÉPONDEUR AU RETOUR EN BASE (lot 6, livraison B2a, spec § 7, décision de
 * Julien du 2026-10-07). L'agent de Meta ne reçoit plus aucun contact neuf, le scénario répondeur ne part plus : un espace
 * en Base réglé sur « MBA » ou « Scénario » se comporte EXACTEMENT comme un espace réglé sur « Équipe ». Rien n'est écrit
 * chez Meta, rien ne change dans les réglages : tout revient au réabonnement.
 */
const MSG = 'Bonjour';

type Banc = ReturnType<typeof bancDuFil>;
/** Tout ce que le contrôle du fil a fait, comparable d'un banc à l'autre. */
const trace = (b: Banc) => ({
  ecritures: b.ecritures.map((e) => ({ waId: e.waId, owner: e.owner })),
  appels: b.appels, demandes: b.demandes, demarrages: b.demarrages, reclamations: b.reclamations,
  lancementsScenario: b.lancementsScenario, liste: [...b.table.keys()],
});

describe('sousLOffre : les réglages tels que l’offre les laisse jouer', () => {
  const r = (over: Partial<ReglageDuRepondeur> = {}): ReglageDuRepondeur => ({
    mbaEnabled: true, repondeurMode: 'mba', repondeurAgentId: null, repondeurWorkflowId: null, ...over,
  });

  it('🔴 en Base, « MBA » et « Scénario » se lisent « Équipe », « Agent IA » reste', () => {
    expect(modeEffectif(sousLOffre(r(), DROITS.base.fonctions))).toBe('equipe');
    expect(leMbaRepond(sousLOffre(r(), DROITS.base.fonctions))).toBe(false);
    expect(modeEffectif(sousLOffre(r({ repondeurMode: 'scenario', repondeurWorkflowId: 'wf' }), DROITS.base.fonctions))).toBe('equipe');
    expect(modeEffectif(sousLOffre(r({ repondeurMode: 'agent', repondeurAgentId: 'ag' }), DROITS.base.fonctions))).toBe('agent');
  });

  it('en Pro et en Entreprise, rien ne change', () => {
    for (const o of ['pro', 'entreprise'] as const) {
      expect(modeEffectif(sousLOffre(r(), DROITS[o].fonctions))).toBe('mba');
      expect(modeEffectif(sousLOffre(r({ repondeurMode: 'scenario', repondeurWorkflowId: 'wf' }), DROITS[o].fonctions))).toBe('scenario');
    }
  });

  it('rien n’est muté, les autres champs passent tels quels', () => {
    const avant = { ...r(), controlHandbackSeconds: 42 };
    const apres = sousLOffre(avant, DROITS.base.fonctions);
    expect(avant.mbaEnabled).toBe(true);
    expect(apres.controlHandbackSeconds).toBe(42);
  });
});

describe('le contrôle du fil en Base (lot 6, B2a)', () => {
  it('🔴 mode « MBA » : la remise fait exactement ce que ferait l’équipe, l’agent ne reçoit rien', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const base = bancDuFil({ mode: 'mba', mbaEnabled: true, offre: 'base', conversations: { w: { owner: 'app_workflow' } } });
    const equipe = bancDuFil({ mode: 'equipe', mbaEnabled: true, conversations: { w: { owner: 'app_workflow' } } });
    await base.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false });
    await equipe.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false });
    expect(trace(base)).toEqual(trace(equipe));
    // L'ancre : la remise de l'équipe a bien agi (sinon l'égalité ne prouverait rien).
    expect(equipe.ecritures.length + equipe.demandes.length).toBeGreaterThan(0);
  });

  it('🔴 mode « Scénario » : le scénario répondeur ne part pas, la remise est celle de l’équipe', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const base = bancDuFil({ mode: 'scenario', repondeurWorkflowId: 'wf-r', mbaEnabled: false, offre: 'base', conversations: { w: { owner: 'app_workflow' } } });
    const equipe = bancDuFil({ mode: 'equipe', mbaEnabled: false, conversations: { w: { owner: 'app_workflow' } } });
    await base.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false });
    await equipe.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false });
    expect(base.lancementsScenario).toEqual([]);
    expect(trace(base)).toEqual(trace(equipe));
  });

  it('🔴 le bloc « Envoyer au MBA » ne confie rien : l’agent est vu éteint, la conversation va à l’équipe', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const b = bancDuFil({ mode: 'equipe', mbaEnabled: true, offre: 'base', conversations: { w: { owner: 'app_workflow' } } });
    expect(await b.fil.envoyerAuMba('t1', 'w', { contenu: MSG, cause: 'bloc' })).toBe('mba_eteint');
    expect(b.table.has('w')).toBe(false);
  });

  it('en Pro, le mode « MBA » confie comme avant', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const pro = bancDuFil({ mode: 'mba', mbaEnabled: true, offre: 'pro', conversations: { w: { owner: 'app_workflow' } } });
    await pro.fil.remettreSiPersonneNeSuit('t1', 'w', MSG, { rouverte: false });
    expect(pro.table.has('w')).toBe(true);
  });
});
