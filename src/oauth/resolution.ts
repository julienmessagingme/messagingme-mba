import { clientConnu, estAdresseDeFiche, estClientEnregistre, type ClientResolu } from './clients';
import type { LecteurDeFiches } from './fiche-client';

/**
 * QUI EST CE CLIENT ? Un seul point de passage pour les trois sortes (lot 15, spec § 1) : épinglé, à fiche
 * d'identité, enregistré. `/oauth/authorize` le résout entier ; l'échange du code et le renouvellement ne font que
 * vérifier qu'il est encore reconnu, SANS requête sortante (le code et l'autorisation portent déjà son identifiant).
 */
export interface DepsClients {
  fiches: LecteurDeFiches;
  enregistres: { lire(id: string): Promise<ClientResolu | null> };
}

/** Le client complet (nom, marque, adresses de retour), ou `null`. Seule la fiche d'identité fait partir une requête. */
export async function resoudreClient(deps: DepsClients, id: string): Promise<ClientResolu | null> {
  const epingle = clientConnu(id);
  if (epingle) return { ...epingle, marque: 'epingle' };
  if (estClientEnregistre(id)) return deps.enregistres.lire(id);
  if (estAdresseDeFiche(id)) return deps.fiches.lire(id);
  return null;
}

/** La forme seule, sans base ni réseau : ce qui précède le plafond et la base dans `/oauth/token`. */
export function formeDeClient(id: string): boolean {
  return clientConnu(id) !== null || estClientEnregistre(id) || estAdresseDeFiche(id);
}

/**
 * À l'échange et au renouvellement : le client est-il encore reconnu ? Un enregistré purgé ne l'est plus (son
 * application redemande une connexion) ; une fiche ne se relit pas ici.
 */
export async function clientEncoreReconnu(deps: Pick<DepsClients, 'enregistres'>, id: string): Promise<boolean> {
  if (estClientEnregistre(id)) return (await deps.enregistres.lire(id)) !== null;
  return formeDeClient(id);
}
