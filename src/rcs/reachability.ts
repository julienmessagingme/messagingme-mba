import type { RcsProvider } from './types';

/** 7 jours. Un parc mobile ne bascule pas en RCS d'une heure à l'autre, et un appel de capacité par
 *  destinataire sur une campagne de 5 000 numéros est inacceptable. */
export const TTL_MS = 7 * 86_400_000;

export interface ReachabilityStore {
  get(agentId: string, e164: string): Promise<{ reachable: boolean; checkedAt: number } | null>;
  put(agentId: string, e164: string, reachable: boolean, atMs: number): Promise<void>;
}

/**
 * Joignabilité RCS d'un numéro, mise en cache par agent.
 *
 * Une entrée périmée est RÉINTERROGÉE, jamais supprimée : si le provider tombe, on sert la vieille réponse
 * plutôt que d'arrêter une campagne. En revanche, sans aucune entrée, l'erreur remonte : deviner « joignable »
 * enverrait dans le vide, deviner « non joignable » sauterait des destinataires en silence.
 */
export class Reachability {
  constructor(
    private readonly provider: RcsProvider,
    private readonly store: ReachabilityStore,
    private readonly now: () => number = Date.now,
  ) {}

  async isReachable(agentId: string, e164: string): Promise<boolean> {
    const at = this.now();
    const enCache = await this.store.get(agentId, e164);
    if (enCache && at - enCache.checkedAt <= TTL_MS) return enCache.reachable;
    try {
      const caps = await this.provider.capabilities(agentId, e164);
      const reachable = caps !== null;
      await this.store.put(agentId, e164, reachable, at);
      return reachable;
    } catch (e) {
      if (enCache) return enCache.reachable;
      throw e;
    }
  }
}
