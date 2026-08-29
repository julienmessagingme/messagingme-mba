/**
 * Le CONSENTEMENT d'un contact, côté reconnaissance : « est-ce que cette personne demande à ne plus rien
 * recevoir ? ».
 *
 * 🔴 POURQUOI CE MODULE EXISTE, ET POURQUOI IL N'EST PAS DANS `rcs/`. Ce prédicat vivait dans le callback RCS,
 * et il n'y servait qu'au RCS. Résultat, mesuré le 2026-08-29 : un contact qui écrivait STOP **en RCS** était
 * désabonné automatiquement, et le même contact écrivant STOP **en WhatsApp** restait `opted_in`, donc
 * destinataire de la campagne suivante. Le canal principal du produit était le seul sans opt-out par mot-clé.
 *
 * L'asymétrie ne venait pas d'une décision : elle venait de l'endroit où la fonction avait été écrite. Elle
 * vit donc ici, à côté de l'écriture qu'elle commande (`setOptInByWaId`), et les deux canaux l'importent.
 *
 * ⚠️ Ce n'est PAS le seul chemin d'opt-out, et ce n'en est même pas le principal : la fiche contact, l'action
 * en masse du mini-CRM et le bloc « Action » d'un scénario écrivent tous `opted_out`. Celui-ci est le seul qui
 * ne demande RIEN à l'opérateur, et c'est ce qui en fait un sujet de conformité plutôt que de confort : on ne
 * peut pas faire dépendre le respect d'un refus de ce que chaque client aura pensé à câbler.
 */

/**
 * Le message demande-t-il l'arrêt des envois ?
 *
 * ⚠️ ANCRÉ EN DÉBUT DE MESSAGE, et c'est délibéré. « stop » n'importe où dans une phrase attraperait « je ne
 * peux pas m'arrêter là », « arrêt de bus », « non-stop ». Un faux positif ici coûte un contact désabonné qui
 * ne l'a pas demandé, et personne ne s'en aperçoit : il cesse simplement de recevoir. La forme ancrée est
 * aussi celle que les opérateurs et Meta attendent.
 *
 * La contrepartie est assumée : « je voudrais me désabonner » n'est PAS reconnu. Ce cas-là reste traité par
 * un humain dans l'inbox, ou par une automation à mot-clé que le client câble lui-même. Élargir se déciderait
 * au vu de vrais messages reçus, pas au jugé.
 */
export function estDemandeArret(texte: string | null): boolean {
  if (!texte) return false;
  return /^\s*(stop|stopper|unsubscribe|desabonner|désabonner|arret|arrêt)\b/i.test(texte.trim());
}

/** La valeur écrite dans `contacts.opt_in_source` quand le refus vient d'un message WhatsApp entrant. */
export const SOURCE_STOP_WHATSAPP = 'whatsapp_stop';
