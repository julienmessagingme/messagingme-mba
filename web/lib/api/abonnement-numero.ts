import { request } from '../http';

/**
 * L'ÉTAT DE L'ABONNEMENT DU NUMÉRO FOURNI (lot 4), lisible par tout membre de l'espace : le bandeau de la console le
 * lit sur chaque page. Les dates sont en ISO ; `fini` dit que la suspension vient de la FIN de l'abonnement (un
 * nouveau paiement rend le même numéro), et non d'un impayé (le portail de Stripe règle la facture).
 */
export interface EtatAbonnementNumero {
  etat: 'actif' | 'fin_prevue' | 'en_retard' | 'suspendu' | 'libere' | null;
  finPrevueLe: string | null;
  coupureLe: string | null;
  liberationLe: string | null;
  fini: boolean;
}

export const lireAbonnementNumero = (tenantId: string): Promise<EtatAbonnementNumero> =>
  request(`/tenants/${tenantId}/abonnement-numero`);
