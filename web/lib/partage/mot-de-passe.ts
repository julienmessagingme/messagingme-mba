/**
 * La longueur minimale d'un mot de passe choisi, lue au même endroit par le serveur (`src/auth/routes.ts`, qui refuse)
 * et par les quatre écrans qui en posent un (création de compte, invitation, réinitialisation, changement), qui
 * l'annoncent et la font respecter au navigateur (`minLength`).
 *
 * 🔴 ELLE A ÉTÉ ÉCRITE QUATRE FOIS, ET HUIT EN COMPTANT LES TEXTES : le 2026-09-10, le serveur est passé de 8 à 12 et
 * les écrans annonçaient toujours « 8 caractères minimum », avec un `minLength={8}` qui laissait le navigateur accepter
 * avant que le serveur ne refuse. Aucune règle de composition : elles poussent à `Password1!`, la longueur seule laisse
 * passer les phrases de passe.
 */
export const MIN_MOT_DE_PASSE = 12;
