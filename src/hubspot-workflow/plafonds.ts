import type { Comptage, CompteurDebit } from '../db/debit';
import { bornesDuJour, jourDeParis } from '../api/quotas';
import { journaliser } from '../lib/journal';

/**
 * LES DEUX PLAFONDS DE L'ACTION DE WORKFLOW (décision 9 du cadrage du 2026-10-27), par espace, au total des copies, à
 * part de ceux de l'API. Comptés ENSEMBLE, en un seul appel au compteur : toutes les fenêtres ou aucune
 * (`src/db/debit.ts`), donc une tentative refusée par le jour n'use pas la minute. Le jour est celui de Paris, comme les
 * quotas de l'offre : il repart à minuit, heure de Paris.
 *
 * Ce qu'ils comptent : les TENTATIVES qui ont passé les gardes de la route et pris leur clé (le cœur appelle le compteur
 * juste après la clé), refus du cœur compris (contact STOP ou bloqué, numéro délié). Un rejeu ou un envoi déjà fait dans
 * les 24 h ne comptent pas.
 */
export type VerdictPlafonds =
  | { readonly accepte: true }
  | { readonly accepte: false; readonly fenetre: 'minute' | 'jour'; readonly attenteMs: number };

export interface OptionsPlafonds {
  /** Par minute ; 0 désactive. */
  readonly parMinute: number;
  /** Par jour de Paris ; 0 désactive. */
  readonly parJour: number;
  readonly maintenant?: () => number;
}

const PREFIXE_MINUTE = 'hubspot.workflows.minute';
const PREFIXE_JOUR = 'hubspot.workflows.jour';
/** L'attente conseillée quand la base n'a pas répondu (le refus n'arrive alors que d'une base qui refuse tout). */
const ATTENTE_PAR_DEFAUT_MS = 5_000;

export function plafondsDesWorkflows(compteur: CompteurDebit, o: OptionsPlafonds): (tenantId: string) => Promise<VerdictPlafonds> {
  const maintenant = o.maintenant ?? (() => Date.now());
  let dernierAvertissement = Number.NEGATIVE_INFINITY;
  return async (tenantId) => {
    const comptages: Comptage[] = [];
    if (o.parMinute > 0) comptages.push({ cle: `${PREFIXE_MINUTE}|${tenantId}`, dureeMs: 60_000, max: o.parMinute });
    if (o.parJour > 0) {
      const jour = jourDeParis(maintenant());
      const { debutMs, finMs } = bornesDuJour(jour);
      comptages.push({ cle: `${PREFIXE_JOUR}|${tenantId}|${jour}`, dureeMs: finMs - debutMs, origineMs: debutMs, max: o.parJour });
    }
    if (comptages.length === 0) return { accepte: true };
    try {
      const v = await compteur.compter(comptages);
      if (v.accepte) return { accepte: true };
      // Le jour l'emporte : une relance dans la minute ne servirait à rien, le refus doit se lire dans l'historique.
      const jour = v.fenetres.find((f) => f.pleine && f.cle.startsWith(PREFIXE_JOUR));
      if (jour) return { accepte: false, fenetre: 'jour', attenteMs: Math.max(0, jour.finMs - v.maintenantMs) };
      const minute = v.fenetres.find((f) => f.pleine);
      return { accepte: false, fenetre: 'minute', attenteMs: minute ? Math.max(0, minute.finMs - v.maintenantMs) : ATTENTE_PAR_DEFAUT_MS };
    } catch (err) {
      // Base muette : laisse passer, comme les autres plafonds de HubSpot. L'envoi lui-même a besoin de la base (la clé),
      // il ne part pas sans elle. Un avertissement par minute au plus.
      const t = maintenant();
      if (t - dernierAvertissement >= 60_000) {
        dernierAvertissement = t;
        journaliser('error', 'plafond_partage_indisponible', { plafond: 'hubspot.workflows', siLaBaseEchoue: 'laisser-passer', err });
      }
      return { accepte: true };
    }
  };
}
