import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { NIVEAUX_RISQUE, RAISONS_RISQUE } from '../src/engagement/risque';
import {
  BADGE_NIVEAU_RISQUE, LIBELLES_RAISON_RISQUE, NIVEAUX_DU_FILTRE, NIVEAUX_RISQUE as NIVEAUX_CONSOLE,
} from '../web/lib/risque';
import { FICHIERS_DOC } from '../web/lib/doc-api-pages';

/**
 * LE RISQUE DE DÉSENGAGEMENT, DES DEUX CÔTÉS (lot 7 de l'API publique, spec § 19).
 *
 * 🔴 LES CODES SONT UN CONTRAT : le serveur les écrit en base, l'API publique et l'outil du client les lisent tels
 * quels, et la console les traduit. Un code ajouté au serveur sans libellé s'afficherait brut sur la fiche ; un
 * libellé sans code serait un reste. Les deux sens sont vérifiés, sur les niveaux comme sur les raisons, et pour
 * le filtre : un niveau proposé à l'écran que le serveur ne connaît pas serait REFUSÉ en 400 à chaque clic.
 */
const trie = (l: readonly string[]): string[] => [...l].sort();

describe('le risque : parité serveur et console', () => {
  it('🔴 les codes de raisons de la console sont EXACTEMENT ceux du serveur', () => {
    expect(trie(Object.keys(LIBELLES_RAISON_RISQUE))).toEqual(trie(RAISONS_RISQUE));
  });

  it('🔴 les niveaux de la console, ses badges et son filtre sont EXACTEMENT ceux du serveur', () => {
    expect(trie(NIVEAUX_CONSOLE)).toEqual(trie(NIVEAUX_RISQUE));
    expect(trie(Object.keys(BADGE_NIVEAU_RISQUE))).toEqual(trie(NIVEAUX_RISQUE));
    expect(trie(NIVEAUX_DU_FILTRE)).toEqual(trie(NIVEAUX_RISQUE));
  });

  it('la documentation API cite chaque niveau et chaque code de raison', () => {
    // La section vit dans UNE page de la doc (liste fermée, `web/lib/doc-api-pages.ts`) : exactement une, sinon
    // ce test passerait à vide (aucune) ou n'en vérifierait qu'une moitié (deux).
    const pages = FICHIERS_DOC
      .map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'))
      .filter((texte) => texte.includes('data-testid="doc-engagement-risk"'));
    expect(pages, 'la section engagementRisk doit vivre dans exactement une page de la doc').toHaveLength(1);
    const page = pages[0]!;
    const debut = page.indexOf('data-testid="doc-engagement-risk"');
    const section = page.slice(debut, page.indexOf('</p>', debut));
    for (const code of [...NIVEAUX_RISQUE, ...RAISONS_RISQUE]) expect(section, code).toContain(`<C>${code}</C>`);
  });
});
