'use client';

/**
 * Connexion, inscription, mot de passe, Google.
 *
 * Sorti de `lib/api.ts` le 2026-09-01 (lot 5 du programme II), qui pesait 1 874 lignes. Le socle HTTP
 * (`./http`) etait deja extrait : ce decoupage-ci ne separe que des surfaces d'appel, sans etat partage.
 * `lib/api.ts` reste le point d'entree et reexporte tout, donc AUCUN des 67 importeurs ne change.
 */

import { request, ApiError } from '../http';
import { estCorpsCodeRefuse } from '../second-facteur';

export interface LoginResult {
  token: string;
  user: { email: string; role: string; tenantId: string };
}
/** Un espace accessible avec l'adresse saisie, tel que l'écran de choix le présente. */
export interface WorkspaceChoice { tenantId: string; tenantName: string; role: string }
/**
 * Réponse d'un login quand l'adresse donne accès à PLUSIEURS espaces : aucune session n'est émise, il faut
 * choisir. `choiceToken` ne vaut que pour `chooseWorkspace`, et le serveur le refuse comme jeton d'API.
 */
export interface LoginChoice {
  choiceToken: string;
  workspaces: WorkspaceChoice[];
}
/** Ce qui suit le second facteur, ou le remplace quand il n'est pas dû : une session, ou un choix d'espace. */
export type SuiteConnexion = LoginResult | LoginChoice;
/**
 * LE SECOND FACTEUR, AVANT TOUTE SESSION (plan du 2026-09-25). Aucun de ces jetons n'ouvre quoi que ce soit : il
 * ne vaut que pour l'étape suivante, et le serveur le refuse comme session.
 * - `mfaToken` : l'identité a un facteur actif, on demande son code ;
 * - `enrolToken` : administrateur sans facteur, il en pose un avant d'entrer.
 */
export type EtapeSecondFacteur = { mfaToken: string } | { enrolToken: string };
/** Le login rend une session, un choix d'espace, ou une étape du second facteur. */
export type LoginOutcome = SuiteConnexion | EtapeSecondFacteur;
export function isLoginChoice<T extends LoginResult>(r: T | LoginChoice): r is LoginChoice {
  return (r as LoginChoice).choiceToken !== undefined;
}
export function estEtapeSecondFacteur(r: LoginOutcome): r is EtapeSecondFacteur {
  return 'mfaToken' in r || 'enrolToken' in r;
}
/** Deuxième temps : on présente le jeton de choix et l'espace retenu, et on obtient une vraie session. */
export function chooseWorkspace(choiceToken: string, tenantId: string): Promise<LoginResult> {
  return request<LoginResult>('/auth/choose-workspace', { method: 'POST', body: JSON.stringify({ choiceToken, tenantId }) });
}
export function login(email: string, password: string): Promise<LoginOutcome> {
  // `etape` : un 401 ici veut dire « identifiants invalides », pas « session perdue » (il n'y en a pas encore).
  return request<LoginOutcome>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }, 'etape');
}
/**
 * Inscription libre : crée un espace dont on devient administrateur. Jamais de session directe : l'enrôlement du
 * second facteur d'abord (ou son code, si l'adresse en a déjà un).
 */
export function signup(input: { workspaceName: string; email: string; password: string; name?: string }): Promise<EtapeSecondFacteur> {
  return request<EtapeSecondFacteur>('/auth/signup', { method: 'POST', body: JSON.stringify(input) });
}

// --- Second facteur : les étapes de la connexion (sans session) -----------------------------------------------

/** Le secret d'un enrôlement : `uri` pour le QR code, `secret` (base32) pour la saisie à la main. */
export interface CleTotp { secret: string; uri: string }

/** Le code (application ou secours) d'une connexion. `codesSecoursRestants` n'est rendu que si un code de secours a servi. */
export function verifierCodeConnexion(mfaToken: string, code: string): Promise<SuiteConnexion & { codesSecoursRestants?: number }> {
  return request('/auth/mfa/verifier', { method: 'POST', body: JSON.stringify({ mfaToken, code }) }, 'etape');
}
export function enrolerConnexion(enrolToken: string): Promise<CleTotp> {
  return request('/auth/mfa/enroler', { method: 'POST', body: JSON.stringify({ enrolToken }) }, 'etape');
}
/** Le premier code prouve que l'application lit le bon secret. Rend les dix codes de secours, et la suite. */
export function activerConnexion(enrolToken: string, code: string): Promise<SuiteConnexion & { codesSecours: string[] }> {
  return request('/auth/mfa/activer', { method: 'POST', body: JSON.stringify({ enrolToken, code }) }, 'etape');
}

// --- Second facteur : la page Compte (avec session) --------------------------------------------------------------

export interface EtatSecondFacteur {
  actif: boolean;
  activeLe: string | null;
  codesSecoursRestants: number;
  /** Administrateur quelque part : la désactivation lui est refusée. */
  obligatoire: boolean;
}
export function lireSecondFacteur(): Promise<EtatSecondFacteur> {
  return request('/auth/mfa/moi');
}
export function enrolerMoi(): Promise<CleTotp> {
  return request('/auth/mfa/moi/enroler', { method: 'POST', body: '{}' });
}
export function activerMoi(code: string): Promise<{ codesSecours: string[] }> {
  return request('/auth/mfa/moi/activer', { method: 'POST', body: JSON.stringify({ code }) }, 'code');
}
/** Dix codes neufs ; les anciens cessent de valoir. Un code est exigé, même avec une session. */
export function regenererCodesSecours(code: string): Promise<{ codesSecours: string[] }> {
  return request('/auth/mfa/moi/codes', { method: 'POST', body: JSON.stringify({ code }) }, 'code');
}
export function desactiverSecondFacteur(code: string): Promise<{ ok: boolean }> {
  return request('/auth/mfa/moi/desactiver', { method: 'POST', body: JSON.stringify({ code }) }, 'code');
}

/** Le serveur a refusé le CODE (faux, rejoué, hors fenêtre) : on reste sur l'étape. */
export function estCodeRefuse(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401 && estCorpsCodeRefuse(err.corps);
}
/** Mot de passe perdu : renvoie toujours 200 (anti-énumération). */
export function forgotPassword(email: string): Promise<{ ok: boolean; message: string }> {
  return request('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) });
}
export function resetPassword(token: string, password: string): Promise<{ ok: boolean }> {
  return request('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) });
}
export function changePassword(currentPassword: string, newPassword: string): Promise<{ ok: boolean }> {
  return request('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
}
/** Config publique d'auth : le front l'utilise pour afficher (ou non) le bouton Google. */
export function getAuthConfig(): Promise<{ googleClientId: string; googleEnabled: boolean }> {
  return request('/auth/config', { method: 'GET' });
}
/** Résultat Google : session + `isNew` (email inconnu -> nouvel espace créé -> onboarding /accueil). */
export interface GoogleResult extends LoginResult {
  isNew: boolean;
}
/**
 * Se connecter avec Google : envoie le jeton ID au serveur, renvoie une session (login OU nouvel espace), ou un
 * CHOIX quand l'adresse ouvre plusieurs espaces, exactement comme `login`.
 */
export function loginWithGoogle(idToken: string): Promise<GoogleResult | LoginChoice> {
  return request<GoogleResult | LoginChoice>('/auth/google', { method: 'POST', body: JSON.stringify({ idToken }) });
}
