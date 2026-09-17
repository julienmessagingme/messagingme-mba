/**
 * QUELS ECHANGES RCS SONT DEVENUS CONVERSATIONNELS, donc factures au tarif haut.
 *
 * 🔴 LA REGLE, MOT POUR MOT DE JULIEN (2026-09-17). « Un RCS non conversationnel c'est un RCS seul et pas
 * associe a un scenario. Si un RCS est envoye avec un scenario, si le client appuie sur un bouton ou repond
 * et declenche le scenario ca devient un RCS conversationnel. Si le client n'appuie sur rien, cela reste un
 * RCS non conversationnel. » Et sur ce qui bascule : « le RCS initial ET tous les messages qui suivent et
 * qui sont envoyes sur RCS ».
 *
 * 🔴 CONSEQUENCE A ASSUMER : LE PRIX D'UN MESSAGE CHANGE APRES SON ENVOI. C'est le seul endroit du produit
 * ou un cout passe est mouvant. La borne de sept jours est ce qui le stabilise : un mois se fige
 * definitivement une semaine apres sa fin. Sans elle, le total de janvier pourrait encore bouger en juillet
 * et personne ne saurait pourquoi.
 *
 * 🔴 ET LA BORNE N'EST PAS UN NOMBRE CHOISI ICI : c'est celle d'`engagementsParCampagne`
 * (`src/stats/store.pg.ts`), reprise a l'identique. Une SEULE regle sert donc les deux ecrans du meme
 * onglet. Deux fenetres differentes feraient diverger le numerateur et le denominateur du cout par engage,
 * sans qu'aucun ecran ne puisse le signaler.
 *
 * ⚠️ PAS DE MESSAGE DE SERVICE SUR RCS, contrairement a WhatsApp : tout y est au tarif RCS. Ne pas recopier
 * la mecanique de franchise ici, elle n'a pas de sens sur ce canal.
 *
 * Module PUR : aucune base, aucun reseau.
 */

/**
 * La fenetre de bascule. LA MEME que celle des engagements, et ce n'est pas une coincidence a preserver a
 * la main : c'est la raison pour laquelle cette constante est exportee et verifiee par un test.
 */
export const FENETRE_BASCULE_MS = 7 * 24 * 60 * 60 * 1000;

/** Un envoi RCS, tel que le store le rend. `conversationId` identifie l'ECHANGE, qui est l'unite de bascule. */
export interface EnvoiRcs {
  id: string;
  conversationId: string;
  /** Le numero du contact : c'est par lui qu'une reaction se rapproche d'un envoi. */
  waId: string;
  at: string;
}

/** Une reaction du contact : un appui sur une suggestion, ou une reponse ecrite. Les deux comptent pareil. */
export interface ReactionContact {
  waId: string;
  at: string;
}

/** Un horodatage illisible rend `null` plutot que `NaN` : dans le doute on ne majore pas le client. */
function instant(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Les ECHANGES devenus conversationnels : ceux dont le contact a reagi dans les sept jours suivant l'un de
 * leurs envois.
 *
 * ⚠️ REND DES IDENTIFIANTS DE CONVERSATION, PAS DE MESSAGE, et c'est la traduction directe de la regle :
 * la bascule porte sur l'echange entier. L'appelant applique donc le tarif haut a TOUS les RCS de ces
 * echanges, pas au seul message qui a declenche.
 *
 * ⚠️ LE RAPPROCHEMENT SE FAIT PAR NUMERO, et l'oublier serait la faute la plus couteuse de ce module :
 * sans lui, la reaction de n'importe qui ferait basculer les envois de tout le monde.
 */
export function basculesRcs(envois: readonly EnvoiRcs[], reactions: readonly ReactionContact[]): Set<string> {
  const parContact = new Map<string, number[]>();
  for (const r of reactions) {
    const t = instant(r.at);
    if (t === null) continue;
    const l = parContact.get(r.waId);
    if (l) l.push(t); else parContact.set(r.waId, [t]);
  }

  const bascules = new Set<string>();
  for (const e of envois) {
    // Deja bascule par un autre envoi du meme echange : rien a regarder de plus.
    if (bascules.has(e.conversationId)) continue;
    const t = instant(e.at);
    if (t === null) continue;
    const reacts = parContact.get(e.waId);
    if (!reacts) continue;
    // Bornee des DEUX cotes : une reaction anterieure appartient a un echange precedent, une reaction trop
    // tardive ne doit plus rien changer a un total deja lu.
    if (reacts.some((r) => r >= t && r < t + FENETRE_BASCULE_MS)) bascules.add(e.conversationId);
  }
  return bascules;
}
