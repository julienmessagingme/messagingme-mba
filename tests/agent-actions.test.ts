import { describe, it, expect } from 'vitest';
import {
  BORNES_ACTION, lireCibleOutilAgent, outilExpose, outilMaison, paramsEffectifs, HANDLERS_A_CIBLE,
} from '../src/agent/outils-maison';
import {
  declencherAction, idEvenementAction, valeursDesChamps, type DepsDeclencherAction,
} from '../src/agent/actions';
import { creerResolveurMba, type DepsResolveurMba } from '../src/agent/resolvers/mba';
import { creerResolveurSimulation } from '../src/agent/resolvers/simulation';
import { ajouterOutilMaison } from '../src/agent/reglages';
import type { OutilDefini } from '../src/agent/catalog';

/**
 * LES ACTIONS DE L'AGENT IA (plan docs/superpowers/plans/2026-10-13-actions-agent.md). Un outil maison,
 * `declencher_action`, dont la cible porte l'action (nom, consigne, champs typés tous facultatifs). Au déclenchement :
 * une ligne du jour réservée (une fois par jour, par contact et par action), le webhook `agent.action`, la frise,
 * l'automation ; et le tour CONTINUE.
 */
const ACTION = {
  handler: 'declencher_action',
  nom: 'résiliation',
  consigne: 'Quand le client veut résilier. Dis-lui que la demande est enregistrée et confirmée par e-mail sous 48 h.',
  champs: [
    { code: 'contrat', libelle: 'Numéro de contrat', type: 'texte' },
    { code: 'mois', libelle: 'Mois restants', type: 'nombre' },
    { code: 'date_souhaitee', libelle: 'Date souhaitée', type: 'date' },
    { code: 'email', libelle: 'E-mail de confirmation', type: 'email' },
    { code: 'motif', libelle: 'Motif', type: 'liste', valeurs: ['déménagement', 'prix', 'autre'] },
  ],
};

function outil(binding: Record<string, unknown>, id = '0b7e2c1a-4d5e-4f60-8a9b-1c2d3e4f5a6b'): OutilDefini {
  return {
    id, origin: 'mba', name: 'action_resiliation', title: 'Déclencher une action', description: 'Déclenche une action.',
    nePasUtiliser: '', params: [], binding, risk: 'write', actif: true, autonome: false,
  } as unknown as OutilDefini;
}
const CTX = {
  tenantId: 't1', agentId: 'ag1', sessionId: 's1', runId: 'r1', workflowId: 'wf1', waId: '33612345678', contact: null,
  contactInconnu: 'tous', appelsRestants: 5, budgetRestantMicroEur: 10_000, deadline: Date.now() + 30_000,
} as const;

describe('l’outil « déclencher une action »', () => {
  it('🔴 au catalogue : une écriture, sans paramètre fixe (ils viennent de l’action), avec une cible', () => {
    const m = outilMaison('declencher_action');
    expect(m?.risk).toBe('write');
    expect(m?.params).toEqual([]);
    expect(HANDLERS_A_CIBLE).toContain('declencher_action');
  });

  it('🔴 la cible : un nom, une consigne, des champs typés ; tout écart est refusé', () => {
    expect(lireCibleOutilAgent(ACTION)).toEqual(ACTION);
    expect(lireCibleOutilAgent({ ...ACTION, nom: '' })).toBeNull();
    expect(lireCibleOutilAgent({ ...ACTION, intrus: 1 })).toBeNull();
    // Une liste sans valeurs, des valeurs hors d'une liste, un code qui n'est pas un identifiant, deux fois le même code.
    expect(lireCibleOutilAgent({ ...ACTION, champs: [{ code: 'motif', libelle: 'Motif', type: 'liste' }] })).toBeNull();
    expect(lireCibleOutilAgent({ ...ACTION, champs: [{ code: 'contrat', libelle: 'Contrat', type: 'texte', valeurs: ['a'] }] })).toBeNull();
    expect(lireCibleOutilAgent({ ...ACTION, champs: [{ code: 'Numéro', libelle: 'N', type: 'texte' }] })).toBeNull();
    expect(lireCibleOutilAgent({ ...ACTION, champs: [ACTION.champs[0], ACTION.champs[0]] })).toBeNull();
    const trop = Array.from({ length: BORNES_ACTION.champs + 1 }, (_, i) => ({ code: `c${i}`, libelle: `C${i}`, type: 'texte' }));
    expect(lireCibleOutilAgent({ ...ACTION, champs: trop })).toBeNull();
    // Aucun champ : une action sans information à recueillir reste permise (« rappelez-moi »).
    expect(lireCibleOutilAgent({ ...ACTION, champs: [] })).not.toBeNull();
  });

  it('🔴 le modèle voit un paramètre facultatif par champ : nombre en nombre, liste en énumération, format dit', () => {
    const params = paramsEffectifs(outil(ACTION));
    expect(params.map((p) => p.name)).toEqual(['contrat', 'mois', 'date_souhaitee', 'email', 'motif']);
    expect(params.every((p) => p.required === false && p.source === 'modele')).toBe(true);
    expect(params.find((p) => p.name === 'mois')?.type).toBe('number');
    expect(params.find((p) => p.name === 'motif')?.enum).toEqual(['déménagement', 'prix', 'autre']);
    expect(params.find((p) => p.name === 'date_souhaitee')?.description).toMatch(/AAAA-MM-JJ/);
    // La consigne et le nom de l'action sont dits au modèle avec l'outil.
    const expose = outilExpose(outil(ACTION), []);
    expect(expose?.description).toContain('résiliation');
    expect(expose?.description).toContain('confirmée par e-mail sous 48 h');
    expect(expose?.parameters.required).toEqual([]);
  });

  it('les valeurs : ce que le contact n’a pas donné est absent ; une date ou un e-mail mal formés sont refusés lisiblement', () => {
    expect(valeursDesChamps(ACTION.champs as never, { contrat: ' 12345 ', mois: 3, motif: 'prix', email: null })).toEqual({
      ok: true, valeurs: { contrat: '12345', mois: 3, motif: 'prix' },
    });
    const date = valeursDesChamps(ACTION.champs as never, { date_souhaitee: '31/10/2026' });
    expect(date.ok).toBe(false);
    expect(date.ok === false && date.erreur).toMatch(/Date souhaitée.*AAAA-MM-JJ/);
    expect(valeursDesChamps(ACTION.champs as never, { date_souhaitee: '2026-02-30' }).ok).toBe(false);
    expect(valeursDesChamps(ACTION.champs as never, { email: 'pas-un-email' }).ok).toBe(false);
    // Un texte au-delà de la borne annoncée est rendu au modèle ; un code qui est aussi un nom du prototype ne lit rien.
    expect(valeursDesChamps(ACTION.champs as never, { contrat: 'x'.repeat(BORNES_ACTION.texte + 1) }).ok).toBe(false);
    expect(valeursDesChamps([{ code: 'constructor', libelle: 'C', type: 'texte' }] as never, {})).toEqual({ ok: true, valeurs: {} });
    expect(valeursDesChamps(ACTION.champs as never, { date_souhaitee: '2026-10-31', email: 'a@b.fr' })).toEqual({
      ok: true, valeurs: { date_souhaitee: '2026-10-31', email: 'a@b.fr' },
    });
  });
});

describe('le handler de production', () => {
  function monter(issue: 'declenchee' | 'deja' | 'aucune_conversation' = 'declenchee') {
    const appels: unknown[] = [];
    const deps = { declencherAction: async (i: unknown) => { appels.push(i); return issue; } } as unknown as DepsResolveurMba;
    return { resolveur: creerResolveurMba(deps), appels };
  }
  const entree = (args: Record<string, unknown>) => ({ outil: outil(ACTION), args, ctx: CTX, signal: new AbortController().signal });

  it('🔴 déclenche avec ce que le modèle a recueilli, rend la consigne, et le tour CONTINUE', async () => {
    const { resolveur, appels } = monter();
    const r = await resolveur(entree({ contrat: '12345', motif: 'prix' }) as never);
    expect(appels).toEqual([{
      tenantId: 't1', waId: '33612345678', agentId: 'ag1', actionId: '0b7e2c1a-4d5e-4f60-8a9b-1c2d3e4f5a6b', nom: 'résiliation',
      champs: { contrat: '12345', motif: 'prix' },
    }]);
    expect(r.ok).not.toBe(false);
    expect(r.contenu).toMatchObject({ declenchee: true });
    expect(JSON.stringify(r.contenu)).toContain('confirmée par e-mail sous 48 h');
    for (const arret of ['rendu', 'sortie', 'scenarioLance', 'fatal']) expect(r).not.toHaveProperty(arret);
  });

  it('🔴 déjà déclenchée aujourd’hui : le modèle le lit, et ne la refait pas', async () => {
    const r = await monter('deja').resolveur(entree({}) as never);
    expect(r.ok).not.toBe(false);
    expect(r.contenu).toMatchObject({ deja_declenchee_aujourdhui: true });
  });

  it('une date mal formée n’atteint pas la dépendance : le modèle lit pourquoi', async () => {
    const { resolveur, appels } = monter();
    const r = await resolveur(entree({ date_souhaitee: 'demain' }) as never);
    expect(r.ok).toBe(false);
    expect(appels).toEqual([]);
  });

  it('🔴 le bac à sable SIMULE : aucune action ne part, l’agent continue', async () => {
    const simulation = creerResolveurSimulation({ connaissance: { chercher: async () => [] } });
    const r = await simulation(entree({ contrat: '1' }) as never);
    expect(r.ok).not.toBe(false);
    expect(r.contenu).toMatchObject({ simule: true });
    expect(r).not.toHaveProperty('rendu');
  });
});

describe('le déclenchement : une fois par jour, et rien de perdu', () => {
  function deps(o: { deja?: boolean; conversation?: string | null; distribuerLeve?: boolean } = {}) {
    const journal: string[] = [];
    const d: DepsDeclencherAction = {
      conversationId: async () => (o.conversation === undefined ? 'conv-1' : o.conversation),
      fuseau: async () => 'Europe/Paris',
      reserver: async (l) => { journal.push(`reserver:${l.jour}:${JSON.stringify(l.champs)}`); return o.deja ? null : 'res-1'; },
      annuler: async (_t, id) => { journal.push(`annuler:${id}`); },
      fiche: async () => ({ id: 'c1', phone: '+33612345678', name: 'Camille', external_id: null, opted_out: { whatsapp: false, rcs: false } }),
      distribuer: async (_t, ev) => {
        if (o.distribuerLeve) throw new Error('base indisponible');
        journal.push(`webhook:${ev.id}:${ev.type}:${ev.contactId}`);
        return 1;
      },
      noterFrise: async (_t, conv, a) => { journal.push(`frise:${conv}:${a.agentId}:${a.nom}`); },
      publierAutomation: async (ev) => { journal.push(`automation:${ev.kind}:${ev.actionId}`); },
      maintenant: () => new Date('2026-10-13T22:30:00.000Z'),
    };
    return { d, journal };
  }
  const INPUT = { tenantId: 't1', waId: '33612345678', agentId: 'ag1', actionId: 'tool-1', nom: 'résiliation', champs: { contrat: '12345' } };

  it('🔴 réserve le jour DANS LE FUSEAU de l’espace, puis webhook, frise et automation', async () => {
    const { d, journal } = deps();
    expect(await declencherAction(d, INPUT)).toBe('declenchee');
    // 22 h 30 UTC le 13 = 0 h 30 le 14 à Paris : c'est le 14 qui compte.
    expect(journal[0]).toBe('reserver:2026-10-14:{"contrat":"12345"}');
    expect(journal[1]).toBe(`webhook:${idEvenementAction({ actionId: 'tool-1', waId: '33612345678', jour: '2026-10-14' })}:agent.action:c1`);
    expect(journal[2]).toBe('frise:conv-1:ag1:résiliation');
    expect(journal[3]).toBe('automation:agent_action:tool-1');
  });

  it('🔴 déjà réservée aujourd’hui : le webhook est REJOUÉ sous le MÊME identifiant (idempotent), ni frise ni automation', async () => {
    const { d, journal } = deps({ deja: true });
    expect(await declencherAction(d, INPUT)).toBe('deja');
    const id = idEvenementAction({ actionId: 'tool-1', waId: '33612345678', jour: '2026-10-14' });
    expect(journal).toEqual(['reserver:2026-10-14:{"contrat":"12345"}', `webhook:${id}:agent.action:c1`]);
  });

  it('déjà réservée et le rejeu échoue : rien ne remonte, l’issue reste « déjà partie »', async () => {
    const { d } = deps({ deja: true, distribuerLeve: true });
    expect(await declencherAction(d, INPUT)).toBe('deja');
  });

  it('🔴 le webhook n’a pas pu s’écrire : la réservation est rendue, pour que le modèle puisse réessayer', async () => {
    const { d, journal } = deps({ distribuerLeve: true });
    await expect(declencherAction(d, INPUT)).rejects.toThrow('base indisponible');
    expect(journal).toContain('annuler:res-1');
  });

  it('sans conversation pour ce contact : rien n’est réservé', async () => {
    const { d, journal } = deps({ conversation: null });
    expect(await declencherAction(d, INPUT)).toBe('aucune_conversation');
    expect(journal).toEqual([]);
  });

  it('🔴 l’identifiant de l’événement vient de la clé naturelle : le même pour l’action, le contact et le jour', () => {
    const cle = { actionId: 'tool-1', waId: '33612345678', jour: '2026-10-14' };
    expect(idEvenementAction(cle)).toBe(idEvenementAction({ ...cle }));
    expect(idEvenementAction(cle)).not.toBe(idEvenementAction({ ...cle, jour: '2026-10-15' }));
    expect(idEvenementAction(cle)).not.toBe(idEvenementAction({ ...cle, waId: '33600000000' }));
    expect(idEvenementAction(cle)).not.toBe(idEvenementAction({ ...cle, actionId: 'tool-2' }));
    expect(idEvenementAction(cle)).toMatch(/^evt_[0-9a-f]{32}$/);
    // Opaque : le numéro du contact ne s'y lit pas.
    expect(idEvenementAction(cle)).not.toContain('33612345678');
  });
});

describe('au plus 10 actions par agent', () => {
  it('🔴 la onzième est refusée ; un autre outil maison n’est pas compté', async () => {
    const existants = Array.from({ length: BORNES_ACTION.parAgent }, (_, i) => ({ id: `t${i}`, origin: 'mba', binding: { handler: 'declencher_action' } }));
    const ajoutes: unknown[] = [];
    const outils = {
      listToutes: async () => existants as never,
      ajouter: async (_t: string, _a: string, o: unknown) => { ajoutes.push(o); return { id: 'neuf' } as never; },
    };
    const refuse = await ajouterOutilMaison(outils, 't1', 'ag1', 'declencher_action', 'action_onze', { ...ACTION, handler: undefined });
    expect(refuse.ok).toBe(false);
    expect(ajoutes).toEqual([]);
    const tag = await ajouterOutilMaison(outils, 't1', 'ag1', 'poser_tag', undefined, { tag: 'vip' });
    expect(tag.ok).toBe(true);
  });
});
