/**
 * Les DEUX fragments SQL qui définissent un échec d'envoi de campagne : sa POPULATION et sa DATE.
 *
 * 🔴 POURQUOI UN MODULE, ET PAS UNE CONSTANTE DANS CHAQUE LECTEUR. Quatre requêtes de ce dépôt répondent à
 * « qu'est-ce qui a échoué ? » : les compteurs d'une campagne, l'auto-relance, le journal d'exploitation
 * (`/parametres`) et les statistiques (Analytics). Trois d'entre elles écrivaient le prédicat, et deux
 * écrivaient l'ancrage, chacune de son côté. C'est la définition même de trois chiffres différents du même
 * fait, et le docblock de `PgErreursLivraisonStore.lister` l'écrivait déjà noir sur blanc.
 *
 * ⚠️ Ces fragments SUPPOSENT que `campaign_recipients` est aliasée `r` dans la requête qui les emploie.
 * C'est le cas des quatre lecteurs, et c'est la même convention que `BOUNDS_CTE` (qui suppose `$2/$3/$4`)
 * ou `ORIGINE_EFFECTIVE_SQL`.
 */

/**
 * « En échec » a DEUX définitions en base, et n'en prendre qu'une en cacherait la moitié :
 *  - `status = 'failed'` est le refus SYNCHRONE à l'envoi (le message n'est jamais parti) ;
 *  - `delivery_status = 'failed'` est l'échec ASYNCHRONE signalé plus tard par le webhook (le `status`
 *    reste alors `sent`).
 */
export const RECIPIENT_FAILED_SQL = `r.status = 'failed' or r.delivery_status = 'failed'`;

/**
 * QUAND l'échec a été constaté.
 *
 * 🔴 `claimed_at` EST INDISPENSABLE, et ce n'est pas une précaution théorique : mesuré le 2026-09-07 sur la
 * base de production, **24 échecs sur 25** n'ont NI `delivery_updated_at` NI `sent_at`. C'est le cas normal
 * d'un refus à l'envoi, où rien n'a jamais été envoyé : seule la réservation du destinataire porte une date.
 * Un ancrage qui s'arrête à `coalesce(delivery_updated_at, sent_at)` rend donc `null` pour l'écrasante
 * majorité des échecs, ce qui les fait sortir de toute plage de dates et les relègue en fin de tri.
 */
export const INSTANT_ECHEC_SQL = `coalesce(r.delivery_updated_at, r.sent_at, r.claimed_at)`;
