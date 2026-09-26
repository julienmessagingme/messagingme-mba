/**
 * LE SECOND FACTEUR, CÔTÉ CONSOLE : ce qui se calcule sans écran (plan `docs/superpowers/plans/2026-09-25-mfa-admins.md`).
 *
 * Module PUR, sans import : `lib/http.ts` le lit pour reconnaître un code refusé, et un import dans l'autre sens
 * ferait une boucle.
 */

/**
 * CE QUE LE SERVEUR ÉCRIT QUAND UN CODE EST REFUSÉ (`MESSAGE_CODE_INVALIDE`, `src/auth/mfa-routes.ts`).
 *
 * 🔴 C'EST LA SEULE CHOSE QUI DISTINGUE CE 401 D'UNE SESSION TOMBÉE : même statut, et le corps ne porte qu'un
 * texte. Sans elle, un code mal tapé sur la page Compte viderait la session et renverrait à la connexion. La
 * frontière de build interdit d'importer le serveur : la constante est recopiée, et
 * `tests/web-second-facteur-parite.test.ts` tient les deux égales.
 */
export const MESSAGE_CODE_INVALIDE = 'Code invalide ou expiré.';

/** Le corps d'une réponse dit-il « code refusé » ? */
export function estCorpsCodeRefuse(corps: unknown): boolean {
  return (corps as { error?: unknown } | null)?.error === MESSAGE_CODE_INVALIDE;
}

/** La clé à saisir à la main, par groupes de quatre : on la recopie sans perdre sa place. */
export function grouperCle(secret: string): string {
  return (secret.replace(/\s/g, '').match(/.{1,4}/g) ?? []).join(' ');
}

/**
 * Le contenu du fichier `.txt` des codes de secours. Rien d'autre que les codes et de quoi les reconnaître :
 * ni l'adresse, ni l'espace, pour qu'un fichier retrouvé ne dise pas à quel compte il ouvre.
 */
export function texteCodesSecours(codes: readonly string[], fr: boolean): string {
  const tete = fr
    ? ['Engage Me : codes de secours de la double authentification', 'Chaque code ne sert qu’une fois.']
    : ['Engage Me: two-factor authentication backup codes', 'Each code works only once.'];
  return [...tete, '', ...codes, ''].join('\n');
}
