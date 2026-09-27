/**
 * Les deux fragments SQL qui définissent un échec d'envoi de campagne (population et date), partagés par
 * tous les lecteurs pour qu'ils ne rendent pas des chiffres différents du même fait.
 * Ils supposent que `campaign_recipients` est aliasée `r` dans la requête qui les emploie.
 */

/**
 * « En échec » a deux définitions en base, n'en prendre qu'une en cacherait la moitié :
 *  - `status = 'failed'` : refus synchrone à l'envoi (le message n'est jamais parti) ;
 *  - `delivery_status = 'failed'` : échec asynchrone signalé par le webhook (`status` reste `sent`).
 */
export const RECIPIENT_FAILED_SQL = `r.status = 'failed' or r.delivery_status = 'failed'`;

/**
 * Quand l'échec a été constaté. `claimed_at` est indispensable : un refus à l'envoi n'a ni
 * `delivery_updated_at` ni `sent_at` (c'est la majorité des échecs), et sans lui l'échec sortirait de
 * toute plage de dates.
 */
export const INSTANT_ECHEC_SQL = `coalesce(r.delivery_updated_at, r.sent_at, r.claimed_at)`;
