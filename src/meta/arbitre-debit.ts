import { RateLimiter, type PorteDeDebit } from './http';

/**
 * Arbitre de débit par numéro : une seule porte par `phone_number_id`, partagée par tout ce qui envoie.
 * Posée dans `MetaClientFactory.clientForTenant`, où tous les chemins d'envoi se rejoignent, donc un chemin
 * futur en hérite. Elle s'ajoute en série au débit choisi par campagne, sans le remplacer : deux campagnes à
 * 80/min se partagent 80 au lieu d'en faire 160.
 *
 * Le budget est en mémoire, donc par process (API et worker ont chacun le leur) ; `arbitre-debit-partage.ts`
 * le partage entre process et se replie sur celui-ci.
 *
 * Le RCS n'est pas concerné : il ne passe pas par Meta et a ses propres quotas.
 */
export interface ArbitreDeDebit {
  /** La porte de ce numéro : toujours la même instance pour un même numéro, c'est ce qui la rend partagée. */
  pour(phoneNumberId: string): PorteDeDebit;
}

/** Porte ouverte : aucun frein (`parMinute <= 0`). */
const PORTE_OUVERTE: PorteDeDebit = { acquire: async () => {} };

/**
 * @param parMinute plafond d'envois par minute et par numéro ; `<= 0` = aucun frein.
 * @param fabrique injectable pour les tests (horloge et sommeil pilotés).
 */
export function arbitreDeDebit(
  parMinute: number,
  fabrique: (minIntervalMs: number) => PorteDeDebit = (ms) => new RateLimiter(ms),
): ArbitreDeDebit {
  if (parMinute <= 0) return { pour: () => PORTE_OUVERTE };
  const minIntervalMs = Math.ceil(60_000 / parMinute);
  // Pas de balayage des portes : leur nombre est borné par la clientèle, et en oublier une ferait perdre
  // l'historique de débit d'un numéro qui revient.
  const portes = new Map<string, PorteDeDebit>();
  return {
    pour(phoneNumberId) {
      let porte = portes.get(phoneNumberId);
      if (!porte) {
        porte = fabrique(minIntervalMs);
        portes.set(phoneNumberId, porte);
      }
      return porte;
    },
  };
}
