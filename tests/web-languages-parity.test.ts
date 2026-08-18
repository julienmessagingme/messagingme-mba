import { describe, it, expect } from 'vitest';
import { META_TEMPLATE_LANGUAGES } from '../web/lib/languages';
import { TEMPLATE_LANGUAGE_CODES } from '../src/meta/languages';

// Les deux listes de langues de template portaient un simple « GARDER SYNCHRONISÉ » en commentaire, sans le
// test de parité que le repo utilise pour ses autres duplications entre les deux builds (boutons URL,
// poignées de carousel, types de champ). Une langue ajoutée d'un seul côté passait donc inaperçue : proposée
// dans le sélecteur mais refusée par la whitelist serveur (4xx à la création), ou l'inverse.
describe('parité des langues de template front (META_TEMPLATE_LANGUAGES) / back (TEMPLATE_LANGUAGE_CODES)', () => {
  it('les deux listes contiennent exactement les mêmes codes', () => {
    expect(META_TEMPLATE_LANGUAGES.map((l) => l.code).sort()).toEqual([...TEMPLATE_LANGUAGE_CODES].sort());
  });

  it('aucun code en double côté front (le sélecteur afficherait deux fois la même langue)', () => {
    const codes = META_TEMPLATE_LANGUAGES.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
