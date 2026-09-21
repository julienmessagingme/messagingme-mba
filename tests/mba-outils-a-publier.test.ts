import { describe, it, expect } from 'vitest';
import { outilsAPublier } from '../src/mba/outils-a-publier';
import { corpsOutilMeta } from '../src/mba/publication';

/**
 * Ce que chaque outil exposé à l'agent de Meta devient chez Meta (spec 2026-09-21-outils-maison-mba, § 8).
 * 🔴 CE QUE CE FICHIER PROTÈGE : qu'un outil qu'on ne sait pas lire ne parte PAS (publié, il serait appelé et
 * refusé à chaque fois), et que l'agent ne fournisse que ce que la cible lui laisse.
 */
const base = { description: 'Appelle cet outil dès que le client le demande.', nePasUtiliser: 'Jamais.', requestId: null };

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

  it('🔴 un outil maison illisible, une action d’agent IA ou un MCP ne partent PAS', async () => {
    const r = await outilsAPublier([
      { ...base, id: 'a', name: 'casse', origin: 'mba', binding: { handler: 'tag_fixe' } },
      { ...base, id: 'b', name: 'mba_poser_tag', origin: 'mba', binding: { handler: 'poser_tag' } },
      { ...base, id: 'c', name: 'mcp', origin: 'mcp', binding: {} },
    ], async () => null);
    expect(r).toEqual([]);
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
