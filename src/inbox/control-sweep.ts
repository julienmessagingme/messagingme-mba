import type { ControlOwner } from './store.pg';

/** Ce dont le balayage a besoin (interface étroite, satisfaite par PgInboxStore). */
export interface ControlSweepDeps {
  listStaleControl(
    olderThan: Date,
    limit?: number,
  ): Promise<Array<{ tenantId: string; waId: string; owner: ControlOwner; changedAt: Date | null }>>;
  setControlOwner(
    tenantId: string,
    waId: string,
    owner: ControlOwner,
    opts?: { only?: readonly ControlOwner[] },
  ): Promise<boolean>;
  /** Délai d'inactivité par détenteur, en ms. 0 ou absent = cet état n'est jamais repris automatiquement. */
  timeouts: Partial<Record<ControlOwner, number>>;
  now?: () => number;
}

/**
 * Rend la main au scénario sur les conversations que plus personne ne traite.
 *
 * Raison d'être : il n'existe AUCUN release automatique côté Meta. Sans ce balayage, un opérateur qui ferme
 * son onglet, ou un worker qui meurt, gèlerait la conversation indéfiniment, avec le scénario muet et le
 * client sans réponse. C'est la soupape de la capacité de gel, et elle doit partir dans le même
 * déploiement qu'elle.
 *
 * Extrait de `main()` pour être testable, comme ses jumeaux `campaign/schedule-sweep` et `analysis/sweep`.
 *
 * Renvoie le nombre de conversations réellement rendues.
 */
export async function runControlSweep(deps: ControlSweepDeps): Promise<number> {
  const now = deps.now ?? (() => Date.now());
  const actifs = Object.values(deps.timeouts).filter((ms): ms is number => typeof ms === 'number' && ms > 0);
  if (actifs.length === 0) return 0; // reprise automatique entièrement désactivée

  // On lit avec le délai le PLUS COURT, donc le prédicat le plus large : lire avec le plus long raterait
  // les conversations dont l'état a un délai court et qui viennent juste d'échoir.
  const stale = await deps.listStaleControl(new Date(now() - Math.min(...actifs)));

  let rendues = 0;
  for (const c of stale) {
    const ms = deps.timeouts[c.owner];
    // Un état sans délai configuré (ou à 0) n'est jamais repris : c'est le sens de « désactivé ».
    if (ms === undefined || ms <= 0) continue;
    // Refiltrage par état : la requête a ramené large, chaque détenteur applique ensuite SON délai.
    // `changedAt` null = bascule antérieure à la migration 0040, donc éligible (sinon ces conversations
    // resteraient bloquées pour toujours, ce qui est exactement ce que ce balayage existe pour éviter).
    if (c.changedAt !== null && now() - c.changedAt.getTime() < ms) continue;
    // `only` sur le détenteur LU : si une bascule est survenue entre la lecture et l'écriture (un opérateur
    // qui reprend la main juste à cet instant), la garde refuse et on ne détruit pas un contrôle tout neuf.
    if (await deps.setControlOwner(c.tenantId, c.waId, 'app_workflow', { only: [c.owner] })) rendues += 1;
  }
  return rendues;
}
