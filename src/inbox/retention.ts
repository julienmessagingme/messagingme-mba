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

import { DROITS, GRACE_RETOUR_BASE_JOURS, type Offre } from '../offres/offres';

/**
 * Depuis quand l'espace `t` (alias de `tenants`) est en Base, en SQL : sa création, la fin de son dernier Pro, ou sa
 * sortie de l'Entreprise (migration 0221), la plus récente. `greatest` ignore les `null`. Un seul texte, lu par la purge
 * et par l'écran de synthèse (`src/stats/conversation-stats.pg.ts`) : les deux disent la même durée.
 */
export const BASE_DEPUIS_SQL = `greatest(t.created_at, t.entreprise_quittee_le,
  (select max(a.fini_le) from abonnements_offre a where a.tenant_id = t.id))`;

/**
 * Depuis quand l'espace `t` est dans son offre « par le haut », en SQL (spec Business, 2026-10-27) : la date d'où court la
 * grâce d'une conservation plus courte. La Free : son entrée en Base (`BASE_DEPUIS_SQL`). Le Pro : sa sortie du Business
 * ou de l'Entreprise, la plus récente. Le Business : sa sortie de l'Entreprise. `null` = jamais descendu : la grille
 * s'applique tout de suite (on n'y arrive alors que par le bas, avec une conservation plus courte que la sienne).
 * `offre` est le texte SQL de l'offre de l'espace.
 */
export const descenteDepuisSql = (offre: string): string => `case ${offre}
      when 'base' then ${BASE_DEPUIS_SQL}
      when 'pro' then greatest(t.entreprise_quittee_le, t.business_quitte_le)
      when 'business' then t.entreprise_quittee_le
    end`;

/**
 * 🔴 LA DURÉE DE CONSERVATION DE L'ESPACE `t` (alias de `tenants`), EN SQL : la règle de `retentionEffective`, en un seul
 * texte, lu par la purge (`PgInboxStore.purgeConversationsOlderThan`) et par les coûts de la synthèse
 * (`hors_retention`, `src/stats/store.pg.ts`) : deux définitions de « purgé » divergeraient au premier réglage changé (J3
 * de la relecture de C). `ts` est sa ligne de réglages (une jointure externe : nulle pour un espace sans réglage). Les
 * paramètres nomment leur numéro : le défaut de l'instance, la grâce et les durées de la Free, du Pro et du Business,
 * passées depuis la grille (`GRACE_RETOUR_BASE_JOURS`, `DROITS.<offre>.limites.conservationJours`), jamais écrites ici.
 * Depuis le 2026-10-27 (spec Business), la grille vaut pour la Free, le Pro et le Business, chacun depuis sa descente
 * (`descenteDepuisSql`) : avant, hors Free, la purge ne lisait que le réglage de l'espace ou le défaut de l'instance.
 */
export const dureeConservationSql = (p: { instance: string; grace: string; base: string; pro: string; business: string }): string => {
  const offre = 'offre_de_l_espace(t.id)';
  const grille = `case ${offre} when 'base' then ${p.base}::int when 'pro' then ${p.pro}::int else ${p.business}::int end`;
  return `case
    when ${offre} in ('base', 'pro', 'business')
         and coalesce(${descenteDepuisSql(offre)}, '-infinity'::timestamptz) <= now() - make_interval(days => ${p.grace}::int)
      then case when ts.conversation_retention_days > 0 then least(ts.conversation_retention_days, ${grille}) else ${grille} end
    else coalesce(ts.conversation_retention_days, ${p.instance}::int)
  end`;
};

/** Les offres dont la conservation est celle de la grille, une fois la grâce passée (l'Entreprise se règle dans /ops). */
const CONSERVATION_DE_GRILLE: ReadonlySet<Offre> = new Set<Offre>(['base', 'pro', 'business']);

/**
 * La durée réellement appliquée à un espace, en jours. `0` veut dire « jamais purgé ».
 *
 * 🔴 LOT 6, C, ÉTENDU LE 2026-10-27 (spec Business) : en Free, en Pro et en Business, la durée de la grille, mais
 * seulement une fois passés `GRACE_RETOUR_BASE_JOURS` après la descente dans l'offre (`descenteDepuisSql`). Avant, la
 * règle d'avant (le réglage de l'espace, sinon le défaut) : changer d'offre ne purge jamais sur le coup. L'Entreprise
 * garde son réglage. Un réglage PLUS COURT que la grille reste respecté (J5 de la relecture : le responsable de
 * traitement a choisi de garder moins) ; « jamais » ou plus long ne dépasse pas la grille.
 *
 * @param instance le defaut de l'instance (`CONVERSATION_RETENTION_DAYS`)
 * @param espace   ce que l'espace a regle, ou `null` s'il n'a rien regle
 * @param offre    l'offre de l'espace et sa descente (`descenteDepuisSql`, `null` = jamais descendu) ; `null` inconnue
 */
export function retentionEffective(
  instance: number, espace: number | null, offre: { nom: Offre; descenteLe: Date | null } | null, maintenant: Date = new Date(),
): number {
  // Le levier d'urgence d'abord : il gagne sur tout, y compris sur un espace qui a choisi une duree.
  if (!(instance > 0)) return 0;
  const graceFinie = offre !== null
    && (offre.descenteLe === null || maintenant.getTime() >= offre.descenteLe.getTime() + GRACE_RETOUR_BASE_JOURS * 24 * 3_600_000);
  if (offre !== null && CONSERVATION_DE_GRILLE.has(offre.nom) && graceFinie) {
    const plafond = DROITS[offre.nom].limites.conservationJours;
    return espace !== null && espace > 0 ? Math.min(Math.floor(espace), plafond) : plafond;
  }
  if (espace === null) return Math.floor(instance);
  // Une valeur négative est impossible en base (CHECK), mais on borne quand même l'affichage.
  return espace > 0 ? Math.floor(espace) : 0;
}
