import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const RACINE = resolve(__dirname, '..');
// Fins de ligne normalisees : les fichiers du depot sont en CRLF, un litteral gabarit est en LF.
const CABLAGE = readFileSync(join(RACINE, 'src', 'index.ts'), 'utf8').split('\r\n').join('\n');

/**
 * LA MARGE EST-ELLE BRANCHEE, ET PAS SEULEMENT ECRITE ?
 *
 * 🔴 CE FICHIER EXISTE PARCE QUE LE DEFAUT A ETE OUBLIE TROIS FOIS DE SUITE, ET QU AUCUN TEST NE POUVAIT
 * LE VOIR. Mesure du 2026-09-18 : en remettant `return brut;` a la place de `pricingFacture(...)` dans le
 * cablage, c est-a-dire en remettant EXACTEMENT le defaut qu on venait de corriger, les 5683 tests
 * restaient VERTS. Les cas de `tests/prix-bornes.test.ts` appellent les deux fonctions en direct : ils
 * prouvent qu elles calculent juste, jamais qu on les appelle. Et le test de la route stubbe `getPricing`
 * au niveau des dependances, donc il ne voit jamais l implementation.
 *
 * C est le piege n°4 de la skill de revue, mot pour mot : « une garde qu on peut debrancher sans qu aucun
 * test ne tombe n est pas une garde, c est une fonction que quelqu un a ecrite un jour ». Le depot sait
 * faire (`tests/campagne-cablage.test.ts`), il fallait le faire ici.
 *
 * ⚠️ CE QUE CE TEST NE PROUVE PAS : que le resultat soit juste. Ca, c est `tests/prix-bornes.test.ts`. Il
 * prouve seulement que le chemin passe par la ou la marge s applique, ce qui est precisement ce qui
 * manquait.
 */
describe('la marge est BRANCHEE sur les deux chemins qui rendent un prix', () => {
  /**
   * Le corps qui suit une ancre du cablage.
   *
   * ⚠️ L ANCRE EST LE TEXTE EXACT, pas un nom auquel on ajoute un `:`. La premiere version ajoutait le
   * deux-points et ne trouvait donc pas `const prixFactures = async`, qui n en a pas : le test echouait
   * pour une raison qui n etait pas celle qu il teste, ce qui est la pire facon d avoir raison.
   */
  const bloc = (ancre: string): string => {
    const i = CABLAGE.indexOf(ancre);
    expect(i, `l ancre « ${ancre} » a disparu du cablage`).toBeGreaterThan(-1);
    return CABLAGE.slice(i, i + 2500);
  };

  it('🔴 getPricing rend un PRIX DE VENTE, pas le resume brut de Meta', () => {
    // La faute qu on attrape : `return brut;`, ou un retour direct de `getPricingAnalytics`.
    expect(bloc('getPricing:'), 'le resume de Meta doit passer par pricingFacture').toContain('pricingFacture(');
  });

  it('🔴 prixFactures applique la marge, elle ne rend pas les tarifs tels quels', () => {
    expect(bloc('const prixFactures ='), 'les tarifs doivent passer par tarifsFactures').toContain('tarifsFactures(');
  });

  it('🔴 les deux chemins LISENT la grille de l espace, sinon la marge serait celle de personne', () => {
    // Sans `grillePrix`, on margerait avec le defaut a 100, donc on ne margerait pas du tout, et le test
    // precedent passerait quand meme.
    expect(bloc('getPricing:')).toContain('grillePrix(');
    expect(bloc('const prixFactures =')).toContain('grillePrix(');
  });

  /**
   * 🔴 ET LA MARGE NE S APPLIQUE QU A CES DEUX ENDROITS. Un troisieme point d application la compterait
   * deux fois sur le chemin qui le traverse, et chaque fonction prise isolement resterait juste : c est
   * exactement ce que la garde de `tests/prix-bornes.test.ts` empeche cote `src/stats/`. Ici on borne le
   * cablage, qui est l autre moitie.
   */
  it('🔴 le cablage n applique la marge que par ces deux fonctions', () => {
    const appels = (CABLAGE.match(/prixTemplate\(/g) ?? []);
    expect(appels, 'le cablage ne doit jamais marger lui-meme').toHaveLength(0);
  });
});
