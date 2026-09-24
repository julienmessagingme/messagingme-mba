import type { RcsProvider } from './types';

/** 7 jours. Un parc mobile ne bascule pas en RCS d'une heure à l'autre, et un appel de capacité par
 *  destinataire sur une campagne de 5 000 numéros est inacceptable. */
export const TTL_MS = 7 * 86_400_000;

/**
 * Ce que le cache DIT de la joignabilité RCS d'un numéro, sans jamais interroger le fournisseur (lecture de
 * fiche par l'API). `null` = inconnu : aucune entrée, ou une entrée PÉRIMÉE, qui ne vaut plus une mesure.
 * ⚠️ L'envoi, lui, garde sa propre règle (`Reachability.isReachable` sert une vieille réponse si le
 * fournisseur tombe) : ce n'est pas la même question.
 */
export function joignabiliteRcsConnue(entree: { reachable: boolean; checkedAt: number } | null, maintenantMs: number): boolean | null {
  if (!entree) return null;
  return maintenantMs - entree.checkedAt <= TTL_MS ? entree.reachable : null;
}

/**
 * La joignabilité CONNUE d'un numéro, lue sous ses DEUX formes de clé, la plus récente gagnant.
 *
 * 🔴 LE CACHE PORTE UN MÊME NUMÉRO SOUS DEUX FORMES, et c'est l'hypothèse muette que cette lecture doit
 * lever : `Reachability.isReachable` écrit la clé telle qu'on la lui passe, les campagnes passent `+33…`
 * (`toE164`), les scénarios et la réponse RCS de l'Inbox passent le `waId`, en chiffres seuls. Lire la seule
 * forme `+33…` rendait « inconnu » un numéro qu'un scénario venait de vérifier. Même précaution que
 * `PgRcsOptoutStore.isOptedOut`.
 */
export async function joignabiliteRcsToutesFormes(
  store: Pick<ReachabilityStore, 'get'>,
  agentId: string,
  e164: string,
  maintenantMs: number,
): Promise<boolean | null> {
  const nu = e164.replace(/[^0-9]/g, '');
  const [avecPlus, sansPlus] = await Promise.all([store.get(agentId, `+${nu}`), store.get(agentId, nu)]);
  const plusRecente = !avecPlus ? sansPlus : !sansPlus ? avecPlus : sansPlus.checkedAt > avecPlus.checkedAt ? sansPlus : avecPlus;
  return joignabiliteRcsConnue(plusRecente, maintenantMs);
}

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

  async isReachable(tenantId: string, agentId: string, e164: string): Promise<boolean> {
    const at = this.now();
    const enCache = await this.store.get(agentId, e164);
    if (enCache && at - enCache.checkedAt <= TTL_MS) return enCache.reachable;
    try {
      const caps = await this.provider.capabilities(tenantId, agentId, e164);
      const reachable = caps !== null;
      await this.store.put(agentId, e164, reachable, at);
      return reachable;
    } catch (e) {
      if (enCache) return enCache.reachable;
      throw e;
    }
  }
}
