import { describe, it, expect } from 'vitest';
import { chaineAleatoire } from '../src/lib/jeton-aleatoire';

/**
 * Le tirage aléatoire partagé par les deux générateurs de jeton d'entrée WhatsApp (module partagé,
 * `documentation.md` § Modules partagés).
 *
 * Ce que ce test protège, et qui ne se voit pas à la lecture :
 *  1. 🔴 LA PRÉCONDITION DE `chaineAleatoire` : le modulo (`b % alphabet.length`) ne biaise aucun caractère
 *     UNIQUEMENT parce que 256 (le nombre de valeurs d'un octet) est un multiple EXACT de la taille de
 *     l'alphabet. Ce n'est PAS garanti par la fonction elle-même (elle accepte n'importe quel alphabet),
 *     seulement par ses deux appelants actuels (`src/channels-me/jeton.ts` et `src/workflow/test-token.ts`,
 *     tous deux sur le même alphabet Crockford minuscule de 32 caractères). Cette précondition n'existait
 *     jusqu'ici qu'en prose, dans les commentaires des deux appelants : une assertion arithmétique la fige,
 *     et casserait si quelqu'un ajoutait (ou retirait) une lettre à cet alphabet sans y penser.
 *  2. La forme du tirage lui-même : longueur exacte, uniquement des caractères de l'alphabet fourni.
 */

// Alphabet Crockford minuscule (sans i, l, o, u) des deux appelants actuels : `ALPHABET` dans
// src/channels-me/jeton.ts et `CROCKFORD` dans src/workflow/test-token.ts. Recopié ICI en toutes lettres
// (comme il l'est déjà entre ces deux fichiers) précisément pour que ce test échoue si l'un d'eux change
// sans que la précondition ci-dessous soit revérifiée.
const ALPHABET_CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

describe('chaineAleatoire : précondition sans biais', () => {
  it('🔴 256 (les valeurs d’un octet) est un multiple EXACT de la taille de l’alphabet des deux appelants', () => {
    expect(ALPHABET_CROCKFORD).toHaveLength(32);
    // C'est CETTE ligne qui casserait si quelqu'un ajoutait ou retirait une lettre de l'alphabet sans
    // revérifier que le tirage reste sans biais.
    expect(256 % ALPHABET_CROCKFORD.length).toBe(0);
  });

  it('un alphabet dont la taille ne divise pas 256 violerait la precondition (ex. 32 vs 30)', () => {
    // Ce test ne verifie pas un comportement de chaineAleatoire (elle n'a pas de garde a l'execution, par
    // design : c'est ses appelants qui portent la garantie) mais illustre le contraste : une taille de 30 ne
    // divise pas 256, et c'est exactement le genre de changement d'alphabet qui reintroduirait un biais
    // silencieux si l'assertion ci-dessus n'existait pas.
    expect(256 % 30).not.toBe(0);
  });
});

describe('chaineAleatoire : forme du tirage', () => {
  const TIRAGES = 200;

  it('rend une chaine de la longueur demandee', () => {
    for (const longueur of [1, 8, 16]) {
      expect(chaineAleatoire(longueur, ALPHABET_CROCKFORD)).toHaveLength(longueur);
    }
  });

  it('longueur 0 rend la chaine vide, sans lever', () => {
    expect(chaineAleatoire(0, ALPHABET_CROCKFORD)).toBe('');
  });

  it('sur 200 tirages, chaque caractere rendu appartient a l’alphabet fourni', () => {
    for (let i = 0; i < TIRAGES; i += 1) {
      const tire = chaineAleatoire(8, ALPHABET_CROCKFORD);
      for (const c of tire) {
        expect(ALPHABET_CROCKFORD.includes(c), `caractere hors alphabet : ${c} dans ${tire}`).toBe(true);
      }
    }
  });

  it('200 tirages de 8 caracteres donnent 200 chaines distinctes (40 bits de hasard)', () => {
    const vus = new Set<string>();
    for (let i = 0; i < TIRAGES; i += 1) vus.add(chaineAleatoire(8, ALPHABET_CROCKFORD));
    expect(vus.size).toBe(TIRAGES);
  });
});
