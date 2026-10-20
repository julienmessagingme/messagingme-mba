import { describe, it, expect } from 'vitest';
import { OUTILS, type DepsMcp } from '../src/mcp/outils';
import { RefusOutil } from '../src/mcp/saisie';
import { DROITS } from '../src/offres/offres';
import type { BulkEdits, BulkTarget } from '../src/crm/contact-store.pg';

/**
 * `tag_contacts` (plan « Campagnes depuis Claude », tâche 5) : un segment EST une étiquette. L'outil passe par l'action
 * en masse du mini-CRM (`applyEditsMany`), donc 🔴 sous le plafond des opérations coûteuses et sans aucune émission
 * d'événement d'automation (aucun chemin de masse n'émet). La cible est celle de `tests/mcp-campagnes-cible.test.ts`.
 */
const T = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const C1 = '11111111-1111-4111-8111-111111111111';
const CV1 = '33333333-3333-4333-8333-333333333333';
const PERSONNE = { userId: 'u1' };
const outil = OUTILS.find((o) => o.nom === 'tag_contacts')!;

function deps(o: { couteuxAccepte?: boolean } = {}) {
  const ordre: string[] = [];
  const ecrits: Array<{ tenant: string; cible: BulkTarget; edits: BulkEdits }> = [];
  const d = {
    offres: { offreDe: async () => ({ droits: { fonctions: DROITS.pro.fonctions } }) },
    inbox: { contactIdsDesConversations: async (t: string, ids: string[]) => { ordre.push('conversations'); return t === T && ids.includes(CV1) ? [C1] : []; } },
    couteux: { consommer: async () => { ordre.push('plafond'); return { accepte: o.couteuxAccepte ?? true, attenteMs: 2000 }; } },
    contacts: {
      applyEditsMany: async (tenant: string, cible: BulkTarget, edits: BulkEdits) => {
        ordre.push('ecriture'); ecrits.push({ tenant, cible, edits }); return { affected: 38, stopsGardes: 0 };
      },
    },
  } as unknown as DepsMcp;
  return { d, ordre, ecrits };
}

describe('tag_contacts', () => {
  it('🔴 une écriture de l’offre console, au nom d’une personne, qui fait demander l’accord', () => {
    expect(outil.fonction).toBe('console');
    expect(outil.scope).toBe('mcp:write');
    expect(outil.exigePersonne).toBe(true);
    expect(outil.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('étiquette les contacts d’une cible par l’action en masse, et rend leur nombre', async () => {
    const { d, ordre, ecrits } = deps();
    expect(await outil.executer(d, T, { add_tags: [' retard-livraison-oct ', 'retard-livraison-oct'], conversation_ids: [CV1] }, PERSONNE)).toEqual({ tagged: 38 });
    expect(ecrits).toEqual([{ tenant: T, cible: { ids: [C1] }, edits: { addTags: ['retard-livraison-oct'] } }]);
    expect(ordre).toEqual(['conversations', 'plafond', 'ecriture']);
  });

  it('🔴 le plafond des opérations coûteuses refuse : rien n’est écrit', async () => {
    const { d, ecrits } = deps({ couteuxAccepte: false });
    await expect(outil.executer(d, T, { add_tags: ['vip'], contact_ids: [C1] }, PERSONNE)).rejects.toThrow(RefusOutil);
    expect(ecrits).toHaveLength(0);
  });

  it('sans personne, sans étiquette, ou sans cible : refusé, rien n’est écrit ni compté', async () => {
    const { d, ordre } = deps();
    await expect(outil.executer(d, T, { add_tags: ['vip'], contact_ids: [C1] }, null)).rejects.toThrow(RefusOutil);
    await expect(outil.executer(d, T, { add_tags: ['  '], contact_ids: [C1] }, PERSONNE)).rejects.toThrow(RefusOutil);
    await expect(outil.executer(d, T, { contact_ids: [C1] }, PERSONNE)).rejects.toThrow(RefusOutil);
    await expect(outil.executer(d, T, { add_tags: ['vip'] }, PERSONNE)).rejects.toThrow(RefusOutil);
    expect(ordre).toEqual([]);
  });

  it('les étiquettes à poser ne sont pas des filtres : « tags » vise la cible, « add_tags » ce qu’on pose', async () => {
    const { d, ecrits } = deps();
    await outil.executer(d, T, { tags: ['chaud'], add_tags: ['relance-oct'] }, PERSONNE);
    expect(ecrits[0]).toMatchObject({ cible: { filters: { tags: ['chaud'] } }, edits: { addTags: ['relance-oct'] } });
  });
});
