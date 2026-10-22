import { describe, it, expect } from 'vitest';
import { OUTILS, RefusOutil, type DepsMcp } from '../src/mcp/outils';
import { parCause, type AuteurDuChangement } from '../src/inbox/evenements';
import type { ConversationMessage } from '../src/inbox/store.pg';

/**
 * `control_conversation` (plan `docs/superpowers/plans/2026-10-22-mcp-marche-arriere.md`, tâche 1) : prendre et rendre la
 * main sur un fil, les deux boutons du fil de la console, par le MÊME contrôle (`reprendreLaMain`, `rendreLaMain`). En Free,
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
  remise?: 'app_workflow' | 'mba' | 'aucun_numero' | Error;
  connue?: boolean;
} = {}) {
  const appels: Appel[] = [];
  const d = {
    inbox: {
      getConversationContext: async (id: string, tenantId: string) =>
        (o.connue ?? true) && id === CONV && tenantId === T ? { waId: WA, lastInboundAt: null, windowOpen: true } : null,
    },
    fil: {
      reprendreLaMain: async (tenantId: string, waId: string, par: AuteurDuChangement) => {
        appels.push({ geste: 'prendre', tenantId, waId, par });
        return o.prise ?? 'pris';
      },
      rendreLaMain: async (tenantId: string, waId: string, par: AuteurDuChangement) => {
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

  it('hand_back passe par rendreLaMain et rend qui tient le fil désormais', async () => {
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
