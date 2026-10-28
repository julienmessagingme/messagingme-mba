import { describe, it, expect } from 'vitest';
import { lire, pagesHtml } from './vitrine-lecture';

/**
 * UNE PROPRIÉTÉ CSS ENREGISTRÉE (`@property`) VAUT POUR TOUTE LA VITRINE. Son nom n'est plus local au composant qui
 * l'a déclarée : une valeur d'un autre type, posée ailleurs sous le même nom, retombe en silence sur la valeur
 * initiale, et la règle qui la lit par `var()` devient invalide. Vécu du 2026-10-26 au 2026-10-28 : l'orbite des pages
 * de cas a enregistré `--t` comme un angle, l'accueil s'en servait comme délai (`--t:.4s`), son animation d'entrée
 * est tombée à `animation: none` et les téléphones de la une sont restés vides, sans une erreur nulle part.
 * Ce test exige que chaque valeur donnée à un nom enregistré, dans `site.css` comme dans les pages, soit de son type.
 * Une valeur calculée (`var()`, `calc()`) ne se juge qu'au rendu : elle est laissée au navigateur.
 */

const TYPES: Record<string, RegExp> = {
  '<angle>': /^-?(\d+\.?\d*|\.\d+)(deg|rad|grad|turn)$/,
  '<integer>': /^-?\d+$/,
  '<number>': /^-?(\d+\.?\d*|\.\d+)$/,
  '<time>': /^(\d+\.?\d*|\.\d+)(s|ms)$/,
};

const css = lire('site.css');
const enregistrees = [...css.matchAll(/@property\s+(--[\w-]+)\s*\{[^}]*syntax:\s*"([^"]+)"/g)].map(([, nom = '', syntaxe = '']) => ({ nom, syntaxe }));
const sources = [{ fichier: 'site.css', texte: css }, ...pagesHtml().map((p) => ({ fichier: p, texte: lire(p) }))];

describe('les propriétés CSS enregistrées de la vitrine', () => {
  it('existent (sinon ce test ne vérifie plus rien)', () => {
    expect(enregistrees.length).toBeGreaterThan(0);
  });

  it.each(enregistrees)('$nom ($syntaxe) ne reçoit que des valeurs de son type', ({ nom, syntaxe }) => {
    const type = TYPES[syntaxe];
    expect(type, `syntaxe ${syntaxe} inconnue de ce test : l'ajouter à TYPES`).toBeDefined();
    const echappe = nom.replace(/-/g, '\\-');
    const fautives = sources.flatMap(({ fichier, texte }) =>
      [...texte.matchAll(new RegExp(`(?<![\\w-])${echappe}\\s*:\\s*([^;"}]+)`, 'g'))]
        .map(([, valeur = '']) => valeur.trim())
        .filter((valeur) => !/\b(var|calc)\(/.test(valeur) && !type!.test(valeur))
        .map((valeur) => `${fichier} : ${nom}:${valeur}`),
    );
    expect(fautives).toEqual([]);
  });
});
