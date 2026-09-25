import { RateLimiter } from '../../src/auth/rate-limit';
import { PlafondEspace, SANS_REGLAGE, type ReglagePlafondApi } from '../../src/auth/plafond-espace';
import type { PlafondsCle } from '../../src/auth/api-key';

/**
 * LES PLAFONDS D'UNE GARDE DE CLÉ, POUR UN TEST (2026-09-25).
 *
 * ⚠️ LARGES PAR DÉFAUT : un cas qui éprouve autre chose que le débit (le format, le budget spéculatif, un droit)
 * ne doit pas être refusé pour cause de plafond. Celui qui éprouve le débit le dit : `minute`, `heure`, `relais`.
 * `reglage` rend le réglage d'un espace (migration 0181), SANS cache : c'est le limiteur qui est éprouvé ici.
 */
export function plafondsDeTest(o: {
  minute?: number;
  heure?: number;
  relais?: number;
  relaisMaxCles?: number;
  reglage?: (tenantId: string) => ReglagePlafondApi;
  now?: () => number;
} = {}): PlafondsCle {
  const now = o.now ?? (() => Date.now());
  const reglage = o.reglage ?? (() => SANS_REGLAGE);
  return {
    espace: new PlafondEspace({ minute: o.minute ?? 1000, heure: o.heure ?? 100_000 }, { reglage: async (t) => reglage(t) }, now),
    relais: new RateLimiter(o.relais ?? 1000, 60_000, now, o.relaisMaxCles ?? 0),
  };
}
