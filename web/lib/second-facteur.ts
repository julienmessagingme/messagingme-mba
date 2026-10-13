/**
 * LE SECOND FACTEUR, CÔTÉ CONSOLE : ce qui se calcule sans écran (plan `docs/superpowers/plans/2026-09-25-mfa-admins.md`).
 *
 * Module PUR, qui n'importe que le dossier partagé : `lib/http.ts` le lit pour reconnaître un code refusé, et un
 * import dans l'autre sens ferait une boucle.
 */
import { MESSAGE_CODE_INVALIDE } from './partage/textes-serveur';

/**
 * Le corps d'une réponse dit-il « code refusé » ? 🔴 C'EST LA SEULE CHOSE QUI DISTINGUE CE 401 D'UNE SESSION
 * TOMBÉE : même statut, et le corps ne porte que le texte que le serveur écrit (`MESSAGE_CODE_INVALIDE`, partagé
 * avec lui). Sans elle, un code mal tapé sur la page Compte viderait la session et renverrait à la connexion.
 */
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
    ? ['Messaging Me : codes de secours de la double authentification', 'Chaque code ne sert qu’une fois.']
    : ['Messaging Me: two-factor authentication backup codes', 'Each code works only once.'];
  return [...tete, '', ...codes, ''].join('\n');
}
