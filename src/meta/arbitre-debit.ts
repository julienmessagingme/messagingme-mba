import { RateLimiter, type PorteDeDebit } from './http';

/**
 * ARBITRE DE DÉBIT PAR NUMÉRO (lot 4 du programme, 2026-08-31).
 *
 * 🔴 Le problème. Le seul frein d'envoi du dépôt était instancié PAR RUN DE CAMPAGNE : deux campagnes du même
 * numéro avaient deux budgets, et 30/min configurés devenaient 60. Les trois autres chemins d'envoi (réponse
 * d'inbox, message de scénario, automation) n'avaient AUCUN frein. Le débit réel d'un numéro n'était donc
 * borné par rien, alors que c'est lui que Meta observe et sur lequel il fonde la qualité et les paliers.
 *
 * Ce que fait cet arbitre : une porte, UNE SEULE, par `phone_number_id`, partagée par tout ce qui envoie.
 * Elle est posée à l'endroit où les quatre chemins se rejoignent, `MetaClientFactory.clientForTenant`, donc
 * un chemin d'envoi futur en hérite sans que personne y pense.
 *
 * ⚠️ ELLE NE REMPLACE PAS le débit choisi par campagne, elle s'y AJOUTE, en série. Le débit de campagne dit
 * « à quelle vitesse je veux que CETTE campagne parte » (1 à 80/min, c'est une fonctionnalité) ; l'arbitre dit
 * « ce numéro ne dépassera jamais ça, quoi qu'il arrive ». Une campagne seule à 80/min part donc toujours à
 * 80/min : c'est son propre frein qui est contraignant, pas l'arbitre. Deux campagnes à 80 se partagent 80 au
 * lieu d'en faire 160, et c'est tout le sujet.
 *
 * 🔴 CE QU'IL NE FAIT PAS, et qu'il ne faut pas se raconter : le budget est EN MÉMOIRE, donc PAR PROCESS.
 * L'API et le worker en ont chacun un. Le worker porte tout le volume (campagnes, scénarios, automations) ;
 * l'API ne porte que les envois d'un humain qui tape dans l'inbox, à une cadence humaine. Le pire cas
 * théorique est donc deux fois le plafond, dans un scénario où un opérateur enverrait à la machine pendant
 * une campagne. Rendre le budget réellement partagé (base ou affectation exclusive d'un numéro à un worker)
 * est le PRÉREQUIS du second worker, pas de celui-ci.
 *
 * Le RCS n'est pas concerné : il ne passe pas par Meta, il a ses propres quotas fournisseur, et les mélanger
 * ferait qu'une campagne RCS ralentirait WhatsApp sans raison.
 */
export interface ArbitreDeDebit {
  /** La porte de CE numéro. Toujours la MÊME instance pour un même numéro : c'est ce qui la rend partagée. */
  pour(phoneNumberId: string): PorteDeDebit;
}

/** Porte ouverte : aucun frein. Sert à l'opt-out (`parMinute <= 0`), même convention que le reste du dépôt. */
const PORTE_OUVERTE: PorteDeDebit = { acquire: async () => {} };

/**
 * @param parMinute plafond d'envois par minute et par numéro. `<= 0` = aucun frein (opt-out assumé).
 * @param fabrique injectable pour les tests (horloge et sommeil pilotés).
 */
export function arbitreDeDebit(
  parMinute: number,
  fabrique: (minIntervalMs: number) => PorteDeDebit = (ms) => new RateLimiter(ms),
): ArbitreDeDebit {
  if (parMinute <= 0) return { pour: () => PORTE_OUVERTE };
  const minIntervalMs = Math.ceil(60_000 / parMinute);
  // Clés = identifiants de numéro Meta : leur nombre est borné par la clientèle et ils sont stables. Pas de
  // balayage, contrairement au micro-cache des compteurs : une porte oubliée pèse quelques octets, et
  // l'oublier ferait perdre l'historique de débit d'un numéro qui revient.
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
