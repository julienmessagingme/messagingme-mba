import type { EtatConnexion } from './api/connexion-numero';

/**
 * LE JETON DU LIEN DE CONNEXION DU NUMÉRO, côté console (lot 3c). Claude Code donne `…/brancher#<jeton>` : la page lit
 * ici l'espace et le mode qu'il porte. 🔴 Lecture SANS vérification : c'est le serveur qui vérifie la signature à chaque
 * appel (`verifyLienNumero`, `src/auth/token.ts`). Un jeton forgé n'ouvre rien, il fait afficher une page dont chaque
 * appel sera refusé. L'identifiant d'espace est borné à un alphabet sûr, parce qu'il entre dans les adresses d'appel.
 */
export interface LienLu {
  tenantId: string;
  /** `coexistence` (plan 2026-10-24) : le numéro reste dans l'application WhatsApp Business. */
  mode: 'fourni' | 'apporte' | 'coexistence';
  /** `application` : la filière de l'application WhatsApp Business, reliée par QR code (2026-10-22). Absente du jeton : `api`. */
  filiere: 'api' | 'application';
}

const ESPACE_RE = /^[A-Za-z0-9-]{1,64}$/;

export function lireLien(jeton: string): LienLu | null {
  const charge = jeton.split('.')[1];
  if (!charge) return null;
  try {
    const base64 = charge.replace(/-/g, '+').replace(/_/g, '/');
    const octets = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const brut: unknown = JSON.parse(new TextDecoder().decode(octets));
    if (typeof brut !== 'object' || brut === null) return null;
    const { kind, tenantId, mode, filiere } = brut as { kind?: unknown; tenantId?: unknown; mode?: unknown; filiere?: unknown };
    if (kind !== 'lien_numero') return null;
    if (typeof tenantId !== 'string' || !ESPACE_RE.test(tenantId)) return null;
    if (mode !== 'fourni' && mode !== 'apporte' && mode !== 'coexistence') return null;
    return { tenantId, mode, filiere: filiere === 'application' ? 'application' : 'api' };
  } catch {
    return null;
  }
}

/**
 * La page du lien a-t-elle fini ? Un numéro connecté et activé. 🔴 En coexistence (plan 2026-10-24), un espace relié par
 * QR code est déjà « connecté » par son compte de l'application (`application`, présent tant qu'aucun numéro de Meta
 * n'est relié) : la page attend le numéro de Meta, sans quoi elle renverrait vers Claude avant la fenêtre de Meta.
 */
export function connexionFinie(etat: Pick<EtatConnexion, 'connecte' | 'application'>, mode: LienLu['mode']): boolean {
  if (!etat.connecte || etat.connecte.aActiver) return false;
  return mode !== 'coexistence' || etat.application === undefined;
}

/**
 * Ce que le parcours reprend à son retour (rechargement, onglet rouvert) quand l'espace a déjà un numéro fourni : le
 * numéro et son code, sous le choix « fourni ». `null` : rien à reprendre. 🔴 Jamais pour un lien de coexistence : son
 * numéro peut être justement un numéro fourni relié par QR code, et le parcours quitterait la fenêtre de coexistence.
 */
export function repriseDuNumeroFourni(
  choixInitial: LienLu['mode'] | null,
  lu: { numero: string | null; code: string | null },
): { numero: string; code: string | null } | null {
  if (choixInitial === 'coexistence' || !lu.numero) return null;
  return { numero: lu.numero, code: lu.code };
}

/** Où la page garde le jeton : l'onglet (`sessionStorage`), qui survit au rechargement et au retour de Stripe, et meurt
 *  avec lui. Jamais `localStorage` : un lien d'une heure n'a pas à survivre à la fermeture de l'onglet. */
export const CLE_JETON_LIEN = 'mba.lien-numero';
