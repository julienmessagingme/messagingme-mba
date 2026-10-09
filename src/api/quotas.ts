import type { Comptage, CompteurDebit } from '../db/debit';
import { addDays, zonedMidnightEpochSec } from '../stats/range';
import type { OperationApi } from './usage-guard';

/**
 * LES QUOTAS QUOTIDIENS DE L'API PUBLIQUE, PAR ESPACE (décision de Julien du 2026-10-04,
 * `docs/ARCHITECTURE-CIBLE.md` § 13.1).
 *
 * Le plafond d'appels (60 par minute, 1 000 par heure) protège l'infrastructure, pas les destinataires : sous lui, une
 * boucle chez un intégrateur pouvait viser 50 000 destinataires par heure (1 000 appels de 50), de quoi abîmer la note
 * de qualité d'un numéro chez Meta. Le quota compte le TRAVAIL d'un jour, deux familles :
 * - **les envois** : les destinataires d'un envoi (`/v1/sends`) et chaque message libre (WhatsApp ou RCS) ;
 * - **les fiches** : chaque fiche écrite (`/v1/contacts`, une par fiche d'un lot).
 * Les lectures, les catalogues et le MCP n'en ont pas, sauf l'envoi d'un modèle par le MCP (`send_template_to_contact`),
 * compté dans les envois : le plafond d'appels leur suffit. Les campagnes lancées depuis
 * la console ne passent pas par ici.
 *
 * Le jour est le jour CIVIL de Paris : remise à zéro à minuit, heure de Paris, changement d'heure compris. Un lot qui
 * dépasserait le quota est refusé EN ENTIER (le compteur compte tout ou rien) : jamais la moitié d'un envoi.
 *
 * ⚠️ Limite connue : la date de la clé vient de l'horloge de la copie, la position de la fenêtre de celle de la base.
 * Dans les quelques millisecondes d'écart autour de minuit, un appel peut tomber sur une ligne neuve et n'être compté
 * nulle part. Sans conséquence avec des horloges synchronisées (NTP) : un appel, une fois par jour, au pire.
 */

export type FamilleQuota = 'envois' | 'fiches';

/**
 * Les valeurs décidées le 2026-10-04 : la configuration les reprend comme défauts (`API_QUOTA_ENVOIS_JOUR`,
 * `API_QUOTA_FICHES_JOUR`), et la documentation publique les affiche (`BORNES`, tenues égales par
 * `tests/api-exemples.test.ts`).
 */
export const QUOTAS_API_DEFAUT = { envois: 2000, fiches: 20000 } as const;

/** Les quotas en vigueur, de la configuration. `0` = pas de quota. */
export interface QuotasParDefaut {
  readonly envois: number;
  readonly fiches: number;
}

/** La famille d'une opération, ou `null` pour une opération que le quota ne regarde pas. */
export function familleDe(operation: OperationApi): FamilleQuota | null {
  if (operation === 'sends.create' || operation === 'messages.send') return 'envois';
  if (operation === 'contacts.batch' || operation === 'contacts.upsert') return 'fiches';
  return null;
}

/** Le jour civil de Paris qui contient `instantMs` (`YYYY-MM-DD`). */
export function jourDeParis(instantMs: number): string {
  return new Date(instantMs).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
}

/** Le début et la fin du jour civil de Paris, en millisecondes : 23, 24 ou 25 heures selon le changement d'heure. */
export function bornesDuJour(jour: string): { debutMs: number; finMs: number } {
  return { debutMs: zonedMidnightEpochSec(jour) * 1000, finMs: zonedMidnightEpochSec(addDays(jour, 1)) * 1000 };
}

/**
 * Le comptage du quota d'une famille, pour un espace et un instant. La clé porte le jour : chaque jour a sa ligne, et
 * la fenêtre (origine au minuit de Paris, durée de CE jour) finit pile au minuit suivant.
 */
export function comptageQuota(famille: FamilleQuota, tenantId: string, max: number, unites: number, instantMs: number): Comptage {
  const jour = jourDeParis(instantMs);
  const { debutMs, finMs } = bornesDuJour(jour);
  return { cle: `quota.${famille}|${tenantId}|${jour}`, dureeMs: finMs - debutMs, origineMs: debutMs, max, pas: unites };
}

/** Ce qu'un espace a consommé de ses quotas aujourd'hui, et quand ils repartent : ce que `/ops` montre. */
export interface ConsommationDuJour {
  readonly jour: string;
  readonly envois: number;
  readonly fiches: number;
  /** Le minuit de Paris suivant, en ISO 8601. */
  readonly remiseAZero: string;
}

/**
 * La consommation du jour, lue dans le compteur partagé sous les MÊMES clés que `comptageQuota` les écrit : une seule
 * fabrique de clé, sinon l'écran lirait une ligne que personne n'écrit et afficherait zéro sans erreur. Lit, ne
 * décide rien. Lève si le compteur ne répond pas : à l'appelant de dire « inconnue » plutôt que zéro.
 */
export async function consommationDuJour(
  compteur: Pick<CompteurDebit, 'lister'>,
  tenantId: string,
  instantMs: number,
): Promise<ConsommationDuJour> {
  const lire = async (famille: FamilleQuota): Promise<{ n: number; c: Comptage }> => {
    const c = comptageQuota(famille, tenantId, 1, 1, instantMs);
    // Une heure de marge sur la fenêtre : `lister` la compare à l'horloge de la base, pas à celle de la copie.
    const lignes = await compteur.lister(c.cle, c.dureeMs + 3_600_000);
    // `lister` cherche par PRÉFIXE : on ne garde que la clé exacte.
    return { n: lignes.filter((l) => l.cle === c.cle).reduce((s, l) => s + l.n, 0), c };
  };
  const [envois, fiches] = await Promise.all([lire('envois'), lire('fiches')]);
  return {
    jour: jourDeParis(instantMs),
    envois: envois.n,
    fiches: fiches.n,
    remiseAZero: new Date((envois.c.origineMs ?? 0) + envois.c.dureeMs).toISOString(),
  };
}

/** Ce que dit un refus : le quota, ce qu'il compte, et quand il revient. Écrit pour l'intégrateur, pas pour nous. */
export function raisonDuRefus(famille: FamilleQuota, max: number): string {
  const quoi = famille === 'envois' ? 'envois (destinataires et messages)' : 'fiches écrites';
  return `quota quotidien de cet espace atteint, ou dépassé par cette requête : ${max} ${quoi} par jour, `
    + 'remise à zéro à minuit (heure de Paris). Un lot plus petit peut encore passer ; pour relever le quota, écrivez-nous.';
}
