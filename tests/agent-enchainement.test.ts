import { describe, it, expect } from 'vitest';
import {
  PARAM_DEJA_DEMANDE, fauteDOrdre, lanceUnScenario, paramsDeLEnchainement, planEnchainement, risqueDeLEnchainement,
  scenariosDeLEnchainement, type EtapeEnchainement,
} from '../src/agent/enchainement';
import { lireCibleOutilAgent, outilExpose, paramsEffectifs } from '../src/agent/outils-maison';
import { risqueDeLOutil } from '../src/agent/reglages';
import { creerResolveurMba, type DepsResolveurMba } from '../src/agent/resolvers/mba';
import { creerResolveurSimulation } from '../src/agent/resolvers/simulation';
import type { ContexteAppel } from '../src/agent/executor';
import type { OutilDefini } from '../src/agent/catalog';
import { SANS_MCP } from './outils-mcp';
import { AUCUN_GESTE } from './gestes';

/**
 * L'OUTIL ENCHAÎNÉ (`src/agent/enchainement.ts`, demande de Julien du 2026-10-20) : des étapes rangées par
 * l'administrateur, exécutées DANS SON ORDRE, et une question posée UNE fois au plus.
 *
 * 🔴 LES DEUX CAS QUI COMPTENT. (1) Le premier appel sans les informations n'agit pas : il rend les questions, rien
 * ne part chez le contact ni sur sa fiche. (2) Le second appel, `deja_demande` à vrai, exécute TOUT même avec un refus :
 * un candidat qui veut parler à quelqu'un n'attend jamais derrière un formulaire.
 */

const WF = '0b7e2c1a-4d5e-4f60-8a9b-1c2d3e4f5a6b';
const BLOC = 'nod_t1_01HZX5Y6Z7A8B9C0D1E2F3G4H5';
const Q_PRENOM: EtapeEnchainement = { type: 'demander', champ: 'prenom', question: 'ton prénom', valeurs: [] };
const Q_CAMPUS: EtapeEnchainement = { type: 'demander', champ: 'campus', question: 'le campus', valeurs: ['Bayonne', 'Lyon'] };
const TAG: EtapeEnchainement = { type: 'tag', tag: 'lead_chaud' };
const SCENARIO: EtapeEnchainement = { type: 'scenario', workflowId: WF };

/** Le parcours Pigier : deux questions, une étiquette, puis le passage à l'équipe. */
const PIGIER: EtapeEnchainement[] = [Q_PRENOM, Q_CAMPUS, TAG, SCENARIO];

const cible = (etapes: EtapeEnchainement[]) => ({ handler: 'enchainer', etapes });

const outil = (etapes: EtapeEnchainement[]): OutilDefini => ({ ...SANS_MCP, ...AUCUN_GESTE(),
  id: 'to1', tenantId: 't1', origin: 'mba', name: 'qualifier_puis_transferer', description: 'Quand le candidat est chaud.',
  params: [], binding: cible(etapes), sourceId: null, requestId: null, nePasUtiliser: '', nature: 'integre' as const,
  outputPaths: [], risk: 'irreversible', timeoutMs: 5_000, maxBytes: 16_384, autonome: true,
});

const CTX: ContexteAppel = {
  tenantId: 't1', agentId: 'ag1', sessionId: 's1', runId: 'r1', workflowId: 'wf-de-l-agent', waId: '33600',
  contact: { wa_id: '33600' }, contactInconnu: 'tous', appelsRestants: 5, budgetRestantMicroEur: 10_000, deadline: Date.now() + 30_000,
};

function harnais(over: Partial<DepsResolveurMba> = {}) {
  const journal: string[] = [];
  const deps: DepsResolveurMba = {
    envoyerBloc: async (i) => { journal.push(`bloc:${i.code}`); return { ok: true }; },
    lancerScenario: async (i) => { journal.push(`scenario:${i.workflowId}`); return { ok: true }; },
    escaladerVersHumain: async () => { journal.push('escalade'); return true; },
    marquerUrgente: async () => { journal.push('urgent'); return true; },
    declencherAction: async () => 'declenchee',
    poserTag: async (_t, _w, tag) => { journal.push(`tag:${tag}`); },
    ecrireChamp: async (_t, _w, cle, valeur) => { journal.push(`champ:${cle}=${valeur}`); },
    lireAnalyse: async () => null,
    connaissance: { chercher: async () => [] },
    ...over,
  };
  return { resolveur: creerResolveurMba(deps), journal };
}

const appel = (etapes: EtapeEnchainement[], args: Record<string, unknown>, ctx: ContexteAppel = CTX) =>
  ({ outil: outil(etapes), args, ctx, signal: new AbortController().signal });

describe('outil enchaîné : la cible et ses règles d’ordre', () => {
  it('le parcours Pigier se lit comme une cible d’outil', () => {
    expect(lireCibleOutilAgent(cible(PIGIER))?.handler).toBe('enchainer');
  });

  it('🔴 un scénario ferme la marche : rien après lui', () => {
    expect(fauteDOrdre([SCENARIO, TAG])).toMatch(/ferme la marche/);
    expect(lireCibleOutilAgent(cible([SCENARIO, TAG]))).toBeNull();
  });

  it('🔴 aucun bloc ni scénario avant une question : il partirait après la réponse, à rebours de l’ordre affiché', () => {
    const bloc: EtapeEnchainement = { type: 'bloc', workflowId: WF, code: BLOC };
    expect(fauteDOrdre([bloc, Q_PRENOM, SCENARIO])).toMatch(/après la réponse/);
    expect(lireCibleOutilAgent(cible([bloc, Q_PRENOM]))).toBeNull();
    // Une étiquette avant une question se rejoue sans dégât : l'ordre est libre.
    expect(fauteDOrdre([TAG, Q_PRENOM, { type: 'urgent' }, bloc, SCENARIO])).toBeNull();
  });

  it('deux questions sur le même champ, une clé réservée ou aucune étape : refusés', () => {
    expect(fauteDOrdre([Q_PRENOM, { ...Q_PRENOM, question: 'encore' }])).toMatch(/même champ/);
    expect(lireCibleOutilAgent(cible([{ ...Q_PRENOM, champ: PARAM_DEJA_DEMANDE }]))).toBeNull();
    expect(lireCibleOutilAgent(cible([]))).toBeNull();
  });

  it('irréversible dès qu’un bloc ou un scénario part chez le contact, et l’autonomie suit à la pose', () => {
    expect(risqueDeLEnchainement([Q_PRENOM, TAG])).toBe('write');
    expect(risqueDeLEnchainement(PIGIER)).toBe('irreversible');
    const lue = lireCibleOutilAgent(cible(PIGIER));
    expect(risqueDeLOutil('write', lue)).toBe('irreversible');
    // Un autre outil garde le risque de son catalogue.
    expect(risqueDeLOutil('write', lireCibleOutilAgent({ handler: 'poser_tag', tag: 'x' }))).toBe('write');
  });

  it('les scénarios visés, sans doublon, pour la garde d’isolation', () => {
    const bloc: EtapeEnchainement = { type: 'bloc', workflowId: WF, code: BLOC };
    expect(scenariosDeLEnchainement([Q_PRENOM, bloc, SCENARIO])).toEqual([WF]);
    expect(lanceUnScenario(PIGIER)).toBe(true);
    expect(lanceUnScenario([Q_PRENOM, TAG])).toBe(false);
  });
});

describe('outil enchaîné : ce que le modèle voit', () => {
  it('🔴 une question par paramètre facultatif, bornée à ses valeurs, et deja_demande requis', () => {
    const params = paramsDeLEnchainement(PIGIER);
    expect(params.map((p) => [p.name, p.required])).toEqual([['prenom', false], ['campus', false], [PARAM_DEJA_DEMANDE, true]]);
    expect(params.find((p) => p.name === 'campus')?.enum).toEqual(['Bayonne', 'Lyon']);
    // La validation lit les mêmes : un paramètre annoncé mais retiré par Zod serait perdu sans erreur.
    expect(paramsEffectifs(outil(PIGIER)).map((p) => p.name)).toEqual(['prenom', 'campus', PARAM_DEJA_DEMANDE]);
  });

  it('sans question, aucun paramètre', () => {
    expect(paramsDeLEnchainement([TAG, SCENARIO])).toEqual([]);
  });

  it('les étapes sont dites dans l’ordre, sans nom interne (tag, scénario)', () => {
    const expose = outilExpose(outil(PIGIER), []);
    expect(expose?.description).toMatch(/1\) enregistre « ton prénom » ; 2\) enregistre « le campus » ; 3\) pose une étiquette/);
    expect(expose?.description).toMatch(/UN seul message/);
    expect(expose?.description).not.toMatch(/lead_chaud|0b7e2c1a/);
    expect(expose?.parameters.required).toEqual([PARAM_DEJA_DEMANDE]);
  });
});

describe('outil enchaîné : la décision', () => {
  it('🔴 il manque une information jamais demandée : on demande, on n’exécute rien', () => {
    expect(planEnchainement(PIGIER, { prenom: 'Yanis', [PARAM_DEJA_DEMANDE]: false }))
      .toEqual({ quoi: 'demander', questions: ['le campus'] });
  });

  it('🔴 déjà demandé : on exécute avec ce qu’on a, même rien', () => {
    const plan = planEnchainement(PIGIER, { [PARAM_DEJA_DEMANDE]: true });
    expect(plan.quoi).toBe('executer');
  });

  it('tout est donné : on exécute sans demander', () => {
    const plan = planEnchainement(PIGIER, { prenom: 'Yanis', campus: 'Bayonne', [PARAM_DEJA_DEMANDE]: false });
    expect(plan).toEqual({ quoi: 'executer', valeurs: new Map([['prenom', 'Yanis'], ['campus', 'Bayonne']]) });
  });

  it('une valeur hors liste ne compte pas comme donnée', () => {
    expect(planEnchainement(PIGIER, { prenom: 'Yanis', campus: 'Pau', [PARAM_DEJA_DEMANDE]: false }))
      .toEqual({ quoi: 'demander', questions: ['le campus'] });
  });
});

describe('outil enchaîné : le résolveur de production', () => {
  it('🔴 premier appel incomplet : les questions reviennent, RIEN ne part', async () => {
    const { resolveur, journal } = harnais();
    const r = await resolveur(appel(PIGIER, { [PARAM_DEJA_DEMANDE]: false }));
    expect(r.contenu).toMatchObject({ a_demander: ['ton prénom', 'le campus'] });
    expect(r.scenarioLance).toBeUndefined();
    expect(journal).toEqual([]);
  });

  it('🔴 les étapes partent DANS L’ORDRE de l’administrateur, puis le scénario termine le tour', async () => {
    const { resolveur, journal } = harnais();
    const r = await resolveur(appel(PIGIER, { prenom: 'Yanis', campus: 'Bayonne', [PARAM_DEJA_DEMANDE]: false }));
    expect(journal).toEqual(['champ:prenom=Yanis', 'champ:campus=Bayonne', 'tag:lead_chaud', `scenario:${WF}`]);
    expect(r.scenarioLance).toBe(true);
  });

  it('🔴 un ordre différent est respecté tel quel', async () => {
    const { resolveur, journal } = harnais();
    await resolveur(appel([TAG, { type: 'urgent' }, Q_PRENOM, { type: 'valeur', champ: 'statut', valeur: 'chaud' }], { prenom: 'Lina', [PARAM_DEJA_DEMANDE]: false }));
    expect(journal).toEqual(['tag:lead_chaud', 'urgent', 'champ:prenom=Lina', 'champ:statut=chaud']);
  });

  it('🔴 refus du contact après la question : on transfère quand même, sans les champs absents', async () => {
    const { resolveur, journal } = harnais();
    const r = await resolveur(appel(PIGIER, { [PARAM_DEJA_DEMANDE]: true }));
    expect(journal).toEqual(['tag:lead_chaud', `scenario:${WF}`]);
    expect(r.scenarioLance).toBe(true);
  });

  it('une écriture qui échoue ne bloque pas le passage à l’équipe, et le modèle le lit', async () => {
    const { resolveur, journal } = harnais({ ecrireChamp: async () => { throw new Error('base indisponible'); } });
    const r = await resolveur(appel(PIGIER, { prenom: 'Yanis', campus: 'Lyon', [PARAM_DEJA_DEMANDE]: false }));
    expect(journal).toEqual(['tag:lead_chaud', `scenario:${WF}`]);
    expect(r.contenu).toMatchObject({ lance: true, non_abouti: ['ton prénom', 'le campus'] });
  });

  it('un scénario refusé rend un échec : la session reste vivante', async () => {
    const { resolveur } = harnais({ lancerScenario: async () => ({ ok: false, raison: 'scénario dépublié' }) });
    const r = await resolveur(appel(PIGIER, { [PARAM_DEJA_DEMANDE]: true }));
    expect(r.ok).toBe(false);
    expect(r.scenarioLance).toBeUndefined();
    expect(r.erreur).toMatch(/dépublié/);
  });

  it('🔴 le scénario où l’agent parle déjà est refusé AVANT toute étape', async () => {
    const { resolveur, journal } = harnais();
    const r = await resolveur(appel(PIGIER, { [PARAM_DEJA_DEMANDE]: true }, { ...CTX, workflowId: WF }));
    expect(r.ok).toBe(false);
    expect(journal).toEqual([]);
  });

  it('sans scénario, le tour continue', async () => {
    const { resolveur } = harnais();
    const r = await resolveur(appel([Q_PRENOM, TAG], { prenom: 'Yanis', [PARAM_DEJA_DEMANDE]: false }));
    expect(r.contenu).toMatchObject({ fait: true, note: expect.stringMatching(/ne rappelle pas/) });
    expect(r.scenarioLance).toBeUndefined();
  });

  it('une réponse trop longue est ramenée à la borne annoncée', async () => {
    const { resolveur, journal } = harnais();
    await resolveur(appel([Q_PRENOM], { prenom: 'x'.repeat(5000), [PARAM_DEJA_DEMANDE]: false }));
    expect(journal).toEqual([`champ:prenom=${'x'.repeat(1000)}`]);
  });
});

describe('outil enchaîné : le bac à sable juge comme la production', () => {
  const simulation = creerResolveurSimulation({ connaissance: { chercher: async () => [] } });

  it('les mêmes questions au premier appel incomplet', async () => {
    const r = await simulation(appel(PIGIER, { [PARAM_DEJA_DEMANDE]: false }));
    expect(r.contenu).toMatchObject({ a_demander: ['ton prénom', 'le campus'] });
  });

  it('rien ne part, mais le tour s’arrête sur le scénario comme en production', async () => {
    const r = await simulation(appel(PIGIER, { prenom: 'Yanis', [PARAM_DEJA_DEMANDE]: true }));
    expect(r.contenu).toMatchObject({ simule: true, enregistrees: { prenom: 'Yanis' } });
    expect(r.scenarioLance).toBe(true);
  });
});

/**
 * LE TRANSFERT À L'ÉQUIPE ET « QUALIFIER ET TRANSFÉRER » (demande de Julien du 2026-10-20) : le même moteur, une étape
 * terminale de plus, et le geste de « Passer la main à un humain » au bout.
 */
const TRANSFERT: EtapeEnchainement = { type: 'transferer' };

describe('l’étape « transférer en À traiter »', () => {
  it('🔴 elle ferme la marche, et il n’y a qu’un seul scénario ou transfert', () => {
    expect(fauteDOrdre([Q_PRENOM, TAG, TRANSFERT])).toBeNull();
    expect(fauteDOrdre([TRANSFERT, TAG])).toMatch(/ferme la marche/);
    expect(fauteDOrdre([Q_PRENOM, SCENARIO, TRANSFERT])).toMatch(/un seul/);
    expect(lireCibleOutilAgent(cible([Q_PRENOM, SCENARIO, TRANSFERT]))).toBeNull();
  });

  it('🔴 une question ne peut pas remplir « message », la phrase de l’agent', () => {
    expect(lireCibleOutilAgent(cible([{ ...Q_PRENOM, champ: 'message' }, TRANSFERT]))).toBeNull();
  });

  it('elle n’est pas un envoi : l’outil reste une écriture', () => {
    expect(risqueDeLEnchainement([Q_PRENOM, TRANSFERT])).toBe('write');
  });

  it('🔴 la phrase de l’agent est un paramètre, toléré absent à la validation, annoncé requis au modèle', () => {
    const message = paramsDeLEnchainement([Q_PRENOM, TRANSFERT]).find((p) => p.name === 'message');
    expect(message).toMatchObject({ type: 'string', required: false });
    expect(paramsDeLEnchainement([TAG, TRANSFERT]).map((p) => p.name)).toEqual(['message']);
    expect(paramsDeLEnchainement([Q_PRENOM, TAG]).some((p) => p.name === 'message')).toBe(false);
    const expose = outilExpose(outil([Q_PRENOM, TRANSFERT]), []);
    expect(expose?.parameters.required).toEqual(expect.arrayContaining(['message', PARAM_DEJA_DEMANDE]));
    expect(expose?.description).toMatch(/passe la conversation à l’équipe/);
    expect(expose?.description).toMatch(/Si le contact demande à parler à quelqu’un, appelle cet outil tout de suite/);
  });

  it('🔴 les étapes partent, puis la conversation passe à l’équipe : le tour s’arrête et garde la phrase', async () => {
    const { resolveur, journal } = harnais();
    const r = await resolveur(appel([Q_PRENOM, TAG, TRANSFERT], { prenom: 'Yanis', [PARAM_DEJA_DEMANDE]: true, message: 'Je vous passe un conseiller.' }));
    expect(journal).toEqual(['champ:prenom=Yanis', 'tag:lead_chaud', 'escalade']);
    expect(r).toMatchObject({ contenu: { escalade: true }, rendu: true, mainPrise: true, dernierMessage: 'Je vous passe un conseiller.' });
  });

  it('🔴 un transfert qui échoue le dit, et propose UN rappel quand aucun message n’est parti', async () => {
    const { resolveur, journal } = harnais({ escaladerVersHumain: async () => { throw new Error('base indisponible'); } });
    const r = await resolveur(appel([Q_PRENOM, TRANSFERT], { prenom: 'Yanis', [PARAM_DEJA_DEMANDE]: true }));
    expect(journal).toEqual(['champ:prenom=Yanis']);
    expect(r.ok).toBe(false);
    expect(r.rendu).toBeUndefined();
    expect(JSON.stringify(r.contenu)).toMatch(/Rappelle cet outil une seule fois/);
  });

  it('🔴 un transfert qui échoue après un message prévu interdit le rappel : le message repartirait', async () => {
    const bloc: EtapeEnchainement = { type: 'bloc', workflowId: WF, code: BLOC };
    const { resolveur } = harnais({ escaladerVersHumain: async () => { throw new Error('base indisponible'); } });
    const r = await resolveur(appel([TAG, bloc, TRANSFERT], {}));
    expect(JSON.stringify(r.contenu)).toMatch(/Ne rappelle pas cet outil : le message prévu repartirait/);
  });

  it('un échec non bloquant d’avant le transfert remonte avec lui', async () => {
    const { resolveur } = harnais({ poserTag: async () => { throw new Error('tag refusé'); } });
    const r = await resolveur(appel([TAG, TRANSFERT], {}));
    expect(r).toMatchObject({ contenu: { escalade: true, non_abouti: ['étiquette'] }, rendu: true });
  });
});

const QUESTIONS = [
  { champ: 'prenom', question: 'ton prénom', valeurs: [] },
  { champ: 'campus', question: 'le campus', valeurs: ['Bayonne', 'Lyon'] },
];
const outilQualif = (questions: unknown[] = QUESTIONS): OutilDefini => ({
  ...outil([]), name: 'mba_qualifier_transferer', binding: { handler: 'qualifier_transferer', questions }, risk: 'write',
});
const appelQualif = (args: Record<string, unknown>) =>
  ({ outil: outilQualif(), args, ctx: CTX, signal: new AbortController().signal });

describe('« Qualifier et transférer »', () => {
  it('🔴 sa cible n’est qu’une liste de questions : rien d’autre ne passe', () => {
    expect(lireCibleOutilAgent({ handler: 'qualifier_transferer', questions: QUESTIONS })?.handler).toBe('qualifier_transferer');
    expect(lireCibleOutilAgent({ handler: 'qualifier_transferer', questions: [] })).toBeNull();
    expect(lireCibleOutilAgent({ handler: 'qualifier_transferer', questions: [QUESTIONS[0], QUESTIONS[0]] })).toBeNull();
    expect(lireCibleOutilAgent({ handler: 'qualifier_transferer', questions: QUESTIONS, etapes: [TAG] })).toBeNull();
    expect(lireCibleOutilAgent({ handler: 'qualifier_transferer', questions: [{ ...QUESTIONS[0], type: 'tag' }] })).toBeNull();
    expect(risqueDeLOutil('write', lireCibleOutilAgent({ handler: 'qualifier_transferer', questions: QUESTIONS }))).toBe('write');
  });

  it('🔴 le modèle lit ses questions, deja_demande et sa phrase, et la règle « tout de suite »', () => {
    const params = paramsEffectifs(outilQualif());
    expect(params.map((p) => p.name)).toEqual(['prenom', 'campus', PARAM_DEJA_DEMANDE, 'message']);
    expect(params.find((p) => p.name === 'campus')?.enum).toEqual(['Bayonne', 'Lyon']);
    const expose = outilExpose(outilQualif(), []);
    expect(expose?.description).toContain('1) enregistre « ton prénom » ; 2) enregistre « le campus » ; 3) passe la conversation à l’équipe');
    expect(expose?.description).toMatch(/appelle cet outil tout de suite/);
  });

  it('🔴 le contact veut un humain sans rien donner : UNE question, rien ne part', async () => {
    const { resolveur, journal } = harnais();
    const r = await resolveur(appelQualif({ [PARAM_DEJA_DEMANDE]: false, message: 'Je vous passe quelqu’un.' }));
    expect(r.contenu).toMatchObject({ a_demander: ['ton prénom', 'le campus'] });
    expect(r.rendu).toBeUndefined();
    expect(journal).toEqual([]);
  });

  it('🔴 il refuse de répondre : on transfère quand même, tout de suite', async () => {
    const { resolveur, journal } = harnais();
    const r = await resolveur(appelQualif({ [PARAM_DEJA_DEMANDE]: true, message: 'Un conseiller vous répond.' }));
    expect(journal).toEqual(['escalade']);
    expect(r).toMatchObject({ rendu: true, mainPrise: true, dernierMessage: 'Un conseiller vous répond.' });
  });

  it('🔴 il répond : chaque réponse dans son champ, puis le transfert', async () => {
    const { resolveur, journal } = harnais();
    await resolveur(appelQualif({ prenom: 'Yanis', campus: 'Bayonne', [PARAM_DEJA_DEMANDE]: true }));
    expect(journal).toEqual(['champ:prenom=Yanis', 'champ:campus=Bayonne', 'escalade']);
  });

  it('le bac à sable rend les mêmes questions, et ne passe la main à personne', async () => {
    const simulation = creerResolveurSimulation({ connaissance: { chercher: async () => [] } });
    expect((await simulation(appelQualif({ [PARAM_DEJA_DEMANDE]: false }))).contenu).toMatchObject({ a_demander: ['ton prénom', 'le campus'] });
    const r = await simulation(appelQualif({ prenom: 'Yanis', [PARAM_DEJA_DEMANDE]: true }));
    expect(r.contenu).toMatchObject({ simule: true, enregistrees: { prenom: 'Yanis' } });
    expect(r.rendu).toBeUndefined();
  });
});

describe('« Enregistrer une information » cite son champ (2026-10-20)', () => {
  it('🔴 le modèle lit le champ que l’outil remplit, et il suit la cible', () => {
    const ecrire = (champ: string): OutilDefini => ({
      ...outil([]), name: 'mba_ecrire_variable', binding: { handler: 'ecrire_variable', champ, valeurs: [] },
      params: [{ name: 'valeur', type: 'string', source: 'modele' }], risk: 'write',
    });
    expect(outilExpose(ecrire('campus'), [])?.description).toMatch(/le champ « campus » de la fiche du contact/);
    expect(outilExpose(ecrire('formation_souhaitee'), [])?.description).toMatch(/« formation_souhaitee »/);
  });
});
