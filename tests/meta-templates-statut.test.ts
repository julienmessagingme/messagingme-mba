import { describe, it, expect } from 'vitest';
import { MetaTemplateClient, type FetchLike } from '../src/meta/templates';

/**
 * Le suivi de la validation d'un modèle (lot 13, domaine 3) : ce que Meta rend à la création (il peut RECLASSER la
 * catégorie) et le statut de chaque langue d'un nom, avec le motif d'un refus.
 */
function faux(reponses: unknown[]) {
  const appels: string[] = [];
  let i = 0;
  const fn: FetchLike = async (url) => {
    appels.push(url);
    const json = reponses[Math.min(i, reponses.length - 1)];
    i += 1;
    return { ok: true, status: 200, json: async () => json } as Response;
  };
  return { fn, appels };
}

describe('MetaTemplateClient : la catégorie et le statut', () => {
  it('🔴 la création rend la catégorie de Meta, qui peut différer de celle demandée', async () => {
    const { fn } = faux([{ id: 'tid', status: 'PENDING', category: 'MARKETING' }]);
    const r = await new MetaTemplateClient('tok', 'v23.0', fn).create('waba1', { name: 'n', category: 'UTILITY', language: 'fr', body: 'x' });
    expect(r).toEqual({ id: 'tid', status: 'PENDING', category: 'MARKETING' });
  });

  it('les statuts d’un nom : chaque langue, le motif d’un refus, NONE lu comme aucun motif ; un autre nom est écarté', async () => {
    const { fn, appels } = faux([{
      data: [
        { name: 'commande', language: 'fr', status: 'REJECTED', category: 'UTILITY', rejected_reason: 'INVALID_FORMAT', id: '1' },
        { name: 'commande', language: 'en_US', status: 'APPROVED', category: 'UTILITY', rejected_reason: 'NONE', id: '2' },
        { name: 'commande_v2', language: 'fr', status: 'APPROVED', category: 'UTILITY', id: '3' },
      ],
    }]);
    const r = await new MetaTemplateClient('tok', 'v23.0', fn).statutsDuNom('waba1', 'commande');
    expect(r).toEqual([
      { language: 'fr', status: 'REJECTED', category: 'UTILITY', rejectedReason: 'INVALID_FORMAT' },
      { language: 'en_US', status: 'APPROVED', category: 'UTILITY', rejectedReason: null },
    ]);
    expect(appels[0]).toMatch(/message_templates\?name=commande&fields=name%2Clanguage%2Cstatus%2Ccategory%2Crejected_reason/);
  });

  it('suit la pagination, et une entrée illisible est écartée plutôt que de tout faire échouer', async () => {
    const { fn, appels } = faux([
      { data: [{ name: 'c', language: 'fr', status: 'PENDING' }, { nom: 'illisible' }], paging: { next: 'https://graph.facebook.com/suite' } },
      { data: [{ name: 'c', language: 'de', status: 'APPROVED', category: 'MARKETING' }] },
    ]);
    const r = await new MetaTemplateClient('tok', 'v23.0', fn).statutsDuNom('waba1', 'c');
    expect(r.map((s) => s.language)).toEqual(['fr', 'de']);
    expect(r[0]).toEqual({ language: 'fr', status: 'PENDING', category: null, rejectedReason: null });
    expect(appels[1]).toBe('https://graph.facebook.com/suite');
  });
});
