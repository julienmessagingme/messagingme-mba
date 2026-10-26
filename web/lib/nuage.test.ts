import { describe, it, expect } from 'vitest';
import { MILIEU_ECHELLE, positionPct, rayonPoint, estAlerte, RAYON_MIN, RAYON_MAX } from './nuage';
import { NOTE_MAX, NOTE_MIN } from './partage/analyse';

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
