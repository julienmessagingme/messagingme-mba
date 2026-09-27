import { randomBytes } from 'node:crypto';

/**
 * Tirage aléatoire partagé par les deux générateurs de jeton d'entrée WhatsApp (`nouveauJeton` et
 * `newTestToken`). `src/ids/code.ts` tire ses identifiants publics par une autre technique : ne pas l'unifier
 * ici, changer la méthode de tirage de jetons déjà émis et stockés changerait le comportement.
 *
 * Un jeton issu de ce tirage n'est jamais journalisé : c'est l'identifiant qui déclenche un scénario ou un test.
 */

/**
 * Chaîne aléatoire de `longueur` caractères dans `alphabet`, un caractère par octet tiré.
 * 🔴 Le modulo ne biaise aucun caractère seulement parce que 256 est un multiple exact de la taille de
 * l'alphabet (32 chez les appelants) : un alphabet dont la taille ne divise pas 256 réintroduirait un biais.
 */
export function chaineAleatoire(longueur: number, alphabet: string): string {
  let out = '';
  for (const b of randomBytes(longueur)) out += alphabet[b % alphabet.length];
  return out;
}
