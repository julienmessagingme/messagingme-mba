import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { NOTE_MIN, NOTE_MAX, MILIEU_ECHELLE, positionPct, rayonPoint, estAlerte, RAYON_MIN, RAYON_MAX } from './nuage';

describe('nuage — position sur les axes', () => {
  it('les bornes tombent aux extrémités, le milieu au milieu', () => {
    expect(positionPct(NOTE_MIN)).toBe(0);
    expect(positionPct(NOTE_MAX)).toBe(100);
    expect(positionPct(MILIEU_ECHELLE)).toBe(50);
  });

  it('🔴 une note hors échelle est RAMENÉE dans le cadre, elle ne sort pas du dessin', () => {
    // Le serveur borne déjà (schéma Zod + CHECK de la 0121), donc ce cas ne devrait pas arriver. S'il
    // arrivait quand même, un point dessiné à -20 % sortirait du viewBox : il ne s'afficherait nulle part
    // ET ne compterait nulle part, ce qui est la façon la plus discrète de perdre une donnée.
    expect(positionPct(-3)).toBe(0);
    expect(positionPct(42)).toBe(100);
  });
});

describe('nuage — taille des points', () => {
  it('une case vide ne se dessine pas, une case seule prend le rayon minimum', () => {
    expect(rayonPoint(0, 5)).toBe(0);
    expect(rayonPoint(1, 1)).toBe(RAYON_MIN);
    expect(rayonPoint(1, 9)).toBe(RAYON_MIN);
  });

  it('la plus grosse case prend le rayon maximum, et la croissance est en RACINE', () => {
    expect(rayonPoint(9, 9)).toBeCloseTo(RAYON_MAX);
    // Le point du milieu de l'échelle des comptes est plus gros que la moyenne des rayons : c'est la
    // signature de la racine carrée. Avec un rayon proportionnel au compte, il serait pile au milieu, et
    // une case de 100 paraîtrait cent fois plus grosse qu'une case de 1 au lieu de dix.
    const milieu = rayonPoint(5, 9);
    expect(milieu).toBeGreaterThan((RAYON_MIN + RAYON_MAX) / 2);
    expect(milieu).toBeLessThan(RAYON_MAX);
  });
});

describe('nuage — le coin qui alarme', () => {
  it('mécontent ET pressé, les deux à la fois', () => {
    expect(estAlerte(1, 9)).toBe(true);
    expect(estAlerte(9, 9)).toBe(false); // satisfait, même pressé
    expect(estAlerte(1, 1)).toBe(false); // mécontent, mais rien ne presse
  });

  it('le milieu exact n’alarme pas : la règle est stricte des deux côtés', () => {
    expect(estAlerte(MILIEU_ECHELLE, MILIEU_ECHELLE)).toBe(false);
    expect(estAlerte(MILIEU_ECHELLE, MILIEU_ECHELLE + 1)).toBe(false);
    expect(estAlerte(MILIEU_ECHELLE - 1, MILIEU_ECHELLE)).toBe(false);
  });
});

/**
 * 🔴 L'ÉCHELLE DU FRONT DOIT RESTER CELLE DU SERVEUR.
 *
 * Deux constantes dans deux fichiers que rien ne relie : le front ne peut pas importer `src/`, et chacune
 * est parfaitement plausible seule. C'est leur ÉCART qui porte l'invariant, donc il ne peut se tenir que
 * dans un test. Si l'échelle passait un jour à 0-100 côté serveur, l'axe resterait gradué à 10 et tous les
 * points s'écraseraient contre son bord droit, sans erreur, sans avertissement, avec un graphe qui a l'air
 * de fonctionner.
 *
 * Le test DÉRIVE la valeur du fichier serveur plutôt que de la recopier : une copie ne ferait que déplacer
 * la dérive d'un fichier à l'autre. Même idiome que `web/lib/nav.test.ts` avec le type `Tab`.
 */
describe('nuage — alignement avec le serveur', () => {
  it('🔴 NOTE_MIN et NOTE_MAX valent ceux de src/analysis/schema.ts', async () => {
    const src = await readFile(new URL('../../src/analysis/schema.ts', import.meta.url), 'utf8');
    const lu = (nom: string): number => {
      const m = src.match(new RegExp(`export const ${nom} = (-?[0-9]+);`));
      expect(m, `${nom} n'a pas été lu dans le schéma serveur : ce test ne garde plus rien`).not.toBeNull();
      return Number(m![1]);
    };
    expect(NOTE_MIN).toBe(lu('NOTE_MIN'));
    expect(NOTE_MAX).toBe(lu('NOTE_MAX'));
  });
});
