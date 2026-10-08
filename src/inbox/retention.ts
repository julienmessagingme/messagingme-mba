/**
 * Combien de temps les conversations d'un espace se gardent réellement : la règle a deux niveaux, et l'écran
 * comme la purge doivent annoncer la même durée.
 *
 * 🔴 Les deux zéros ne disent pas la même chose : `0` au niveau de l'instance est le levier d'urgence qui
 * arrête la purge partout, y compris chez les espaces qui ont choisi leur durée ; `0` au niveau d'un espace
 * ne désactive que lui.
 *
 * La purge, une seule instruction SQL pour tous les espaces, porte la même règle en `coalesce` et ne peut pas
 * appeler cette fonction : un test relit les deux. Module pur.
 */

import { DROITS, GRACE_RETOUR_BASE_JOURS } from '../offres/offres';

/**
 * Depuis quand l'espace `t` (alias de `tenants`) est en Base, en SQL : sa création, la fin de son dernier Pro, ou sa
 * sortie de l'Entreprise (migration 0221), la plus récente. `greatest` ignore les `null`. Un seul texte, lu par la purge
 * et par l'écran de synthèse (`src/stats/conversation-stats.pg.ts`) : les deux disent la même durée.
 */
export const BASE_DEPUIS_SQL = `greatest(t.created_at, t.entreprise_quittee_le,
  (select max(a.fini_le) from abonnements_offre a where a.tenant_id = t.id))`;

/**
 * 🔴 LA DURÉE DE CONSERVATION DE L'ESPACE `t` (alias de `tenants`), EN SQL : la règle de `retentionEffective`, en un seul
 * texte, lu par la purge (`PgInboxStore.purgeConversationsOlderThan`) et par les coûts de la synthèse
 * (`hors_retention`, `src/stats/store.pg.ts`) : deux définitions de « purgé » divergeraient au premier réglage changé (J3
 * de la relecture de C). `ts` est sa ligne de réglages (une jointure externe : nulle pour un espace sans réglage). Les
 * trois paramètres nomment leur numéro : le défaut de l'instance, la grâce et la durée de la Base, ces deux-là passés
 * depuis la grille (`GRACE_RETOUR_BASE_JOURS`, `DROITS.base.limites.conservationJours`), jamais écrits ici.
 */
export const dureeConservationSql = (p: { instance: string; grace: string; base: string }): string => `case
    when offre_de_l_espace(t.id) = 'base' and ${BASE_DEPUIS_SQL} <= now() - make_interval(days => ${p.grace}::int)
      then case when ts.conversation_retention_days > 0 then least(ts.conversation_retention_days, ${p.base}::int)
                else ${p.base}::int end
    else coalesce(ts.conversation_retention_days, ${p.instance}::int)
  end`;

/**
 * La durée réellement appliquée à un espace, en jours. `0` veut dire « jamais purgé ».
 *
 * 🔴 LOT 6, C : en Base, 30 jours (la grille), mais seulement une fois passés `GRACE_RETOUR_BASE_JOURS` après l'entrée
 * en Base. Avant, la règle d'avant (le réglage de l'espace, sinon le défaut) : changer d'offre ne purge jamais sur le
 * coup. Hors Base, rien ne change. Un réglage PLUS COURT que la Base reste respecté (J5 de la relecture : le
 * responsable de traitement a choisi de garder moins) ; « jamais » ou plus long ne dépasse pas la Base.
 *
 * @param instance le defaut de l'instance (`CONVERSATION_RETENTION_DAYS`)
 * @param espace   ce que l'espace a regle, ou `null` s'il n'a rien regle
 * @param base     l'espace est en Base, depuis cette date (`BASE_DEPUIS_SQL`) ; `null` hors Base
 */
export function retentionEffective(
  instance: number, espace: number | null, base: { depuis: Date } | null, maintenant: Date = new Date(),
): number {
  // Le levier d'urgence d'abord : il gagne sur tout, y compris sur un espace qui a choisi une duree.
  if (!(instance > 0)) return 0;
  if (base !== null && maintenant.getTime() >= base.depuis.getTime() + GRACE_RETOUR_BASE_JOURS * 24 * 3_600_000) {
    const plafond = DROITS.base.limites.conservationJours;
    return espace !== null && espace > 0 ? Math.min(Math.floor(espace), plafond) : plafond;
  }
  if (espace === null) return Math.floor(instance);
  // Une valeur négative est impossible en base (CHECK), mais on borne quand même l'affichage.
  return espace > 0 ? Math.floor(espace) : 0;
}
