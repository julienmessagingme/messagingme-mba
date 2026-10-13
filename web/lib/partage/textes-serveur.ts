/**
 * Les textes que le serveur écrit et que la console RECONNAÎT pour décider de ce qu'elle affiche. Changer l'un sans
 * l'autre ne casserait aucun compilateur, et l'écran se remettrait à mal se conduire : d'où leur place ici.
 */

/**
 * Le corps d'une réponse 5xx du gestionnaire global de l'API : opaque, et en anglais, rien de l'erreur interne n'en
 * sort. La console le remplace par une phrase traduite qui dit quoi faire (`messageDErreur`, `web/lib/http.ts`).
 */
export const CORPS_OPAQUE_5XX = 'Internal Server Error';

/**
 * 🔴 Le refus d'un code de second facteur : un seul message pour un code faux, rejoué ou hors fenêtre, les distinguer
 * dirait lequel a été juste. C'est aussi la SEULE chose qui distingue ce 401 d'une session tombée (même statut) :
 * sans elle, un code mal tapé sur la page Compte viderait la session et renverrait à la connexion.
 */
export const MESSAGE_CODE_INVALIDE = 'Code invalide ou expiré.';
