import { randomBytes } from 'node:crypto';

/**
 * Tirage aleatoire partage par les DEUX generateurs de jeton d'entree WhatsApp : `nouveauJeton`
 * (`src/channels-me/jeton.ts`, jeton de declenchement d'un lien de chaine) et `newTestToken`
 * (`src/workflow/test-token.ts`, jeton de test d'un scenario). Les deux copiaient le meme alphabet et la
 * meme boucle avant cette extraction (2026-09-04) : deux copies identiques finissent toujours par diverger.
 *
 * ⚠️ `src/ids/code.ts` (fonction interne `codeAleatoire`) fait un tirage du meme genre par une AUTRE
 * technique (buffer de bits base32, alphabet different) pour des identifiants publics (codes, ULID). Elle
 * n'est PAS unifiee ici : changer la methode de tirage de jetons deja emis et stockes en base serait un
 * changement de comportement, ce que ce module s'interdit precisement.
 *
 * Module PUR (la generation utilise crypto, aucune IO) -> testable sans base.
 * ⚠️ Un jeton issu de ce tirage n'est JAMAIS journalise par ses appelants : c'est l'identifiant qui declenche
 * un scenario ou un test.
 */

/**
 * Chaine aleatoire de `longueur` caracteres dans `alphabet`, un caractere par octet tire (`randomBytes`).
 *
 * 🔴 Le modulo (`b % alphabet.length`) ne biaise aucun caractere UNIQUEMENT parce que 256 est un multiple
 * EXACT de la taille de l'alphabet (32 pour l'alphabet Crockford minuscule des deux appelants actuels).
 * Appeler cette fonction avec un alphabet dont la taille ne divise pas 256 reintroduirait un biais
 * silencieux : ce n'est pas garanti par la fonction elle-meme, seulement par ses deux appelants actuels.
 */
export function chaineAleatoire(longueur: number, alphabet: string): string {
  let out = '';
  for (const b of randomBytes(longueur)) out += alphabet[b % alphabet.length];
  return out;
}
