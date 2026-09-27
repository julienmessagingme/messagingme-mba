'use client';

import { request } from './http';
import { lireIntegrationSalesforce, type IntegrationSalesforceVue } from './salesforce';

/**
 * L'APP SALESFORCE : Paramètres > Intégrations > Salesforce (plan 2026-09-26, lot L1).
 *
 * ⚠️ Module importé EN DIRECT (`@/lib/api-salesforce`), jamais ajouté au barrel `lib/api.ts` : même famille que
 * `api-pubs`, les surfaces qui ont leur propre vocabulaire.
 *
 * 🔴 LES CHEMINS SONT ÉCRITS UNE SEULE FOIS, dérivés de `base()` : un écran qui tape un chemin que le serveur ne
 * monte pas n'est démenti ni par le compilateur ni par un test, seulement par un 404 à l'écran.
 *
 * 🔴 UN REFUS NE SORT JAMAIS EN 401 : `request()` viderait la session et déconnecterait l'admin au milieu de sa
 * connexion. Le serveur rend les manques en 422, dans le corps de l'`ApiError`.
 */

const base = (tenantId: string): string => `/tenants/${tenantId}/integrations/salesforce`;

/** L'état de l'intégration. `null` : réponse illisible (route absente, API plus ancienne que la console). */
export async function lireIntegration(tenantId: string): Promise<IntegrationSalesforceVue | null> {
  return lireIntegrationSalesforce(await request<unknown>(base(tenantId)));
}

/**
 * Relie l'org. Succès : `{ ok: true, orgId, sandbox }`. Un manque ou une panne passagère lève une `ApiError` 422
 * dont le corps se lit par `lireRefusConnexion`.
 */
export function connecter(tenantId: string, adresse: string): Promise<{ ok: true; orgId: string; sandbox: boolean }> {
  return request(`${base(tenantId)}/connexion`, { method: 'POST', body: JSON.stringify({ adresse }) });
}

export interface ReglagesSalesforceSaisis {
  consentementLead: { champ: string; valeurOui: string | null; valeurNon: string | null } | null;
  consentementContact: { champ: string; valeurOui: string | null; valeurNon: string | null } | null;
  envoyerResume: boolean;
  proprietaireRepli: string | null;
}

export async function enregistrerReglages(tenantId: string, r: ReglagesSalesforceSaisis): Promise<IntegrationSalesforceVue | null> {
  return lireIntegrationSalesforce(await request<unknown>(`${base(tenantId)}/reglages`, { method: 'PUT', body: JSON.stringify(r) }));
}

/** Délie l'org. `effaceDansOrg: false` : l'org était injoignable, le secret n'a pas pu y être effacé. */
export function deconnecter(tenantId: string): Promise<{ effaceDansOrg: boolean }> {
  return request(base(tenantId), { method: 'DELETE' });
}

/**
 * L'interrupteur de l'espace. Il vit sous la route de l'intégration (pas sous `/settings`) : la carte lit tout
 * au même endroit. Éteindre avec une org reliée est refusé en 409, avec la phrase à afficher.
 */
export function setSalesforceActif(tenantId: string, actif: boolean): Promise<{ salesforceActif: boolean }> {
  return request(`${base(tenantId)}/actif`, { method: 'PATCH', body: JSON.stringify({ actif }) });
}
