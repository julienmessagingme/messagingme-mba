import { describe, it, expect } from 'vitest';
import { outilsAPublier, variablesMcp } from '../src/mba/outils-a-publier';
import { corpsOutilMeta } from '../src/mba/publication';
import type { Inappelable } from '../src/agent/catalog';

/**
 * Ce que chaque outil exposé à l'agent de Meta devient chez Meta (spec 2026-09-21-outils-maison-mba, § 8).
 * 🔴 CE QUE CE FICHIER PROTÈGE : qu'un outil qu'on ne sait pas lire ne parte PAS (publié, il serait appelé et
 * refusé à chaque fois), et que l'agent ne fournisse que ce que la cible lui laisse.
 */
const base = {
  description: 'Appelle cet outil dès que le client le demande.', nePasUtiliser: 'Jamais.', requestId: null,
  params: [] as unknown, inappelable: null as Inappelable | null,
};

describe('ce qui part chez Meta', () => {
  it('🔴 un champ maison part avec UNE variable `valeur`, requise, et ses valeurs permises dans la description', async () => {
    const [o] = await outilsAPublier(
      [{ ...base, id: 'o3', name: 'noter_ville', origin: 'mba', binding: { handler: 'champ_fixe', champ: 'ville', valeurs: ['Paris'] } }],
      async () => null,
    );
    const corps = corpsOutilMeta(o!);
    expect(corps.request_definition.path).toBe('/outils/o3');
    expect(corps.request_definition.body).toMatchObject({
      params: { valeur: { type: 'string', description: expect.stringContaining('Paris') } },
      required: ['valeur'],
    });
  });

  it('un tag maison part SANS corps : l’agent ne fournit rien', async () => {
    const [o] = await outilsAPublier(
      [{ ...base, id: 'o2', name: 'marquer_vip', origin: 'mba', binding: { handler: 'tag_fixe', tag: 'vip' } }],
      async () => null,
    );
    expect(corpsOutilMeta(o!).request_definition).not.toHaveProperty('body');
  });

  it('🔴 un outil maison illisible, une action d’agent IA, un outil INAPPELABLE ne partent PAS', async () => {
    // L'inappelabilité vient du catalogue (la règle unique du 2026-10-02) : la publication ne la recalcule pas, et
    // elle vaut pour un connecteur HTTP éteint comme pour un MCP mort.
    const lire = async () => ({ variables: [] });
    const r = await outilsAPublier([
      { ...base, id: 'a', name: 'casse', origin: 'mba', binding: { handler: 'tag_fixe' } },
      { ...base, id: 'b', name: 'mba_poser_tag', origin: 'mba', binding: { handler: 'poser_tag' } },
      { ...base, id: 'c', name: 'mcp_casse', origin: 'mcp', binding: {}, inappelable: { cause: 'non_activable', detail: 'schéma imbriqué' } },
      { ...base, id: 'd', name: 'mcp_parti', origin: 'mcp', binding: {}, inappelable: { cause: 'disparu' } },
      { ...base, id: 'e', name: 'mcp_eteint', origin: 'mcp', binding: {}, inappelable: { cause: 'source_inactive' } },
      { ...base, id: 'f', name: 'http_eteint', origin: 'http', requestId: 'rq1', binding: {}, inappelable: { cause: 'source_inactive' } },
    ], lire);
    expect(r).toEqual([]);
  });

  it('🔴 un outil MCP part (2026-10-02) avec ses SEULS paramètres remplis par le modèle', async () => {
    // L'e-mail cloué à la fiche du contact ne part pas chez Meta : notre relais le pose lui-même (garde d'identité).
    const params = [
      { name: 'question', type: 'string', source: 'modele', required: true, description: 'La question du client' },
      { name: 'email', type: 'string', source: 'champ', cle: 'email' },
      { name: 'langue', type: 'string', source: 'fixe', value: 'fr' },
    ];
    const [o] = await outilsAPublier([{ ...base, id: 'm1', name: 'notion_search', origin: 'mcp', binding: { outilDistant: 'search' }, params }], async () => null);
    expect(o?.variables).toEqual([
      { nom: 'question', type: 'string', origine: { type: 'modele' }, description: 'La question du client', requis: true },
    ]);
    expect(corpsOutilMeta(o!).request_definition.body).toMatchObject({ params: { question: expect.anything() }, required: ['question'] });
    expect(variablesMcp(params).map((v) => v.nom)).toEqual(['question']);
  });

  it('un outil MCP SANS description part avec une description de repli : Meta l’exige, un refus arrêterait tout', async () => {
    const mcp = { ...base, id: 'm1', name: 'notion_search', origin: 'mcp' as const, binding: { outilDistant: 'search' }, params: [] };
    const [vide] = await outilsAPublier([{ ...mcp, description: '   ' }], async () => null);
    expect(vide?.description).toBe('Outil notion_search.');
    const [ecrite] = await outilsAPublier([{ ...mcp, description: 'Cherche dans la base Notion.' }], async () => null);
    expect(ecrite?.description).toBe('Cherche dans la base Notion.');
  });

  it('un connecteur part avec les variables de sa requête, comme avant ; sans requête, il ne part pas', async () => {
    const lire = async (id: string) => (id === 'rq1' ? { variables: [{ nom: 'user', type: 'string' as const, origine: { type: 'modele' as const } }] } : null);
    const r = await outilsAPublier([
      { ...base, id: 'o1', name: 'add_tag', origin: 'http', requestId: 'rq1', binding: {} },
      { ...base, id: 'o9', name: 'appel_supprime', origin: 'http', requestId: 'rq9', binding: {} },
    ], lire);
    expect(r).toEqual([expect.objectContaining({ id: 'o1', variables: [expect.objectContaining({ nom: 'user' })] })]);
  });
});
