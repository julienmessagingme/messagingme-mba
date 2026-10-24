import { describe, it, expect } from 'vitest';
import { OUTILS, RefusOutil, type DepsMcp } from '../src/mcp/outils';
import { parCause, type AuteurDuChangement } from '../src/inbox/evenements';
import type { ConversationMessage } from '../src/inbox/store.pg';
import { bancDuFil } from './banc-du-fil';

/**
 * `control_conversation` (plan `docs/superpowers/plans/2026-10-22-mcp-marche-arriere.md`, tâche 1) : prendre et rendre la
 * main sur un fil, les deux boutons du fil de la console, par le MÊME contrôle (`reprendreLaMain`, et
 * `rendreLaMainSousConsentement`, le rendu avec la garde STOP ou bloqué). En Free,
 * sans Inbox, c'est le seul chemin pour qu'un agent IA réponde de nouveau après une réponse de Claude. Ce fichier tient ce
 * que l'outil ajoute : la garde d'espace, l'auteur du geste, et des refus lisibles là où la console rend un 409.
 */
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const CONV = '11111111-1111-4111-8111-111111111111';
const WA = '33612345678';
const outil = OUTILS.find((o) => o.nom === 'control_conversation')!;
const MOI = { userId: '99999999-9999-4999-8999-999999999999' };

type Appel = { geste: 'prendre' | 'rendre'; tenantId: string; waId: string; par: AuteurDuChangement };

function deps(o: {
  prise?: 'pris' | 'refuse';
  remise?: 'app_workflow' | 'mba' | 'aucun_numero' | 'contact_muet' | Error;
  connue?: boolean;
  /** Le contact a dit STOP, ou il est bloqué. */
  desabonne?: boolean;
  bloque?: boolean;
  /** Le mode du répondeur (un agent IA par défaut), l'agent de Meta allumé ou non, et les fonctions de l'offre. */
  mode?: string;
  mbaAllume?: boolean;
  fonctions?: string[];
} = {}) {
  const appels: Appel[] = [];
  const d = {
    estDesabonne: async (t: string, waId: string) => t === T && waId === WA && o.desabonne === true,
    contacts: { isBlockedByWaId: async (t: string, waId: string) => t === T && waId === WA && o.bloque === true },
    agentIa: {
      repondeur: {
        reglages: {
          get: async () => ({
            repondeurMode: o.mode ?? 'agent', mbaEnabled: o.mbaAllume ?? true, repondeurAgentId: 'agent-1',
            repondeurWorkflowId: 'scenario-1', repondeurAdresseId: 'adresse-1', repondeurDelaiScenarioS: 86_400,
          }),
        },
      },
    },
    offres: { offreDe: async () => ({ droits: { fonctions: new Set(o.fonctions ?? ['inbox', 'scenarios', 'agent_meta']) } }) },
    inbox: {
      getConversationContext: async (id: string, tenantId: string) =>
        (o.connue ?? true) && id === CONV && tenantId === T ? { waId: WA, lastInboundAt: null, windowOpen: true } : null,
    },
    fil: {
      reprendreLaMain: async (tenantId: string, waId: string, par: AuteurDuChangement) => {
        appels.push({ geste: 'prendre', tenantId, waId, par });
        return o.prise ?? 'pris';
      },
      rendreLaMainSousConsentement: async (tenantId: string, waId: string, par: AuteurDuChangement) => {
        appels.push({ geste: 'rendre', tenantId, waId, par });
        if (o.remise instanceof Error) throw o.remise;
        return o.remise ?? 'app_workflow';
      },
    },
  } as unknown as DepsMcp;
  return { d, appels };
}

describe('control_conversation : prendre et rendre la main sur un fil', () => {
  it('existe, dans toutes les offres, en écriture, sans exiger de personne (comme reply_in_open_window)', () => {
    expect(outil).toBeDefined();
    expect(outil.fonction).toBeNull();
    expect(outil.scope).toBe('mcp:write');
    expect(outil.exigePersonne).toBeUndefined();
  });

  it('take_over passe par reprendreLaMain, au nom de la personne connectée, et dit que l’équipe tient le fil', async () => {
    const { d, appels } = deps();
    const r = await outil.executer(d, T, { conversation_id: CONV, action: 'take_over' }, MOI);
    expect(appels).toEqual([{ geste: 'prendre', tenantId: T, waId: WA, par: { collaborateur: MOI.userId } }]);
    expect(r).toEqual({ conversation_id: CONV, handled_by: 'app_human' });
  });

  it('hand_back passe par rendreLaMainSousConsentement (jamais le geste sans garde de la console) et rend qui tient le fil', async () => {
    const { d, appels } = deps({ remise: 'mba' });
    const r = await outil.executer(d, T, { conversation_id: CONV, action: 'hand_back' }, MOI);
    expect(appels).toEqual([{ geste: 'rendre', tenantId: T, waId: WA, par: { collaborateur: MOI.userId } }]);
    expect(r).toEqual({ conversation_id: CONV, handled_by: 'mba' });
  });

  it('derrière une clé d’API, le geste est signé « agent tiers (MCP) », comme assign_conversation', async () => {
    const { d, appels } = deps();
    await outil.executer(d, T, { conversation_id: CONV, action: 'hand_back' }, null);
    expect(appels[0]!.par).toEqual(parCause('agent tiers (MCP)'));
  });

  it('🔴 un refus de Meta à la prise est un refus lisible, pas une panne', async () => {
    const { d } = deps({ prise: 'refuse' });
    await expect(outil.executer(d, T, { conversation_id: CONV, action: 'take_over' }, MOI)).rejects.toThrow(RefusOutil);
  });

  it('🔴 une remise sans numéro connecté, ou que Meta refuse, est un refus lisible : la conversation reste à l’équipe', async () => {
    for (const remise of ['aucun_numero' as const, new Error('Meta a refusé l’ajout à la liste')]) {
      const { d } = deps({ remise });
      await expect(outil.executer(d, T, { conversation_id: CONV, action: 'hand_back' }, MOI)).rejects.toThrow(RefusOutil);
    }
  });

  it('🔴 hand_back ne rend pas la main sur un contact qui a dit STOP, ni sur un contact bloqué : aucun geste, un refus qui le dit', async () => {
    // « Rendre la main » de la console confie à l'agent de Meta sans la garde du consentement : l'outil la pose.
    for (const cas of [{ desabonne: true, motif: /STOP/ }, { bloque: true, motif: /bloqué/ }]) {
      for (const personne of [MOI, null]) {
        const { d, appels } = deps(cas);
        await expect(outil.executer(d, T, { conversation_id: CONV, action: 'hand_back' }, personne)).rejects.toThrow(cas.motif);
        expect(appels).toHaveLength(0);
      }
    }
  });

  it('🔴 en mode « équipe », hand_back se fait pour un contact STOP ou bloqué, et le résultat le dit (lot 4)', async () => {
    // Aucun robot à qui le rendre : le geste sort la conversation d'« À traiter », seul moyen d'une Free (décision de
    // Julien du 2026-10-23). La garde à l'envoi (STOP ou bloqué) tient les robots, quel que soit le répondeur.
    for (const cas of [{ desabonne: true, motif: /a dit STOP/ }, { bloque: true, motif: /est bloqué/ }]) {
      for (const personne of [MOI, null]) {
        const { d, appels } = deps({ ...cas, mode: 'equipe' });
        const r = await outil.executer(d, T, { conversation_id: CONV, action: 'hand_back' }, personne) as { repondeur?: string; a_savoir?: string };
        expect(appels.map((a) => a.geste)).toEqual(['rendre']);
        expect(r.repondeur).toBe('equipe');
        expect(r.a_savoir).toMatch(cas.motif);
        // La console peut encore le confier à la main : la phrase ne promet que l'absence de robot DE LUI-MÊME (lot 5).
        expect(r.a_savoir).toMatch(/aucun scénario ni agent IA ne lui écrit de lui-même/);
      }
    }
    // Un contact ni STOP ni bloqué : la phrase n'en dit rien.
    const { d } = deps({ mode: 'equipe' });
    const r = await outil.executer(d, T, { conversation_id: CONV, action: 'hand_back' }, MOI) as { a_savoir?: string };
    expect(r.a_savoir).not.toMatch(/STOP|bloqué/);
  });

  it('🔴 sur le VRAI contrôle du fil : l’outil lit « équipe », le fil relit `mba`, un contact STOP ou bloqué n’est pas confié (lot 6)', async () => {
    for (const cas of [{ desabonne: true, banc: { desabonnes: [WA] } }, { bloque: true, banc: { bloques: [WA] } }]) {
      const banc = bancDuFil({ ...cas.banc, mode: 'mba', mbaEnabled: true, conversations: { [WA]: { owner: 'app_human', changedAt: null } } });
      const { d } = deps({ ...cas, mode: 'equipe' });
      const reel = { ...d, fil: banc.fil } as DepsMcp;
      await expect(outil.executer(reel, T, { conversation_id: CONV, action: 'hand_back' }, null)).rejects.toThrow(/n’est confiée à aucun robot/);
      expect(banc.appels, 'ni liste, ni release chez Meta').toEqual([]);
      expect(banc.etat(WA)?.owner, 'rien n’est écrit').toBe('app_human');
    }
  });

  it('la course inverse : l’outil lit « équipe », le fil confie à l’agent de Meta un contact libre ; aucune phrase « équipe » (lot 6)', async () => {
    const { d } = deps({ mode: 'equipe', remise: 'mba' });
    expect(await outil.executer(d, T, { conversation_id: CONV, action: 'hand_back' }, MOI)).toEqual({ conversation_id: CONV, handled_by: 'mba' });
  });

  it('🔴 si le fil refuse de confier le contact à l’agent de Meta (STOP ou bloqué, mode passé à `mba` entre-temps), un refus qui le dit (lot 5)', async () => {
    // L'outil a lu « équipe », le fil relit `mba` : sa garde du consentement joue, rien n'est écrit.
    for (const personne of [MOI, null]) {
      const { d, appels } = deps({ desabonne: true, mode: 'equipe', remise: 'contact_muet' });
      await expect(outil.executer(d, T, { conversation_id: CONV, action: 'hand_back' }, personne)).rejects.toThrow(/n’est confiée à aucun robot/);
      expect(appels.map((a) => a.geste)).toEqual(['rendre']);
    }
  });

  it('take_over reste ouvert sur ce contact : prendre le fil n’écrit rien', async () => {
    const { d, appels } = deps({ desabonne: true, bloque: true });
    expect(await outil.executer(d, T, { conversation_id: CONV, action: 'take_over' }, MOI)).toEqual({ conversation_id: CONV, handled_by: 'app_human' });
    expect(appels.map((a) => a.geste)).toEqual(['prendre']);
  });

  it('🔴 hand_back sans répondeur automatique (mode « équipe », ou un répondeur que l’offre éteint) se fait, et le résultat dit qu’aucun robot ne répondra', async () => {
    // Le geste sort la conversation d'« À traiter » et rend un parcours qui attendait le contact (lot 3) : le refuser en
    // mode « équipe » privait une Free de son seul moyen de le faire. Il ne promet plus pour autant une réponse automatique.
    const sansRobot = [
      { mode: 'equipe' },
      // Un scénario hors de l'offre se lit « équipe » (`sousLOffre`), comme le contrôle du fil le lit.
      { mode: 'scenario', fonctions: ['inbox'] },
      { mode: 'mba', mbaAllume: false },
    ];
    for (const o of sansRobot) {
      const { d, appels } = deps(o);
      const r = await outil.executer(d, T, { conversation_id: CONV, action: 'hand_back' }, MOI) as { repondeur?: string; a_savoir?: string };
      expect(appels.map((a) => a.geste), o.mode).toEqual(['rendre']);
      expect(r.repondeur, o.mode).toBe('equipe');
      expect(r.a_savoir, o.mode).toMatch(/set_default_responder/);
      // `set_default_responder` exige une personne : derrière une clé d'API, la phrase ne promet pas un geste impossible.
      expect(r.a_savoir, o.mode).toMatch(/Une personne connectée choisit qui répond/);
    }
    for (const mode of ['agent', 'scenario', 'mba', 'application']) {
      const { d, appels } = deps({ mode });
      const r = await outil.executer(d, T, { conversation_id: CONV, action: 'hand_back' }, MOI);
      expect(appels.map((a) => a.geste), mode).toEqual(['rendre']);
      expect(r, mode).not.toHaveProperty('repondeur');
    }
  });

  it('🔴 une conversation d’un autre espace est refusée comme une inconnue, sans aucun geste', async () => {
    const { d, appels } = deps({ connue: false });
    await expect(outil.executer(d, T, { conversation_id: CONV, action: 'hand_back' }, MOI)).rejects.toThrow('conversation inconnue');
    expect(appels).toHaveLength(0);
  });

  it('une action inconnue ou absente est refusée avant toute lecture', async () => {
    for (const action of ['release', undefined, '']) {
      const { d, appels } = deps();
      await expect(outil.executer(d, T, { conversation_id: CONV, action }, MOI)).rejects.toThrow(RefusOutil);
      expect(appels).toHaveLength(0);
    }
  });
});

describe('get_messages : l’identifiant de chaque message', () => {
  const lecture = OUTILS.find((o) => o.nom === 'get_messages')!;

  function message(id: string, metaMessageId: string | null): ConversationMessage {
    return { id, direction: 'out', type: 'text', body: 'bonjour', buttonPayload: null, createdAt: '2026-10-22T09:00:00.000Z', metaMessageId };
  }

  it('rend l’identifiant public : celui de Meta, sinon le nôtre préfixé, comme GET /v1/messages/{id}', async () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const d = {
      inbox: {
        getConversationContext: async () => ({ waId: WA, lastInboundAt: null, windowOpen: true }),
        getDerniersMessages: async () => [message(id, 'wamid.HBgL'), message(id, null)],
      },
    } as unknown as DepsMcp;
    const r = (await lecture.executer(d, T, { conversation_id: CONV }, null)) as { messages: Array<{ message_id: string }> };
    expect(r.messages.map((m) => m.message_id)).toEqual(['wamid.HBgL', `msg_${id}`]);
  });
});
