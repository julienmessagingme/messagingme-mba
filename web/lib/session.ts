'use client';

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
