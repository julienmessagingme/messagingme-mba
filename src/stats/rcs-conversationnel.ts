/**
 * Quels échanges RCS sont devenus conversationnels, donc facturés au tarif haut. Un RCS envoyé avec un
 * scénario devient conversationnel si le contact appuie sur un bouton ou répond et déclenche le scénario ; sans
 * réaction il reste simple. La bascule porte sur le RCS initial et tous les RCS qui suivent dans l'échange.
 *
 * Le prix d'un message change donc après son envoi. La fenêtre de sept jours le stabilise (un mois se fige une
 * semaine après sa fin), et c'est celle d'`engagementsParCampagne` : une seule règle, sinon le numérateur et le
 * dénominateur du coût par engagé divergeraient. Pas de message de service sur RCS. Module pur.
 */

/** La fenêtre de bascule, la même que celle des engagements : exportée et vérifiée par un test. */
export const FENETRE_BASCULE_MS = 7 * 24 * 60 * 60 * 1000;

/** Un envoi RCS, tel que le store le rend. `conversationId` identifie l'échange, unité de bascule. */
export interface EnvoiRcs {
  id: string;
  conversationId: string;
  /** Le numéro du contact : c'est par lui qu'une réaction se rapproche d'un envoi. */
  waId: string;
  at: string;
}

/** Une réaction du contact : un appui sur une suggestion, ou une réponse écrite. Les deux comptent pareil. */
export interface ReactionContact {
  waId: string;
  at: string;
}

/** Un horodatage illisible rend `null` plutôt que `NaN` : dans le doute, on ne majore pas le client. */
function instant(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Les échanges devenus conversationnels : ceux dont le contact a réagi dans les sept jours suivant l'un de leurs
 * envois. Rend des identifiants de conversation : l'appelant applique le tarif haut à tous les RCS de ces
 * échanges. 🔴 Le rapprochement se fait par numéro, sinon la réaction de n'importe qui ferait basculer les
 * envois de tout le monde.
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
    // Déjà basculé par un autre envoi du même échange.
    if (bascules.has(e.conversationId)) continue;
    const t = instant(e.at);
    if (t === null) continue;
    const reacts = parContact.get(e.waId);
    if (!reacts) continue;
    // Bornée des deux côtés : une réaction antérieure appartient à un échange précédent, une réaction trop
    // tardive ne doit plus changer un total déjà lu.
    if (reacts.some((r) => r >= t && r < t + FENETRE_BASCULE_MS)) bascules.add(e.conversationId);
  }
  return bascules;
}
