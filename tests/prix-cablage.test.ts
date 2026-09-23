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
    // ⚠️ UNE ANCRE AMBIGUE SE DEPLACE EN SILENCE : `indexOf` prend la PREMIERE occurrence, donc le jour
    // ou une autre propriete porte le meme nom plus haut, la garde change de sujet sans rien dire. C est
    // le mecanisme exact du faux vert raconte plus bas, sous une autre forme.
    expect(CABLAGE.split(ancre).length - 1, `l ancre « ${ancre} » n est pas unique`).toBe(1);
    return CABLAGE.slice(i, i + 2500);
  };

  /**
   * LA SEULE LIGNE qui porte l ancre, pour un cablage qui tient sur une ligne.
   *
   * 🔴 IL A FALLU CETTE SECONDE FORME PARCE QUE LA PREMIERE A RENDU UN FAUX VERT. La fenetre de 2500
   * caracteres de `bloc` attrapait un `grillePrix(` appartenant a une propriete VOISINE : en debranchant la
   * lecture de la marge, le test restait vert. Trouve par mutation, quelques minutes apres avoir ecrit le
   * test. Une fenetre large est commode tant qu on ne cherche pas un motif que le voisinage porte aussi.
   */
  const ligne = (ancre: string): string => {
    const i = CABLAGE.indexOf(ancre);
    expect(i, `l ancre « ${ancre} » a disparu du cablage`).toBeGreaterThan(-1);
    // ⚠️ UNE ANCRE AMBIGUE SE DEPLACE EN SILENCE : `indexOf` prend la PREMIERE occurrence, donc le jour
    // ou une autre propriete porte le meme nom plus haut, la garde change de sujet sans rien dire. C est
    // le mecanisme exact du faux vert raconte juste au-dessus, sous une autre forme.
    expect(CABLAGE.split(ancre).length - 1, `l ancre « ${ancre} » n est pas unique`).toBe(1);
    const fin = CABLAGE.indexOf('\n', i);
    return CABLAGE.slice(i, fin === -1 ? undefined : fin);
  };

  it('🔴 getPricing rend un PRIX DE VENTE, pas le resume brut de Meta', () => {
    // La faute qu on attrape : `return brut;`, ou un retour direct de `getPricingAnalytics`.
    expect(bloc('getPricing:'), 'le resume de Meta doit passer par pricingFacture').toContain('pricingFacture(');
  });

  it('🔴 prixFactures applique la marge, elle ne rend pas les tarifs tels quels', () => {
    expect(bloc('const prixFactures ='), 'les tarifs doivent passer par tarifsFactures').toContain('tarifsFactures(');
  });

  it('🔴 les deux chemins LISENT la grille, sinon la marge serait celle de personne', () => {
    // Sans lecture de la grille, on margerait avec le defaut a 100, donc on ne margerait pas du tout, et le
    // test precedent passerait quand meme.
    //
    // ⚠️ L ANCRE EST `grillePrixGlobale(` DEPUIS LE 2026-09-23 (migration 0168) : il n y a plus qu une
    // grille, et la fonction a perdu son parametre d espace justement pour qu un appelant ne puisse plus
    // CROIRE qu il lit le prix d un client precis. Ce test cherchait `grillePrix(`, ce qui aurait continue
    // de matcher `grillePrixGlobale(` par prefixe : il serait reste vert meme si l un des deux chemins
    // avait garde l ancienne lecture par espace. On cherche donc le nom COMPLET.
    expect(bloc('getPricing:')).toContain('grillePrixGlobale(');
    expect(bloc('const prixFactures =')).toContain('grillePrixGlobale(');
    // Et la preuve inverse : plus AUCUNE lecture par espace ne subsiste dans le cablage.
    expect(CABLAGE, 'une lecture par espace laissee derriere lirait une grille qui n existe plus')
      .not.toMatch(/grillePrix\(tenant\)/);
  });

  /**
   * 🔴 LA MARGE QUI EXPLIQUE L ECART EST BRANCHEE, ELLE AUSSI, ET C ETAIT LE COMBLE DE CE FICHIER. Le commit
   * qui a pose cette garde mecanique contre « ecrit mais pas branche » a laisse hors de la garde la seule
   * capacite qu il branchait : la lecture de la marge pour la carte « Facture par Meta ». Mesure : en
   * supprimant cette ligne du cablage, les quatre cas d alors restaient verts, et le typecheck aussi,
   * puisque la dependance etait declaree optionnelle. Elle est desormais REQUISE, et ancree ici.
   */
  it('🔴 la marge qui explique l ecart est lue depuis la MEME grille que les prix', () => {
    expect(ligne('margeTemplate:'), 'la marge doit venir de la grille globale').toContain('grillePrixGlobale(');
  });

  /**
   * 🔴 ET LA MARGE NE S APPLIQUE QU A CES DEUX ENDROITS. Un troisieme point d application la compterait
   * deux fois sur le chemin qui le traverse, et chaque fonction prise isolement resterait juste. La moitie
   * `src/stats/` est tenue par `tests/cout-messages.test.ts` (« ce module ne marge PLUS ») et par la garde
   * de `tests/prix-bornes.test.ts` qui interdit un appel a `prixTemplate` hors du module de prix (elle lit
   * le fichier SQL ET fait un `git grep` sur `src/`, contrairement a ce que cette phrase a d abord dit). ⚠️ La
   * premiere version de ce commentaire attribuait les deux a `prix-bornes` :
   * un fichier neuf qui corrige deux commentaires nommant le mauvais test en introduisait un troisieme.
   */
  it('🔴 le cablage n applique la marge que par ces deux fonctions', () => {
    const appels = (CABLAGE.match(/prixTemplate\(/g) ?? []);
    expect(appels, 'le cablage ne doit jamais marger lui-meme').toHaveLength(0);
  });
});
