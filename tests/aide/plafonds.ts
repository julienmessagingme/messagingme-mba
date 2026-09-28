import { RateLimiter } from '../../src/auth/rate-limit';
import { PlafondEspace, SANS_REGLAGE, type ReglagePlafondApi } from '../../src/auth/plafond-espace';
import type { PlafondsCle } from '../../src/auth/api-key';
import { CompteurDebitMemoire } from '../../src/db/debit.memoire';
import type { CompteurDebit } from '../../src/db/debit';

/**
 * LES PLAFONDS D'UNE GARDE DE CLÉ, POUR UN TEST (2026-09-25).
 *
 * ⚠️ LARGES PAR DÉFAUT : un cas qui éprouve autre chose que le débit (le format, le budget spéculatif, un droit)
 * ne doit pas être refusé pour cause de plafond. Celui qui éprouve le débit le dit : `minute`, `heure`, `relais`.
 * `reglage` rend le réglage d'un espace (migration 0181), SANS cache : c'est le limiteur qui est éprouvé ici.
 * `compteur` : le compteur partagé (migration 0186). Deux gardes qui reçoivent le même sont deux copies de l'API ;
 * absent, chaque garde a le sien.
 */
export function plafondsDeTest(o: {
  minute?: number;
  heure?: number;
  relais?: number;
  relaisMaxCles?: number;
  reglage?: (tenantId: string) => ReglagePlafondApi;
  now?: () => number;
  compteur?: CompteurDebit;
} = {}): PlafondsCle {
  const now = o.now ?? (() => Date.now());
  const reglage = o.reglage ?? (() => SANS_REGLAGE);
  return {
    espace: new PlafondEspace(
      { minute: o.minute ?? 1000, heure: o.heure ?? 100_000 },
      { reglage: async (t) => reglage(t) },
      o.compteur ?? new CompteurDebitMemoire(now),
    ),
    relais: new RateLimiter(o.relais ?? 1000, 60_000, now, o.relaisMaxCles ?? 0),
  };
}
