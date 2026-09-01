'use client';

/**
 * Connexion, inscription, mot de passe, Google.
 *
 * Sorti de `lib/api.ts` le 2026-09-01 (lot 5 du programme II), qui pesait 1 874 lignes. Le socle HTTP
 * (`./http`) etait deja extrait : ce decoupage-ci ne separe que des surfaces d'appel, sans etat partage.
 * `lib/api.ts` reste le point d'entree et reexporte tout, donc AUCUN des 67 importeurs ne change.
 */

import { request } from '../http';

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
/** Le login rend SOIT une session (un seul espace, le cas courant), SOIT un choix à faire. */
export type LoginOutcome = LoginResult | LoginChoice;
export function isLoginChoice(r: LoginOutcome): r is LoginChoice {
  return (r as LoginChoice).choiceToken !== undefined;
}
/** Deuxième temps : on présente le jeton de choix et l'espace retenu, et on obtient une vraie session. */
export function chooseWorkspace(choiceToken: string, tenantId: string): Promise<LoginResult> {
  return request<LoginResult>('/auth/choose-workspace', { method: 'POST', body: JSON.stringify({ choiceToken, tenantId }) });
}
export function login(email: string, password: string): Promise<LoginOutcome> {
  return request<LoginOutcome>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}
/** Inscription libre : crée un espace + admin, renvoie une session (comme le login). */
export function signup(input: { workspaceName: string; email: string; password: string; name?: string }): Promise<LoginResult> {
  return request<LoginResult>('/auth/signup', { method: 'POST', body: JSON.stringify(input) });
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
/** Se connecter avec Google : envoie le jeton ID au serveur, renvoie une session (login OU nouvel espace). */
export function loginWithGoogle(idToken: string): Promise<GoogleResult> {
  return request<GoogleResult>('/auth/google', { method: 'POST', body: JSON.stringify({ idToken }) });
}
