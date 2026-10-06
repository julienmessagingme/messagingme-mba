/**
 * LE JETON DU LIEN DE CONNEXION DU NUMÉRO, côté console (lot 3c). Claude Code donne `…/brancher#<jeton>` : la page lit
 * ici l'espace et le mode qu'il porte. 🔴 Lecture SANS vérification : c'est le serveur qui vérifie la signature à chaque
 * appel (`verifyLienNumero`, `src/auth/token.ts`). Un jeton forgé n'ouvre rien, il fait afficher une page dont chaque
 * appel sera refusé. L'identifiant d'espace est borné à un alphabet sûr, parce qu'il entre dans les adresses d'appel.
 */
export interface LienLu {
  tenantId: string;
  mode: 'fourni' | 'apporte';
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
    const { kind, tenantId, mode } = brut as { kind?: unknown; tenantId?: unknown; mode?: unknown };
    if (kind !== 'lien_numero') return null;
    if (typeof tenantId !== 'string' || !ESPACE_RE.test(tenantId)) return null;
    if (mode !== 'fourni' && mode !== 'apporte') return null;
    return { tenantId, mode };
  } catch {
    return null;
  }
}

/** Où la page garde le jeton : l'onglet (`sessionStorage`), qui survit au rechargement et au retour de Stripe, et meurt
 *  avec lui. Jamais `localStorage` : un lien d'une heure n'a pas à survivre à la fermeture de l'onglet. */
export const CLE_JETON_LIEN = 'mba.lien-numero';
