import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { NIVEAUX_RISQUE, RAISONS_RISQUE } from '../src/engagement/risque';
import { NIVEAUX_DU_FILTRE } from '../web/lib/risque';
import { FICHIERS_DOC } from '../web/lib/doc-api-pages';

/**
 * LE RISQUE DE DÉSENGAGEMENT, DES DEUX CÔTÉS (lot 7 de l'API publique, spec § 19).
 *
 * 🔴 LES CODES SONT UN CONTRAT : le serveur les écrit en base, l'API publique et l'outil du client les lisent tels
 * quels, et la console les traduit. Un code ajouté au serveur sans libellé s'afficherait brut sur la fiche ; un
 * libellé sans code serait un reste. Niveaux et codes sont désormais PARTAGÉS (`web/lib/partage/risque.ts`), badges
 * et libellés typés dessus : reste le filtre, une liste, où un niveau que le serveur ne connaît pas serait REFUSÉ en
 * 400 à chaque clic, et la documentation de l'API.
 */
const trie = (l: readonly string[]): string[] => [...l].sort();

describe('le risque : parité serveur et console', () => {
  // Niveaux et codes sont partagés, badges et libellés typés dessus : seul le filtre, une liste, peut en oublier un.
  it('🔴 le filtre de la console propose EXACTEMENT les niveaux du serveur', () => {
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
