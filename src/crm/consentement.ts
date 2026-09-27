/**
 * Le consentement d'un contact, côté reconnaissance : « cette personne demande-t-elle à ne plus rien recevoir ? ».
 * Vit ici, à côté de l'écriture qu'il commande (`setOptInByWaId`), pour que WhatsApp et RCS l'appliquent pareil.
 *
 * 🔴 Ce n'est pas le seul chemin d'opt-out (fiche contact, action en masse, bloc « Action » d'un scénario),
 * mais c'est le seul qui ne demande rien à l'opérateur : le respect d'un refus ne peut pas dépendre de ce que
 * chaque client aura pensé à câbler.
 */

/**
 * Le message demande-t-il l'arrêt des envois ? Ancré en début de message : « stop » n'importe où attraperait
 * « c'est du non-stop », et un faux positif désabonne en silence. L'ancrage ne protège pas tout : « arrêt
 * maladie » ou « stopper la commande » désabonnent aussi ; le resserrer ferait perdre « stop merci », un vrai
 * refus. Arbitrage produit en attente, comportement figé par `tests/consentement-observation.test.ts`.
 * « Je voudrais me désabonner » n'est pas reconnu : un humain ou une automation du client s'en charge.
 */
export function estDemandeArret(texte: string | null): boolean {
  if (!texte) return false;
  return /^\s*(stop|stopper|unsubscribe|desabonner|désabonner|arret|arrêt)\b/i.test(texte.trim());
}

/**
 * La règle élargie, qui ne désabonne personne : une observation, pas une décision. Elle remonte dans l'écran
 * Consentement les messages qu'elle aurait attrapés, sans rien écrire, pour calibrer sur de vrais messages.
 * Non ancrée, elle ne peut pas agir : un faux positif qui remonte une ligne ne coûte rien, le même qui
 * désabonne coûte un contact qui cesse de recevoir sans que personne le voie.
 */
export function estPeutEtreUnArret(texte: string | null): boolean {
  if (!texte) return false;
  const t = texte.trim().toLowerCase();
  if (t === '') return false;
  return [
    /d[eé]sabonn/,
    /unsubscribe/,
    /ne (plus|jamais) (me |m.)?(envoyer|ecrire|écrire|contacter|recevoir)/,
    // « ne m'envoyez plus », « ne me contactez jamais » : le français met le verbe avant « plus ».
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
 * Le verdict, en trois valeurs. 🔴 `peut_etre` n'est pas un `arret` faible : une ligne à faire lire par un
 * humain, rien de plus ; les confondre désabonnerait sur une règle jamais calibrée. La règle ancrée gagne
 * toujours : un message qui commence par « stop » est un arrêt.
 */
export function classerDemandeArret(texte: string | null): VerdictArret {
  if (estDemandeArret(texte)) return 'arret';
  return estPeutEtreUnArret(texte) ? 'peut_etre' : 'non';
}

/** La valeur écrite dans `contacts.opt_in_source` quand le refus vient d'un message WhatsApp entrant. */
export const SOURCE_STOP_WHATSAPP = 'whatsapp_stop';
