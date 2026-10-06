import type { EtatAbonnementNumero } from '../stripe/etat-abonnement';
import { NumeroBloqueError } from '../meta/numero-delie';

/**
 * UN NUMÉRO SUSPENDU (lot 4, spec `docs/superpowers/specs/2026-10-06-numero-impaye-design.md`) : le numéro FOURNI
 * attribué à l'espace, dont l'abonnement est suspendu (7 jours d'impayé, ou abonnement fini). Un numéro que le client
 * a apporté n'est jamais suspendu, même si l'espace garde un ancien abonnement fini.
 *
 * L'état vient de la SEULE lecture qui fait foi (`PgAbonnementsNumeroStore.etatDeLEspace`) ; cette fonction ne fait que
 * relier un numéro d'envoi à son espace et à son numéro fourni. Elle sert la garde du point d'envoi unique
 * (`creerGardeNumeroSuspendu`, en cache court).
 */
export interface DepsSuspension {
  /** L'espace du numéro d'envoi et ses chiffres (`phone_numbers`), `null` s'il est inconnu. */
  telephone(phoneNumberId: string): Promise<{ tenantId: string; chiffres: string } | null>;
  /** Les chiffres du numéro fourni ATTRIBUÉ à l'espace, `null` s'il n'en a pas. */
  numeroFourni(tenantId: string): Promise<string | null>;
  /** L'état de l'abonnement du numéro de l'espace, `null` s'il n'en a jamais eu. */
  etat(tenantId: string): Promise<{ etat: EtatAbonnementNumero } | null>;
}

export function creerLectureSuspension(d: DepsSuspension): (phoneNumberId: string) => Promise<boolean> {
  return async (phoneNumberId) => {
    const tel = await d.telephone(phoneNumberId);
    if (tel === null) return false;
    const [fourni, etat] = await Promise.all([d.numeroFourni(tel.tenantId), d.etat(tel.tenantId)]);
    // Des chiffres inconnus (affichage vide, Meta pas lu à la liaison) sont ceux du numéro fourni, comme pour
    // « Abandonner » et la lecture de l'état : sans quoi ce numéro ne serait jamais coupé (jaune 3 de la relecture de A).
    return fourni !== null && (tel.chiffres === '' || fourni === tel.chiffres) && etat?.etat === 'suspendu';
  };
}

/**
 * Le numéro de CET espace est-il bloqué (délié, ou suspendu) ? Le point d'envoi unique le dit
 * (`MetaClientFactory.verifierNumero`, en cache court) : le tour d'un agent et la remise « personne ne suit » le
 * demandent AVANT d'appeler un modèle ou de confier le message à un robot qui ne pourrait pas répondre. Aucun numéro :
 * `false` (les gardes « aucun numéro » existent ailleurs). Une panne de lecture n'est pas un blocage : elle remonte.
 */
export function creerNumeroBloqueDeLEspace(o: {
  numeroDeLEspace(tenantId: string): Promise<string | null>;
  verifierNumero(phoneNumberId: string): Promise<void>;
}): (tenantId: string) => Promise<boolean> {
  return async (tenantId) => {
    const numero = await o.numeroDeLEspace(tenantId);
    if (numero === null) return false;
    try {
      await o.verifierNumero(numero);
      return false;
    } catch (err) {
      if (err instanceof NumeroBloqueError) return true;
      throw err;
    }
  };
}
