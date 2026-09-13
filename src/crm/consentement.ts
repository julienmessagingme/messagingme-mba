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
 * peux pas m'arrêter là » ou « c'est du non-stop ». Un faux positif ici coûte un contact désabonné qui ne l'a
 * pas demandé, et personne ne s'en aperçoit : il cesse simplement de recevoir. La forme ancrée est aussi celle
 * que les opérateurs et Meta attendent.
 *
 * 🔴 CE DOCBLOCK A CITÉ « arrêt de bus » COMME UN CAS ÉVITÉ, ET C'ÉTAIT FAUX : cette phrase COMMENCE par
 * « arrêt », donc l'ancrage ne la protège pas. Mesuré le 2026-09-13, la règle actuelle désabonne aussi
 * « arrêt maladie », « arrêt du traitement », « stop covid » et « stopper la commande ». Sur un espace
 * d'assureur, « arrêt maladie » est un message ORDINAIRE, et la personne cesserait de recevoir sans que
 * quiconque le sache. La règle n'est PAS modifiée ici : resserrer l'ancrage (exiger que le mot-clé soit
 * seul, ou suivi d'une ponctuation) ferait perdre « stop merci », qui est un vrai refus. C'est un arbitrage
 * produit, posé à Julien, et `tests/consentement-observation.test.ts` fige le comportement ACTUEL pour que
 * rien ne bouge par accident en attendant.
 *
 * La contrepartie est assumée : « je voudrais me désabonner » n'est PAS reconnu. Ce cas-là reste traité par
 * un humain dans l'inbox, ou par une automation à mot-clé que le client câble lui-même. Élargir se déciderait
 * au vu de vrais messages reçus, pas au jugé.
 */
export function estDemandeArret(texte: string | null): boolean {
  if (!texte) return false;
  return /^\s*(stop|stopper|unsubscribe|desabonner|désabonner|arret|arrêt)\b/i.test(texte.trim());
}

/**
 * LA RÈGLE ÉLARGIE, ET ELLE NE DÉSABONNE PERSONNE.
 *
 * 🔴 C'EST UNE OBSERVATION, PAS UNE DÉCISION, et la nuance est tout le sujet. Mesure du 2026-09-13 sur la
 * base de production : sur 135 messages entrants porteurs de texte, ZÉRO reconnu par la règle ancrée, et
 * ZÉRO par une règle élargie candidate. Il n'y a donc RIEN sur quoi calibrer aujourd'hui, et élargir au
 * jugé est exactement ce que le docblock d'`estDemandeArret` déconseille.
 *
 * La sortie est d'instrumenter d'abord et de décider ensuite : cette règle-ci REMONTE les messages qu'elle
 * aurait attrapés, dans l'écran Consentement, sans rien écrire. Au bout de quelques semaines de vrais
 * messages, on saura ce qu'elle attrape et ce qu'elle attrape à tort. **La décision est reportée, pas
 * esquivée : ce qui est construit ici est ce qui permettra de la prendre.**
 *
 * ⚠️ ELLE N'EST PAS ANCRÉE EN DÉBUT DE MESSAGE, contrairement à la règle qui agit, et c'est précisément
 * pour cela qu'elle ne peut pas agir : « je ne peux pas m'arrêter de vous lire » la déclencherait. Un faux
 * positif qui REMONTE une ligne à lire ne coûte rien ; le même faux positif qui DÉSABONNE coûte un client
 * qui cesse de recevoir sans que personne ne s'en aperçoive.
 */
export function estPeutEtreUnArret(texte: string | null): boolean {
  if (!texte) return false;
  const t = texte.trim().toLowerCase();
  if (t === '') return false;
  return [
    /d[eé]sabonn/,
    /unsubscribe/,
    /ne (plus|jamais) (me |m.)?(envoyer|ecrire|écrire|contacter|recevoir)/,
    // « ne m'envoyez plus », « ne me contactez jamais » : le français met le verbe AVANT « plus ».
    /ne (me |m.)?(envoyez|ecrivez|écrivez|contactez|sollicitez)\w* (plus|jamais|rien)/,
    /(plus|jamais) de (message|sms|pub|publicit)/,
    /arr[eê]tez? de (me |m.)?(parler|contacter|envoyer|[eé]crire|solliciter)/,
    /(retirez|supprimez|enlevez)[ -](moi|mon num)/,
    /(remove|delete) me/,
    /stop (me |sending|messages)/,
    /laissez[ -]moi tranquille/,
    /je (ne )?(veux|souhaite) (plus|pas) (de |recevoir|être|etre)/,
  ].some((r) => r.test(t));
}

/** Ce qu'un message entrant dit du consentement. */
export type VerdictArret = 'arret' | 'peut_etre' | 'non';

/**
 * LE VERDICT, ET IL Y EN A TROIS, PAS DEUX.
 *
 * 🔴 `peut_etre` N'EST PAS UN `arret` FAIBLE : c'est une ligne à faire lire par un humain, et rien de plus.
 * Confondre les deux ferait basculer l'observation en désabonnement automatique le jour d'une distraction,
 * sur une règle que PERSONNE n'a calibrée faute de données.
 *
 * ⚠️ La règle ANCRÉE gagne toujours : un message qui commence par « stop » est un arrêt, même s'il contient
 * par ailleurs une formule que la règle élargie reconnaîtrait.
 */
export function classerDemandeArret(texte: string | null): VerdictArret {
  if (estDemandeArret(texte)) return 'arret';
  return estPeutEtreUnArret(texte) ? 'peut_etre' : 'non';
}

/** La valeur écrite dans `contacts.opt_in_source` quand le refus vient d'un message WhatsApp entrant. */
export const SOURCE_STOP_WHATSAPP = 'whatsapp_stop';
