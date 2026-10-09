import type { ComptesAuthDep } from '../auth/routes';
import type { DemandeOauth } from '../auth/token';
import { makeJournal, type AuditSink } from '../audit/journal';
import type { PgOauthStore } from './store.pg';
import { clientConnu } from './clients';
import { nouveauJeton, PREFIXE_CODE } from './jetons';

/**
 * LE CLIC « AUTORISER », QUELLE QUE SOIT LA PREUVE D'IDENTITÉ (tâche 6 du plan `2026-10-03-oauth-mcp.md`).
 *
 * Deux portes y mènent : la page de consentement après « Continuer avec Google » (`src/http/oauth.ts`, preuve
 * `oauth_choix`) et la même page avec la session de la console (`src/http/oauth-consentement.ts`). 🔴 UNE SEULE
 * FONCTION POUR LES DEUX : une copie qui divergerait laisserait l'une des portes émettre un code sans relire le rôle.
 *
 * 🔴 LE RÔLE SE RELIT EN BASE ICI, au moment d'émettre le code, jamais dans la preuve ni dans la session : seul un
 * admin autorise (décision du 2026-10-03), parce que les outils MCP supposent un admin (la création de widgets est
 * réservée à l'admin dans la console). Un compte désactivé n'autorise rien non plus.
 */
export interface DepsAutoriser {
  store: Pick<PgOauthStore, 'creerAutorisation'>;
  /** Les comptes d'une adresse, relus à chaque autorisation (`PgUserStore.getByEmail`). */
  comptes: Required<Pick<ComptesAuthDep, 'getByEmail'>>;
  /** `oauth.autorise`, sans jeton, code ni empreinte : le client et les droits. */
  audit: AuditSink;
}

export type ResultatAutorisation = { ok: true; adresse: string } | { ok: false; erreur: string };

/** Le nom affiché d'un client : celui scellé dans la demande (lot 15), sinon celui d'un épinglé, sinon l'identifiant. */
export function nomDuClient(demande: Pick<DemandeOauth, 'clientId' | 'client'>): string {
  return demande.client?.nom ?? clientConnu(demande.clientId)?.nom ?? demande.clientId;
}

/**
 * La demande que la page présente n'est plus lisible : expirée (10 minutes) ou signée ailleurs. Un 400 et non un
 * 401 : la route de la console le rend aussi, et un 401 y viderait la session de la console.
 */
export const DEMANDE_EXPIREE = {
  error: 'demande expirée ou invalide : relancez la connexion depuis votre application',
  code: 'demande_expiree',
} as const;

/**
 * Crée l'autorisation et son code (60 s), journalise, et rend l'adresse de retour du client avec `code`, `state` et
 * `iss` (RFC 9207, annoncé par `authorization_response_iss_parameter_supported`).
 * La demande est signée par `/oauth/authorize`, qui a déjà vérifié le client, l'adresse de retour, le défi et la
 * ressource : elle n'est pas revérifiée ici.
 */
export async function autoriser(
  deps: DepsAutoriser,
  base: string,
  personne: { email: string },
  espace: string,
  demande: DemandeOauth,
): Promise<ResultatAutorisation> {
  const compte = (await deps.comptes.getByEmail(personne.email)).find((c) => c.tenantId === espace && !c.disabled);
  if (!compte) return { ok: false, erreur: 'vous n’avez pas de compte actif dans cet espace' };
  if (compte.role !== 'admin') return { ok: false, erreur: 'seul un administrateur de l’espace peut autoriser une application' };
  const code = nouveauJeton(PREFIXE_CODE);
  const { autorisationId } = await deps.store.creerAutorisation({
    tenantId: espace,
    userId: compte.id,
    clientId: demande.clientId,
    scopes: demande.scopes,
    resource: demande.resource,
    code: { empreinte: code.empreinte, challenge: demande.codeChallenge, redirectUri: demande.redirectUri },
    ...(demande.client ? { client: { nom: demande.client.nom, marque: demande.client.marque, hote: new URL(demande.redirectUri).hostname } } : {}),
  });
  // L'acteur est le compte qui autorise, quelle que soit la porte : il n'y a pas toujours de session.
  await makeJournal(deps.audit)(espace, { auth: { userId: compte.id } }, 'oauth.autorise',
    { kind: 'oauth_autorisation', id: autorisationId }, {
      client: nomDuClient(demande), ...(demande.client ? { marque: demande.client.marque } : {}), scopes: demande.scopes,
    });
  // L'adresse de retour n'a ni requête ni fragment (`adresseDeRetourAcceptee`) : les paramètres s'y ajoutent sans rien écraser.
  const adresse = new URL(demande.redirectUri);
  adresse.searchParams.set('code', code.brut);
  adresse.searchParams.set('state', demande.state);
  adresse.searchParams.set('iss', base);
  return { ok: true, adresse: adresse.toString() };
}
