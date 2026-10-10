import { texteDe } from '../lib/erreur';
import type { Issue } from '../lib/issue';
import type { PgAbonnementsNumeroStore } from '../stripe/abonnements.pg';

export interface DepsFinDuNumero {
  abonnements: Pick<PgAbonnementsNumeroStore, 'deLEspace' | 'noterFinPrevue'>;
  /** La fin programmée chez Stripe à la fin de la période payée (`programmerFinDuNumero`, `src/stripe/abonnement.ts`). */
  programmerFin(abonnementId: string): Promise<Issue<true>>;
  /** Prévenir Julien qu'un abonnement continue : à résilier à la main en fin de période. Ne lève jamais. */
  finNonProgrammee(abonnementId: string, tenantId: string): Promise<void>;
}

/**
 * La fin de l'abonnement du numéro de l'espace, à la fin de la période payée, sans remboursement. Deux gestes la
 * demandent : « Abandonner » (lot 4, B, `src/http/numero-fourni.ts`) et « Déconnecter le numéro »
 * (`src/account/deconnexion-numero.ts`). La fin se note tout de suite chez nous, sans attendre le webhook : l'espace ne
 * compte plus parmi les abonnés qui attendent un numéro. Un refus de Stripe prévient Julien, qui résilie à la main.
 *
 * `aucun` : pas d'abonnement vivant (un numéro inclus dans le Pro, un abonnement déjà résilié). Ne lève pas.
 */
export async function programmerLaFinDuNumero(d: DepsFinDuNumero, tenantId: string): Promise<'programmee' | 'aucun' | 'echec'> {
  try {
    const a = await d.abonnements.deLEspace(tenantId);
    if (a === null || a.statut === 'resilie') return 'aucun';
    const r = await d.programmerFin(a.abonnementId);
    if (!r.ok) {
      await d.finNonProgrammee(a.abonnementId, tenantId);
      return 'echec';
    }
    await d.abonnements.noterFinPrevue(a.abonnementId, a.periodeFin ?? new Date());
    return 'programmee';
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`numero : la fin de l'abonnement n'a pas pu être programmée : ${texteDe(err)}`);
    return 'echec';
  }
}
