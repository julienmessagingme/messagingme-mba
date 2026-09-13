/**
 * LES CONTACTS ÉCARTÉS À LA CRÉATION D'UNE CAMPAGNE, dits avec la correction qui leur correspond.
 *
 * 🔴 DEUX MOTIFS QUI N'APPELLENT PAS LA MÊME CORRECTION, ET LES CONFONDRE ENVOIE CORRIGER LA MAUVAISE
 * CHOSE. Une variable de modèle sans valeur sur la fiche se répare dans les fiches ; un contact sans
 * opt-in sur une campagne marketing ne se répare pas là du tout, il se répare en passant la campagne en
 * « Service » ou en changeant d'audience. L'écran en service portait un texte FIGÉ sur « la variable du
 * template », faux pour un écart de consentement et structurellement toujours faux en RCS, qui n'a aucune
 * variable de modèle : l'opérateur était renvoyé vers une action qui n'existe pas.
 *
 * ⚠️ MODULE PUR (ni React, ni `@/`) : la règle est exerçable en quelques millisecondes, alors qu'enfouie
 * dans un `.tsx` elle ne le serait que par un e2e qui monte un serveur Next.
 */

/** Un écart, réduit à ce qui décide de la phrase. Le reste de la charge (`contactId`, `toE164`) ne sert pas ici. */
export interface Ecart {
  reason: string;
}

/** Le détail ventilé : combien pour chaque motif, et rien pour un motif à zéro. */
export function detailDesEcartes(ecarts: readonly Ecart[]): string {
  const sansOptIn = ecarts.filter((x) => x.reason === 'not_opted_in').length;
  const sansVariable = ecarts.length - sansOptIn;
  return [
    sansVariable > 0 ? `${sansVariable} sans valeur pour une variable du modèle` : '',
    sansOptIn > 0 ? `${sansOptIn} sans opt-in (une campagne marketing l’exige)` : '',
  ].filter(Boolean).join(', ');
}

/**
 * « PERSONNE NE RESTE », avec la correction qui correspond VRAIMENT au motif.
 *
 * 🔴 LA CAMPAGNE EXISTE DÉJÀ QUAND CETTE PHRASE S'AFFICHE, et c'est ce que la dernière ligne dit. La
 * création a réussi, seul le LANCEMENT est refusé : sans cette précision, l'opérateur corrige puis
 * recommence depuis le début et se retrouve avec deux campagnes du même nom, dont une vide.
 */
export function messageAucunDestinataire(ecarts: readonly Ecart[]): string {
  const detail = detailDesEcartes(ecarts);
  const correction = ecarts.length > 0 && ecarts.every((x) => x.reason === 'not_opted_in')
    ? 'Ces contacts n’ont pas donné leur consentement : passez la campagne en « Service » si elle relève du service, ou choisissez d’autres contacts.'
    : 'Corrigez la source de la variable ou les fiches, ou passez la campagne en « Service » si elle relève du service.';
  // ⚠️ ZÉRO ÉCART ET ZÉRO DESTINATAIRE EST UN CAS RÉEL : une audience dont tous les contacts sont bloqués
  // ou déjà sortis n'est pas « écartée à la construction », elle est simplement vide. Annoncer « les 0
  // contact(s) sélectionné(s) ont été écartés » serait une phrase absurde là où il faut une explication.
  const constat = ecarts.length === 0
    ? 'Aucun destinataire : la sélection ne retient aucun contact joignable.'
    : `Aucun destinataire : les ${ecarts.length} contact(s) sélectionné(s) ont été écartés (${detail}).`;
  return `${constat} ${correction} La campagne a bien été créée : reprenez-la depuis la liste des campagnes plutôt que d’en créer une seconde.`;
}
