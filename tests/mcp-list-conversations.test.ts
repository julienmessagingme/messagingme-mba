import { describe, it, expect } from 'vitest';
import { OUTILS, type DepsMcp } from '../src/mcp/outils';
import { RefusOutil } from '../src/mcp/saisie';
import type { ConversationSummary, ListConversationsOptions } from '../src/inbox/store.pg';

/**
 * `list_conversations` ÉTENDU (plan « Campagnes depuis Claude », tâche 3) : pour désigner les contacts d'un thème,
 * l'assistant lit les conversations d'une période, page après page, et sait à quel contact chacune appartient. La
 * période et le curseur sont ceux du store : ce fichier tient ce que l'outil ajoute (lecture des dates, curseur opaque,
 * fin de liste dite).
 */
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const outil = OUTILS.find((o) => o.nom === 'list_conversations')!;
const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

function conv(id: string, curseur: string, urgente = false): ConversationSummary {
  return {
    id, waId: '33600000001', profileName: 'Léa', lastPreview: 'bonjour', lastMessageAt: curseur.slice(0, 23) + 'Z', curseur,
    controlOwner: 'app_workflow', unread: false, assignedTo: null, assignedToName: null, contactId: 'ct-1', urgente,
  };
}

function deps(page: ConversationSummary[]) {
  const recus: ListConversationsOptions[] = [];
  const d = {
    inbox: { listConversations: async (_t: string, o: ListConversationsOptions) => { recus.push(o); return page; } },
  } as unknown as DepsMcp;
  return { d, recus };
}

describe('list_conversations : période, curseur, contact', () => {
  it('rend l’identifiant du contact de chaque conversation', async () => {
    const { d } = deps([conv(ID1, '2026-10-19T09:00:00.123456Z')]);
    const r = (await outil.executer(d, T, {}, null)) as { conversations: Array<{ contact_id: string | null }> };
    expect(r.conversations[0]!.contact_id).toBe('ct-1');
  });

  it('since et until arrivent au store, en instants absolus', async () => {
    const { d, recus } = deps([]);
    await outil.executer(d, T, { since: '2026-10-13T00:00:00+02:00', until: '2026-10-20T00:00:00+02:00' }, null);
    expect(recus[0]).toMatchObject({ depuis: '2026-10-12T22:00:00.000Z', jusqua: '2026-10-19T22:00:00.000Z' });
  });

  it('🔴 une date sans fuseau est refusée : « lundi 10 h » ne veut rien dire sans savoir où', async () => {
    const { d, recus } = deps([]);
    await expect(outil.executer(d, T, { since: '2026-10-13T00:00:00' }, null)).rejects.toThrow(RefusOutil);
    await expect(outil.executer(d, T, { until: 'hier' }, null)).rejects.toThrow(RefusOutil);
    expect(recus).toHaveLength(0);
  });

  it('une page pleine rend next_cursor, et ce curseur ramène au point de reprise exact', async () => {
    const { d, recus } = deps([conv(ID1, '2026-10-19T09:00:00.123456Z'), conv(ID2, '2026-10-18T09:00:00.654321Z', true)]);
    const r = (await outil.executer(d, T, { limit: 2, a_traiter: true }, null)) as { next_cursor?: string };
    expect(typeof r.next_cursor).toBe('string');
    await outil.executer(d, T, { limit: 2, a_traiter: true, cursor: r.next_cursor }, null);
    expect(recus[1]!.before).toEqual({ at: '2026-10-18T09:00:00.654321Z', id: ID2, urgente: true });
  });

  it('une page incomplète dit la fin de la liste : pas de next_cursor', async () => {
    const { d } = deps([conv(ID1, '2026-10-19T09:00:00.123456Z')]);
    const r = (await outil.executer(d, T, { limit: 2 }, null)) as { next_cursor?: string };
    expect(r.next_cursor).toBeUndefined();
  });

  it('🔴 un curseur forgé est refusé avant toute lecture (il finirait en cast SQL)', async () => {
    const { d, recus } = deps([]);
    for (const c of ['nimporte', 'MjAyNi0xMC0xOA', Buffer.from('2026-10-18T09:00:00.654321Z|pas-un-uuid|0').toString('base64url')]) {
      await expect(outil.executer(d, T, { cursor: c }, null)).rejects.toThrow(RefusOutil);
    }
    expect(recus).toHaveLength(0);
  });
});
