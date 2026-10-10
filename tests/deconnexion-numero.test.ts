import { describe, it, expect } from 'vitest';
import { deconnecterNumero, type BilanDeconnexion, type GestesDeconnexion } from '../src/account/deconnexion-numero';
import type { IssueSortieNumero } from '../src/numero/liberation.pg';

/**
 * « Déconnecter le numéro » : le DÉROULÉ, sans base ni tiers (`src/account/deconnexion-numero.ts`). Ce qui compte ici est
 * l'ordre et ce qu'un échec arrête : la purge d'abord (son échec arrête tout), les gestes chez Meta et le numéro fourni
 * AVANT le détachement (ils lisent ce qu'il efface), et rien chez Meta sur un objet partagé ou le jeton global.
 */
const BILAN: BilanDeconnexion = {
  phoneNumberId: 'pn-1',
  affiche: '+33 6 12 34 56 78',
  wabaId: 'waba-1',
  partage: false,
  jeton: 'propre',
  numeroFourni: null,
  conversations: 3,
  campagnesArretees: 1,
  mbaAllume: true,
  contactsSurLaListe: 2,
};

function gestes(over: Partial<GestesDeconnexion> = {}) {
  const appels: string[] = [];
  const g: GestesDeconnexion = {
    purgerConversations: async () => { appels.push('purge'); return 3; },
    eteindreMba: async (_t, pn) => { appels.push(`mba_eteint:${pn}`); },
    viderListeMba: async () => { appels.push('mba_liste'); return { retires: 2, refuses: 0 }; },
    desabonnerWaba: async (_t, waba) => { appels.push(`waba:${waba}`); },
    sortirNumeroFourni: async () => { appels.push('fourni'); return { fait: 'resilie', numero: '33612345678' }; },
    programmerFinDuNumero: async () => { appels.push('fin'); return 'programmee'; },
    detacher: async () => { appels.push('detacher'); return { conversations: 1, campagnesArretees: 1 }; },
    ...over,
  };
  return { g, appels };
}

const etats = (r: { etapes: Array<{ etape: string; etat: string }> }) => r.etapes.map((e) => `${e.etape}:${e.etat}`);

describe('déconnecter le numéro : le déroulé', () => {
  it('🔴 dans l’ordre : purge, Meta, numéro fourni, fin de l’abonnement, PUIS le détachement', async () => {
    const { g, appels } = gestes();
    const r = await deconnecterNumero('t1', { ...BILAN, numeroFourni: { numero: '33612345678', vuDeMeta: true } }, g);
    expect(appels).toEqual(['purge', 'mba_eteint:pn-1', 'mba_liste', 'waba:waba-1', 'fourni', 'fin', 'detacher']);
    expect(r).toMatchObject({ fait: true, conversations: 4, campagnesArretees: 1 });
    expect(etats(r)).toEqual([
      'conversations:fait', 'mba_eteint:fait', 'mba_liste:fait', 'waba_desabonne:fait', 'numero_fourni:fait', 'fin_abonnement:fait', 'detachement:fait',
    ]);
  });

  it('🔴 la purge échoue : rien d’autre ne se joue, le numéro reste connecté', async () => {
    const { g, appels } = gestes({ purgerConversations: async () => { appels.push('purge'); throw new Error('verrou'); } });
    const r = await deconnecterNumero('t1', BILAN, g);
    expect(appels).toEqual(['purge']);
    expect(r).toMatchObject({ fait: false, raison: 'purge' });
    expect(etats(r)).toEqual(['conversations:echec']);
  });

  it('un geste chez Meta qui échoue est noté, et la suite se joue quand même', async () => {
    const { g, appels } = gestes({ eteindreMba: async () => { appels.push('mba_eteint'); throw new Error('(#100) refus'); } });
    const r = await deconnecterNumero('t1', BILAN, g);
    expect(appels).toEqual(['purge', 'mba_eteint', 'mba_liste', 'waba:waba-1', 'detacher']);
    expect(r.fait).toBe(true);
    expect(r.etapes.find((e) => e.etape === 'mba_eteint')).toEqual({ etape: 'mba_eteint', etat: 'echec', detail: '(#100) refus' });
  });

  it('une liste que Meta refuse en partie est un échec noté', async () => {
    const { g } = gestes({ viderListeMba: async () => ({ retires: 1, refuses: 1 }) });
    const r = await deconnecterNumero('t1', BILAN, g);
    expect(r.etapes.find((e) => e.etape === 'mba_liste')).toMatchObject({ etat: 'echec', detail: '1 retiré(s), 1 refusé(s) par Meta' });
  });

  it.each([
    ['partagé', { partage: true }, /partagé/],
    ['jeton global', { jeton: 'global' as const }, /jeton global/],
    ['jeton refusé', { jeton: 'invalide' as const }, /refusé par Meta/],
  ])('🔴 %s : aucun geste chez Meta, les trois étapes sautées, le détachement se fait', async (_nom, over, motif) => {
    const { g, appels } = gestes();
    const r = await deconnecterNumero('t1', { ...BILAN, ...over }, g);
    expect(appels).toEqual(['purge', 'detacher']);
    for (const etape of ['mba_eteint', 'mba_liste', 'waba_desabonne']) {
      const e = r.etapes.find((x) => x.etape === etape)!;
      expect(e.etat).toBe('sautee');
      expect(e.detail).toMatch(motif);
    }
    expect(r.fait).toBe(true);
  });

  it('agent éteint, liste vide, aucun compte relié : rien n’est demandé à Meta', async () => {
    const { g, appels } = gestes();
    const r = await deconnecterNumero('t1', { ...BILAN, mbaAllume: false, contactsSurLaListe: 0, wabaId: null }, g);
    expect(appels).toEqual(['purge', 'detacher']);
    expect(etats(r)).toContain('waba_desabonne:sautee');
  });

  it('pas un numéro fourni : ni sortie ni fin d’abonnement', async () => {
    const { g, appels } = gestes();
    const r = await deconnecterNumero('t1', BILAN, g);
    expect(appels).not.toContain('fourni');
    expect(appels).not.toContain('fin');
    expect(etats(r)).toEqual(expect.arrayContaining(['numero_fourni:sautee', 'fin_abonnement:sautee']));
  });

  it.each<[IssueSortieNumero, string]>([
    [{ fait: 'libre', numero: '33612345678' }, 'numero_fourni:fait'],
    [{ fait: 'aucun' }, 'numero_fourni:sautee'],
    [{ fait: 'bloque', numero: '33612345678', cause: 'DIDWW refuse' }, 'numero_fourni:echec'],
  ])('numéro fourni : %j donne %s, et la fin de l’abonnement se demande quand même', async (issue, attendu) => {
    const { g, appels } = gestes({ sortirNumeroFourni: async () => issue });
    const r = await deconnecterNumero('t1', { ...BILAN, numeroFourni: { numero: '33612345678', vuDeMeta: true } }, g);
    expect(etats(r)).toContain(attendu);
    expect(appels).toContain('fin');
    expect(r.fait).toBe(true);
  });

  it.each([
    ['aucun', 'fin_abonnement:sautee'],
    ['echec', 'fin_abonnement:echec'],
  ] as const)('fin de l’abonnement « %s » : %s, sans arrêter le détachement', async (issue, attendu) => {
    const { g } = gestes({ programmerFinDuNumero: async () => issue });
    const r = await deconnecterNumero('t1', { ...BILAN, numeroFourni: { numero: '33612345678', vuDeMeta: true } }, g);
    expect(etats(r)).toContain(attendu);
    expect(r.fait).toBe(true);
  });

  it('le détachement échoue : raison « detachement », les étapes déjà jouées restent dites', async () => {
    const { g } = gestes({ detacher: async () => { throw new Error('deadlock'); } });
    const r = await deconnecterNumero('t1', BILAN, g);
    expect(r).toMatchObject({ fait: false, raison: 'detachement' });
    expect(etats(r).at(-1)).toBe('detachement:echec');
    expect(etats(r)).toContain('waba_desabonne:fait');
  });

  it('plus de numéro au moment de la transaction (un autre geste l’a détaché) : « deja_detache »', async () => {
    const { g } = gestes({ detacher: async () => null });
    const r = await deconnecterNumero('t1', BILAN, g);
    expect(r).toMatchObject({ fait: false, raison: 'deja_detache' });
  });
});
