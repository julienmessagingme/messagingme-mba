/**
 * RANGER une conversation dans un dossier : les destinations proposées, et leurs libellés.
 *
 * Module PUR : aucune IO, aucune dépendance React/navigateur, aucun alias `@/` (types structuraux locaux,
 * comme `campaign-eligibility.ts`) -> testable depuis la suite racine (tests/web-inbox-rangement.test.ts).
 * Importer `./api` ici tirerait `session.ts` (et `window`) dans la compilation racine : à ne pas faire.
 *
 * 🔴 POURQUOI CE FICHIER EXISTE PLUTÔT QUE DEUX MENUS CÔTE À CÔTE. L'Inbox propose le même geste à DEUX
 * endroits : sur la conversation ouverte, et sur une sélection de lignes cochées. Les deux ne décident pas
 * des mêmes options (voir plus bas), mais ils partagent les LIBELLÉS et le vocabulaire des actions. Deux
 * tables de libellés dériveraient au premier renommage, et l'écran proposerait « Archivé » d'un côté,
 * « Archiver » de l'autre, pour la même chose.
 */

/**
 * Le geste de rangement, en valeurs FERMÉES.
 *
 * ⚠️ Une chaîne libre avait un défaut silencieux : le menu de la conversation ouverte terminait par
 * `archiverConversation(..., action === 'archiver')`, donc TOUTE valeur inattendue DÉSARCHIVAIT. Un jeu
 * fermé plus `estActionRangement` ferme ce chemin au lieu de compter sur le fait que le `<select>` ne
 * produit jamais autre chose.
 */
export type ActionRangement =
  | 'a-traiter' | 'traiter' | 'ne-plus-traiter' | 'signaler' | 'ne-plus-signaler' | 'archiver' | 'desarchiver';

const ACTIONS: readonly ActionRangement[] = [
  'a-traiter', 'traiter', 'ne-plus-traiter', 'signaler', 'ne-plus-signaler', 'archiver', 'desarchiver',
];

/** La valeur lue sur un `<select>` est-elle un geste connu ? Le libellé-titre (chaîne vide) rend `false`. */
export function estActionRangement(v: string): v is ActionRangement {
  return (ACTIONS as readonly string[]).includes(v);
}

/**
 * Le dossier ouvert, en type STRUCTURAL local (`DossierInbox` vit dans un composant client, l'importer
 * tirerait React dans la compilation racine).
 *
 * 🔴 C'EST AUSSI LA GARDE : le site d'appel passe un `DossierInbox`, donc ajouter un dossier là-bas sans le
 * déclarer ici casse la COMPILATION. Sans ça, un dossier neuf hériterait en silence des destinations du cas
 * par défaut, qui n'ont aucune raison de lui convenir.
 */
export type DossierLike = 'toutes' | 'aTraiter' | 'traitees' | 'signalees' | 'archivees' | 'nonAffectees' | { membre: string };

/** Le libellé d'un geste, écrit UNE fois pour les deux menus. */
export function libelleRangement(a: ActionRangement, t: (fr: string, en?: string) => string): string {
  switch (a) {
    case 'a-traiter': return t('À traiter', 'To handle');
    case 'traiter': return t('Traité', 'Done');
    // « Ne plus marquer », et surtout pas « Remettre à traiter » : retirer le statut rend la conversation
    // au dossier que son DERNIER MESSAGE désigne, et si c'est nous qui avons écrit en dernier, elle ne
    // revient PAS dans « À traiter ». Le libellé promettrait un effet qui n'a pas lieu.
    case 'ne-plus-traiter': return t('Ne plus marquer traité', 'Unmark as done');
    case 'signaler': return t('Signalé', 'Flagged');
    case 'ne-plus-signaler': return t('Ne plus signaler', 'Unflag');
    case 'archiver': return t('Archivé', 'Archived');
    case 'desarchiver': return t('Désarchiver', 'Unarchive');
  }
}

/**
 * Les destinations proposées à une SÉLECTION de conversations.
 *
 * 🔴 ELLES SE DÉDUISENT DU DOSSIER, PAS DE L'ÉTAT DE CHAQUE LIGNE, et c'est la différence de fond avec le
 * menu de la conversation ouverte. Une sélection est HÉTÉROGÈNE : elle peut mêler un fil tenu par le
 * scénario et un fil déjà repris, une conversation signalée et une autre non. Un libellé qui bascule
 * (« Signalé » / « Ne plus signaler ») n'a alors aucun sens : il faudrait qu'il soit vrai des dix lignes à
 * la fois. Le dossier, lui, est le même pour toute la sélection.
 *
 * 🔴 ON NE PROPOSE QUE CE QUI SE VOIT. Chaque destination écartée ci-dessous l'est parce que le geste
 * réussirait sans que RIEN ne change à l'écran, et l'opérateur conclurait que la console est cassée :
 *   - depuis « Archivé », seul « Désarchiver » a un effet visible. Marquer « Signalé » ou « À traiter » une
 *     conversation archivée écrit bien en base, mais les deux dossiers concernés EXCLUENT les archivées :
 *     la conversation ne réapparaît nulle part ;
 *   - depuis « À traiter », « À traiter » est un aller vers l'endroit où l'on est déjà ;
 *   - depuis « Signalé », « Signalé » de même ;
 *   - depuis « Traité », « Traité » de même, et « À traiter » aussi : prendre le fil d'une conversation
 *     traitée ne la fait pas entrer dans « À traiter », que le statut exclut. C'est « Ne plus marquer
 *     traité » qui l'y rend, et seulement si le contact a écrit en dernier.
 * C'est la même règle que sur la conversation ouverte, où « À traiter » n'apparaît jamais en même temps que
 * le bouton « Rendre la main » : un menu ne propose pas deux fois le même choix, ni un choix sans effet.
 *
 * ⚠️ `avecSignalementManuel` dit si AU MOINS UNE ligne cochée porte un signalement HUMAIN. Sans lui,
 * « Ne plus signaler » apparaîtrait sur une sélection entièrement signalée par le MODÈLE, où il ne peut rien
 * faire : le constat de l'analyse n'est pas effaçable à la main, et les lignes resteraient dans le dossier.
 *
 * ⚠️ `avecTraitee` suit la même logique pour « Traité » (migration 0160) : hors du dossier « Traité »,
 * « Ne plus marquer traité » n'est proposé que si AU MOINS UNE ligne cochée l'est. « Traité », lui, est
 * proposé partout ailleurs : sur une ligne déjà traitée il ne change rien, mais il reste vrai de la
 * sélection entière, ce qui est la règle d'un menu de lot.
 *
 * ⚠️ `avecNonTraitee` dit si AU MOINS UNE ligne cochée N'EST PAS traitée. « À traiter » ne s'applique qu'à
 * celles-là (prendre le fil d'une conversation traitée ne la ferait pas entrer dans un dossier qui l'exclut),
 * et « Traité » n'a d'effet que sur elles : sur une sélection entièrement traitée, proposer l'un ou l'autre
 * serait offrir un geste inerte (revue du 2026-09-19).
 */
export function destinationsEnLot(
  dossier: DossierLike, avecSignalementManuel: boolean, avecTraitee: boolean, avecNonTraitee: boolean,
): ActionRangement[] {
  if (dossier === 'archivees') return ['desarchiver'];
  const dest: ActionRangement[] = [];
  if (dossier !== 'aTraiter' && dossier !== 'traitees' && avecNonTraitee) dest.push('a-traiter');
  if (dossier === 'traitees') {
    dest.push('ne-plus-traiter');
  } else {
    if (avecNonTraitee) dest.push('traiter');
    if (avecTraitee) dest.push('ne-plus-traiter');
  }
  if (dossier === 'signalees') {
    if (avecSignalementManuel) dest.push('ne-plus-signaler');
  } else {
    dest.push('signaler');
  }
  dest.push('archiver');
  return dest;
}
