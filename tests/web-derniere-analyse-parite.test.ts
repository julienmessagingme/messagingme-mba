import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ACTIONS, HANDLED_BY, INTENTS, SENTIMENTS } from '../src/analysis/schema';
import { FICHIERS_DOC } from '../web/lib/doc-api-pages';

/**
 * LA DERNIÈRE ANALYSE DANS LA DOC DE L'API (`lastAnalysis`, lot 4 de « tout sur la fiche »).
 *
 * Les codes sont un contrat : l'API les rend tels quels et l'outil du client les range. Une intention ajoutée au
 * serveur (il y en a eu trois le 2026-09-24) sans être citée ici arriverait chez un intégrateur qui ne la connaît pas.
 */
describe('la dernière analyse : parité serveur et documentation', () => {
  it('la documentation API cite chaque intention, sentiment, origine de traitement et action suggérée', () => {
    // Exactement une page, sinon ce test passerait à vide (aucune) ou n'en vérifierait qu'une moitié (deux).
    const pages = FICHIERS_DOC
      .map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'))
      .filter((texte) => texte.includes('data-testid="doc-last-analysis"'));
    expect(pages, 'la section lastAnalysis doit vivre dans exactement une page de la doc').toHaveLength(1);
    const page = pages[0]!;
    const debut = page.indexOf('data-testid="doc-last-analysis"');
    const section = page.slice(debut, page.indexOf('</p>', debut));
    for (const code of [...INTENTS, ...SENTIMENTS, ...HANDLED_BY, ...ACTIONS]) expect(section, code).toContain(`<C>${code}</C>`);
  });
});
