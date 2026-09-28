'use client';
import { effacerFils } from './aide-fil';

export interface Session {
  token: string;
  email: string;
  role: string;
  tenantId: string;
  /**
   * Nom de l'espace OBSERVÉ depuis la surface d'exploitation. Absent = session normale.
   *
   * Sert au bandeau permanent : sans lui, on oublierait qu'on regarde chez quelqu'un d'autre et on prendrait
   * ses chiffres pour les siens. La lecture seule, elle, est imposée par le SERVEUR : ce champ n'est qu'un
   * rappel visuel, il ne protège rien.
   */
  observation?: string;
}

const KEY = 'mba.session';

export function saveSession(s: Session): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export function getSession(): Session | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Session;
    return s.token ? s : null;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  localStorage.removeItem(KEY);
  // 🔴 LE FIL DU BOT D'AIDE PART AVEC LA SESSION. Il dit ce que la personne cherchait à faire ; le laisser
  // derrière elle le mettrait à la disposition du suivant sur le même poste, et un onglet resté ouvert
  // survit très bien à un changement de compte.
  effacerFils();
  // Et la session d'exploitation aussi : la plus puissante ne survit pas à une déconnexion sur un poste partagé.
  clearSessionOps();
}

/**
 * LA SESSION D'EXPLOITATION (`/ops`), À PART DE LA SESSION D'ESPACE.
 *
 * Nominative : une adresse de la liste d'exploitation, son second facteur, 12 heures. Elle vit sous sa propre clé
 * pour deux raisons : le serveur la refuse sur toute route d'espace (la poser comme session de la console
 * déconnecterait), et observer un espace REMPLACE la session d'espace sans devoir fermer l'exploitation.
 */
export interface SessionOps {
  token: string;
  email: string;
}

const CLE_OPS = 'mba.sessionOps';
/** L'ancien jeton partagé que l'écran d'exploitation gardait ici : il n'ouvre plus rien, il ne doit plus traîner. */
const ANCIEN_JETON_OPS = 'mba.ops';

export function saveSessionOps(s: SessionOps): void {
  localStorage.setItem(CLE_OPS, JSON.stringify(s));
}

/** La session d'exploitation, ou `null`. Efface au passage l'ancien jeton partagé. */
export function getSessionOps(): SessionOps | null {
  if (typeof window === 'undefined') return null;
  localStorage.removeItem(ANCIEN_JETON_OPS);
  const raw = localStorage.getItem(CLE_OPS);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<SessionOps>;
    return typeof s.token === 'string' && s.token !== '' && typeof s.email === 'string' ? { token: s.token, email: s.email } : null;
  } catch {
    return null;
  }
}

export function clearSessionOps(): void {
  localStorage.removeItem(CLE_OPS);
}

/**
 * Où atterrit un membre après connexion. SEUL l'admin va sur l'accueil ; tout le reste va à l'inbox.
 *
 * Écrite à l'envers (« agent -> inbox, sinon accueil »), la règle envoyait un manager sur un écran qu'AppShell
 * lui refuse aussitôt : il aurait vu un aller-retour avant d'atterrir sur l'inbox. Elle suit donc la barrière
 * serveur, qui n'ouvre rien à ce qui n'est pas admin.
 */
export function pageDArrivee(role: string): '/accueil' | '/inbox' {
  return role === 'admin' ? '/accueil' : '/inbox';
}
