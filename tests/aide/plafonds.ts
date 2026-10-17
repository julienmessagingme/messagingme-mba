import { RateLimiter } from '../../src/auth/rate-limit';
import { PlafondEspace, SANS_LIMITE_D_OFFRE, SANS_REGLAGE, type ReglagePlafondApi, type SourceLimitesApi } from '../../src/auth/plafond-espace';
import type { PlafondsCle } from '../../src/auth/api-key';
import { CompteurDebitMemoire } from '../../src/db/debit.memoire';
import type { CompteurDebit } from '../../src/db/debit';
import { PlafondGlobal, type ReglagePlafondGlobal, type SourceOffre } from '../../src/auth/plafond-global';

/**
 * Une offre sans valeur propre pour les plafonds et les quotas de l'API (l'Entreprise) : la configuration s'applique.
 * Celle d'un test qui éprouve autre chose que les limites de l'offre (spec offres v2).
 */
export const sansLimiteDOffre: SourceLimitesApi = { limitesApi: async () => SANS_LIMITE_D_OFFRE };

/** Le plafond de la plateforme éteint (son défaut en production tant que le banc ne l'a pas mesuré). */
export function plafondGlobalEteint(): PlafondGlobal {
  return new PlafondGlobal({ parFenetre: 0, partFreePct: 50 }, { offreDe: async () => ({ offre: 'entreprise' }) }, new CompteurDebitMemoire());
}

/**
 * LES PLAFONDS D'UNE GARDE DE CLÉ, POUR UN TEST (2026-09-25).
 *
 * ⚠️ LARGES PAR DÉFAUT : un cas qui éprouve autre chose que le débit (le format, le budget spéculatif, un droit)
 * ne doit pas être refusé pour cause de plafond. Celui qui éprouve le débit le dit : `minute`, `heure`, `relais`.
 * `reglage` rend le réglage d'un espace (migration 0181), SANS cache : c'est le limiteur qui est éprouvé ici.
 * `compteur` : le compteur partagé (migration 0186). Deux gardes qui reçoivent le même sont deux copies de l'API ;
 * absent, chaque garde a le sien. `global` : le plafond de la plateforme (lot 14), ÉTEINT par défaut ; `offres` dit
 * l'offre de chaque espace (Entreprise par défaut).
 */
export function plafondsDeTest(o: {
  minute?: number;
  heure?: number;
  relais?: number;
  relaisMaxCles?: number;
  reglage?: (tenantId: string) => ReglagePlafondApi;
  now?: () => number;
  compteur?: CompteurDebit;
  global?: ReglagePlafondGlobal;
  offres?: SourceOffre;
} = {}): PlafondsCle {
  const now = o.now ?? (() => Date.now());
  const reglage = o.reglage ?? (() => SANS_REGLAGE);
  const compteur = o.compteur ?? new CompteurDebitMemoire(now);
  return {
    espace: new PlafondEspace(
      { minute: o.minute ?? 1000, heure: o.heure ?? 100_000 },
      { reglage: async (t) => reglage(t) },
      compteur,
      o.global
        ? new PlafondGlobal(o.global, o.offres ?? { offreDe: async () => ({ offre: 'entreprise' }) }, compteur)
        : plafondGlobalEteint(),
      sansLimiteDOffre,
    ),
    relais: new RateLimiter(o.relais ?? 1000, 60_000, now, o.relaisMaxCles ?? 0),
  };
}
