import { BASE, ApiError, messageDErreur, langue, request } from '../http';
import {
  obtenirNumeroFourni, lireNumeroFourni, remplacerNumeroFourni, abandonnerNumeroFourni, getEsConfig, completeEmbeddedSignup,
  type EsConfig, type EsCompleteResult, type NumeroFourniEtat,
} from './integrations';

/**
 * CE DONT LE PARCOURS DE CONNEXION DU NUMÉRO A BESOIN (lot 3c), sous deux autorités : la session de la console
 * (`/connecter-whatsapp`, l'Accueil) ou le jeton du lien que donne Claude Code (`/brancher`). Le parcours ne sait pas
 * laquelle : un seul code pour les deux pages.
 */
export interface ApiConnexionNumero {
  config(): Promise<EsConfig>;
  completer(input: { code: string; wabaId?: string; phoneNumberId?: string; evenement?: string }): Promise<EsCompleteResult>;
  obtenir(): Promise<{ numero: string }>;
  lire(): Promise<NumeroFourniEtat>;
  remplacer(): Promise<{ numero: string }>;
  abandonner(): Promise<{ rendu: boolean }>;
  /** Où en est la connexion du numéro, abonnement compris (`GET /tenants/:tenantId/connexion-numero`). */
  etat(): Promise<{ etat: EtatConnexion; empreinte: string }>;
  /** Ouvrir le paiement de l'abonnement du numéro (lot 3c) : l'adresse de la page de Stripe. */
  payer(retour: 'brancher' | 'console'): Promise<{ url: string }>;
}

/** La session de la console : les appels d'hier, inchangés. */
export function apiDeLaSession(tenantId: string): ApiConnexionNumero {
  return {
    config: () => getEsConfig(tenantId),
    completer: (input) => completeEmbeddedSignup(tenantId, input),
    obtenir: () => obtenirNumeroFourni(tenantId),
    lire: () => lireNumeroFourni(tenantId),
    remplacer: () => remplacerNumeroFourni(tenantId),
    abandonner: () => abandonnerNumeroFourni(tenantId),
    etat: () => request(`/tenants/${tenantId}/connexion-numero`),
    payer: (retour) => request(`/tenants/${tenantId}/numero-fourni/abonnement`, { method: 'POST', body: JSON.stringify({ retour }) }),
  };
}

/** Où en est la connexion du numéro (`GET /tenants/:tenantId/connexion-numero`), la même lecture que Claude Code. */
export interface EtatConnexion {
  fourni: string | null;
  code: { code: string; recuLe: string } | null;
  /** `aActiver` : relié, mais Meta ne l'a pas encore activé ; il n'est pas « connecté ». */
  connecte: { chiffres: string; aActiver: boolean } | null;
  /** L'abonnement du numéro fourni (lot 3c) : `actif`, `en_retard` ou `resilie`, `null` sans abonnement. */
  abonnement: { statut: 'actif' | 'en_retard' | 'resilie'; periodeFin: string | null } | null;
}

/**
 * Le serveur a refusé le lien : 401 (expiré, révoqué, forgé) ou 403 (son auteur n'est plus admin, l'espace est suspendu).
 * La page dit de le redemander à Claude, plutôt que de laisser un bouton grisé sans un mot.
 */
export class LienRefuse extends Error {}

/**
 * Le jeton du lien. 🔴 Il ne lit JAMAIS la session de la console : un navigateur qui porte les deux (un admin qui teste)
 * enverrait sinon la session, et la page ne prouverait rien du lien. Un 401 n'efface aucune session non plus.
 */
export function apiDuLien(tenantId: string, jeton: string): ApiConnexionNumero {
  async function appel<T>(chemin: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    headers.set('authorization', `Bearer ${jeton}`);
    const res = await fetch(`${BASE}/tenants/${encodeURIComponent(tenantId)}${chemin}`, { ...init, headers });
    const corps = (await res.json().catch(() => null)) as unknown;
    if (res.status === 401 || res.status === 403) throw new LienRefuse(messageDErreur(res.status, corps, langue()));
    if (!res.ok) throw new ApiError(res.status, messageDErreur(res.status, corps, langue()), corps);
    return corps as T;
  }
  const poster = <T>(chemin: string, corps: unknown = {}) => appel<T>(chemin, { method: 'POST', body: JSON.stringify(corps) });
  return {
    config: () => appel('/embedded-signup/config'),
    completer: (input) => poster('/embedded-signup/complete', input),
    obtenir: () => poster('/numero-fourni'),
    lire: () => appel('/numero-fourni'),
    remplacer: () => poster('/numero-fourni/remplacer'),
    abandonner: () => poster('/numero-fourni/abandonner'),
    etat: () => appel('/connexion-numero'),
    payer: (retour) => poster('/numero-fourni/abonnement', { retour }),
  };
}
