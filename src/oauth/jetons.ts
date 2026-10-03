import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../lib/signature';

/**
 * Les jetons opaques de l'OAuth (migration 0204) : jamais des JWT. Un JWT ne se révoque pas avant son échéance, et
 * il pourrait être confondu avec une session signée par `AUTH_SECRET` ; un jeton opaque se relit en base à chaque
 * appel, donc une révocation prend effet tout de suite.
 *
 * Trois préfixes, tous distincts de celui d'une clé d'API (`mba_`) : c'est ce qui aiguille la garde de `/mcp` sans
 * ambiguïté (`src/auth/api-key.ts`). `mbo_` le jeton d'accès, `mbr_` le renouvellement, `mbc_` le code de retour.
 * Même générateur et même empreinte qu'une clé d'API (`api-key-store.pg.ts`) : 32 octets en base64url, et seul
 * le SHA-256 du jeton ENTIER, préfixe compris, est stocké.
 */
export type PrefixeJeton = 'mbo_' | 'mbr_' | 'mbc_';

export const PREFIXE_ACCES = 'mbo_' satisfies PrefixeJeton;
export const PREFIXE_RENOUVELLEMENT = 'mbr_' satisfies PrefixeJeton;
export const PREFIXE_CODE = 'mbc_' satisfies PrefixeJeton;

/** Ce que rend `randomBytes(32).toString('base64url')` : exactement 43 caractères de l'alphabet base64url. */
const CORPS = /^[A-Za-z0-9_-]{43}$/;

/** Un jeton neuf : le brut, rendu une seule fois au client, et son empreinte, seule écrite en base. */
export function nouveauJeton(prefixe: PrefixeJeton): { brut: string; empreinte: string } {
  const brut = `${prefixe}${randomBytes(32).toString('base64url')}`;
  return { brut, empreinte: sha256Hex(brut) };
}

/**
 * Le jeton a-t-il la forme exacte d'un jeton émis avec ce préfixe ? Se contrôle avant le SHA-256 et la base : une
 * rafale de `mbo_x` ne coûte rien.
 */
export function formeDeJeton(brut: string, prefixe: PrefixeJeton): boolean {
  return brut.startsWith(prefixe) && CORPS.test(brut.slice(prefixe.length));
}

/** Le code de retour : 60 secondes, le temps d'un aller-retour du navigateur vers Claude. */
export const DUREE_CODE_S = 60;
/** Le jeton d'accès : une heure, rendue en `expires_in` (Claude renouvelle jusqu'à cinq minutes avant). */
export const DUREE_ACCES_S = 3600;
/** Le renouvellement meurt après 30 jours sans usage : chaque renouvellement repousse cette échéance. */
export const DUREE_RENOUVELLEMENT_INACTIF_S = 30 * 24 * 3600;
/** Et 90 jours au plus après l'autorisation, quel que soit l'usage : il faut alors repasser par le consentement. */
export const DUREE_RENOUVELLEMENT_MAX_S = 90 * 24 * 3600;
