import { describe, it, expect } from 'vitest';
import type { FicheConnaissance } from '../src/agent/knowledge';
import { importerLeSiteDeLEntretien, type DepsConnaissance } from '../src/agent/connaissance';
import { connaissanceInerte } from './routes-inertes';

/**
 * L'import du site donné pendant l'entretien de construction (décision de Julien, 2026-10-12) : quand le client ouvre
 * l'onglet Base de connaissance, les fiches de son site sont déjà là. Il passe par l'aperçu puis l'import de l'onglet,
 * donc par leurs gardes, et ne relit jamais un site déjà importé.
 */
const AG = '11111111-1111-4111-8111-111111111111';
const ACCUEIL = '<html><head><title>Accueil</title></head><body><h1>Bienvenue</h1>'
  + '<p>Nous accompagnons nos clients depuis 1970 dans toute la France, partout.</p>'
  + '<a href="/contrats">contrats</a><a href="https://autre.fr/x">tiers</a></body></html>';
const CONTRATS = '<html><head><title>Contrats</title></head><body><h1>La complémentaire santé</h1>'
  + '<p>Notre complémentaire santé rembourse les soins courants, l’optique et le dentaire.</p></body></html>';

function monter(dejaLa: FicheConnaissance[] = []) {
  const lues: string[] = [];
  const ecrites: string[] = [];
  const deps: DepsConnaissance = {
    ...connaissanceInerte,
    connaissance: {
      lister: async () => dejaLa,
      creer: async () => null,
      modifier: async () => null,
      supprimer: async () => false,
      remplacerSource: async (_t, agentId, source, fiches) => {
        ecrites.push(source.type === 'page' ? source.url : 'autre');
        return agentId === AG ? { retirees: 0, ecrites: fiches.length } : null;
      },
    },
    fetchUrl: async (u) => {
      lues.push(u);
      const html = ({ 'https://exemple.fr/': ACCUEIL, 'https://exemple.fr/contrats': CONTRATS } as Record<string, string>)[u];
      if (html === undefined) throw new Error('404');
      return { status: 200, contentType: 'text/html', body: html };
    },
  };
  return { deps, lues, ecrites };
}

const fiche = (sourceUrl: string | null): FicheConnaissance => ({
  id: 'f1', titre: 't', corps: 'c', source: sourceUrl ? { type: 'page', url: sourceUrl } : { type: 'manuel' },
  sourceUrl, derniereLectureAt: null, updatedAt: '2026-10-12T00:00:00.000Z',
});

describe('importerLeSiteDeLEntretien', () => {
  it('🔴 parcourt le site puis importe ses pages, par les fonctions de l’onglet', async () => {
    const { deps, ecrites } = monter();
    const r = await importerLeSiteDeLEntretien(deps, 't1', AG, 'https://exemple.fr/');
    expect(r).toMatchObject({ issue: 'importe', pages: 2 });
    // Les deux pages du site, jamais celle du tiers vers qui l'accueil pointe.
    expect(ecrites.sort()).toEqual(['https://exemple.fr/', 'https://exemple.fr/contrats']);
  });

  it('🔴 ne relit rien si une fiche vient déjà de ce site : un import manuel a pu être corrigé', async () => {
    const { deps, lues, ecrites } = monter([fiche('https://exemple.fr/contrats')]);
    expect(await importerLeSiteDeLEntretien(deps, 't1', AG, 'https://exemple.fr/')).toEqual({ issue: 'deja_la' });
    expect(lues).toEqual([]);
    expect(ecrites).toEqual([]);
  });

  it('des fiches écrites à la main, ou venues d’un autre site, n’empêchent pas l’import', async () => {
    const { deps } = monter([fiche(null), fiche('https://ailleurs.fr/page')]);
    expect((await importerLeSiteDeLEntretien(deps, 't1', AG, 'https://exemple.fr/')).issue).toBe('importe');
  });

  it('une adresse refusée par les gardes de l’onglet est refusée ici aussi, sans rien écrire', async () => {
    const { deps, ecrites } = monter();
    const r = await importerLeSiteDeLEntretien(deps, 't1', AG, 'http://127.0.0.1/');
    expect(r.issue).toBe('refuse');
    expect(ecrites).toEqual([]);
  });
});
