import { request } from '../http';

/**
 * Développeurs > Webhooks sortants (lot 12) : les adresses de l'application d'un client et leur journal. Le serveur
 * vit dans `src/http/evenements.ts`. Le secret n'arrive QUE dans la réponse de création et de rotation.
 */
export interface AdresseEvenements {
  id: string;
  url: string;
  description: string;
  types: string[];
  active: boolean;
  creeLe: string;
  ancienSecretJusqua: string | null;
  derniereLivraisonLe: string | null;
  enReessai: number;
  echecs: number;
}

export interface ListeAdressesEvenements {
  adresses: AdresseEvenements[];
  /** Le nombre d'adresses actives de l'offre, `null` = sans limite. */
  limite: number | null;
  types: string[];
  typesParDefaut: string[];
  chiffrementPret: boolean;
}

export interface EnvoiEvenements {
  id: string;
  evenementId: string;
  type: string;
  statut: 'en_cours' | 'livre' | 'echec';
  tentatives: number;
  dernierCode: number | null;
  derniereReponse: string | null;
  prochainEssaiLe: string | null;
  creeLe: string;
  livreLe: string | null;
  corps: string;
}

const base = (tenantId: string) => `/tenants/${tenantId}/evenements`;

export function listerAdressesEvenements(tenantId: string): Promise<ListeAdressesEvenements> {
  return request(`${base(tenantId)}/adresses`);
}

export function creerAdresseEvenements(
  tenantId: string, a: { url: string; description: string; types: string[] },
): Promise<{ adresse: AdresseEvenements; secret: string }> {
  return request(`${base(tenantId)}/adresses`, { method: 'POST', body: JSON.stringify(a) });
}

export function modifierAdresseEvenements(
  tenantId: string, id: string, m: { description?: string; types?: string[]; active?: boolean },
): Promise<AdresseEvenements> {
  return request(`${base(tenantId)}/adresses/${id}`, { method: 'PATCH', body: JSON.stringify(m) });
}

export function tournerSecretEvenements(tenantId: string, id: string): Promise<{ secret: string; ancienJusqua: string }> {
  return request(`${base(tenantId)}/adresses/${id}/rotation`, { method: 'POST', body: '{}' });
}

export function supprimerAdresseEvenements(tenantId: string, id: string): Promise<unknown> {
  return request(`${base(tenantId)}/adresses/${id}`, { method: 'DELETE' });
}

export function essaiAdresseEvenements(tenantId: string, id: string): Promise<{ evenementId: string; livre: boolean; code: number | null; reponse: string }> {
  return request(`${base(tenantId)}/adresses/${id}/essai`, { method: 'POST', body: '{}' });
}

export function journalAdresseEvenements(tenantId: string, id: string, avant?: string): Promise<{ envois: EnvoiEvenements[] }> {
  const q = new URLSearchParams({ limite: '50', ...(avant ? { avant } : {}) });
  return request(`${base(tenantId)}/adresses/${id}/envois?${q.toString()}`);
}

export function rejouerEnvoiEvenements(tenantId: string, envoiId: string): Promise<unknown> {
  return request(`${base(tenantId)}/envois/${envoiId}/rejeu`, { method: 'POST', body: '{}' });
}

export function rejouerEchecsEvenements(tenantId: string, id: string, depuis: string): Promise<{ rejoues: number }> {
  return request(`${base(tenantId)}/adresses/${id}/rejeu-echecs`, { method: 'POST', body: JSON.stringify({ depuis }) });
}
