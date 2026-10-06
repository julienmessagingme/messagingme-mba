import type { AvisAbonnement, EtatDeLEspace } from '../stripe/abonnements.pg';
import { journaliser } from '../lib/journal';

/**
 * LE BALAYAGE DES ABONNEMENTS DU NUMÉRO (lot 4, spec `docs/superpowers/specs/2026-10-06-numero-impaye-design.md`).
 *
 * L'état se CALCULE sur des dates (`src/stripe/etat-abonnement.ts`) : « suspendu » est vrai dès que la date passe, que
 * ce balayage tourne ou non. Il ne fait que les GESTES, chacun une seule fois par abonnement (`abonnements_numero_avis`) :
 *  - l'alerte de suspension à Julien (Telegram) ;
 *  - la levée des pauses `numero_suspendu` d'un espace qui n'est plus suspendu (un paiement tombé dans la fenêtre du
 *    cache de la garde, ou un événement de Stripe perdu) ; le paiement les lève d'ordinaire lui-même.
 * La livraison B y ajoute la libération et les e-mails. Rôle principal, toutes les 15 minutes (`src/worker.ts`).
 */
export interface DepsBalayageAbonnements {
  /** Les espaces dont l'abonnement porte un échec, une fin, ou une résiliation, et qui ne sont pas libérés. */
  aSurveiller(): Promise<string[]>;
  /** La SEULE lecture de l'état (`PgAbonnementsNumeroStore.etatDeLEspace`). */
  etat(tenantId: string): Promise<EtatDeLEspace | null>;
  /** `true` la première fois seulement (`PgAbonnementsNumeroStore.noterAvis`). */
  noterAvis(abonnementId: string, avis: AvisAbonnement): Promise<boolean>;
  /** Prévient Julien (Telegram). */
  alerter(texte: string): Promise<void>;
  /** Les espaces qui ont une campagne en pause `numero_suspendu`. */
  espacesEnPauseSuspension(): Promise<string[]>;
  /** Lève ces pauses (`PgNumeroDelieStore.leverPausesSuspension`). */
  leverPausesSuspension(tenantId: string): Promise<number>;
}

const jour = (d: Date | null): string => (d === null ? '?' : d.toISOString().slice(0, 10));

/** Un tour du balayage. Rend le nombre de gestes faits. Un espace qui échoue n'arrête pas les autres. */
export async function balayerAbonnements(d: DepsBalayageAbonnements): Promise<number> {
  let gestes = 0;
  for (const tenantId of await d.aSurveiller()) {
    try {
      const e = await d.etat(tenantId);
      if (e?.etat !== 'suspendu') continue;
      if (!(await d.noterAvis(e.abonnementId, 'suspension_telegram'))) continue;
      gestes += 1;
      await d.alerter(e.finiLe !== null
        ? `Numéro fourni suspendu : espace ${tenantId} (${e.abonnementId}), abonnement terminé. Ses envois sont coupés ; libération le ${jour(e.liberationLe)} sans réabonnement.`
        : `Numéro fourni suspendu : espace ${tenantId} (${e.abonnementId}), impayé depuis 7 jours. Ses envois sont coupés jusqu'au paiement.`);
    } catch (err) {
      journaliser('error', 'balayage_abonnements_espace', { tenantId, err });
    }
  }
  for (const tenantId of await d.espacesEnPauseSuspension()) {
    try {
      if ((await d.etat(tenantId))?.etat === 'suspendu') continue;
      gestes += await d.leverPausesSuspension(tenantId);
    } catch (err) {
      journaliser('error', 'balayage_abonnements_reprise', { tenantId, err });
    }
  }
  return gestes;
}
