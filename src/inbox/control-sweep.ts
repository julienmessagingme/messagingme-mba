import type { ControlOwner } from './store.pg';

/** Ce dont le balayage a besoin (interface étroite, satisfaite par PgInboxStore). */
export interface ControlSweepDeps {
  listHeldControl(
    limit?: number,
  ): Promise<Array<{ tenantId: string; waId: string; owner: ControlOwner; changedAt: Date | null }>>;
  setControlOwner(
    tenantId: string,
    waId: string,
    owner: ControlOwner,
    opts?: { only?: readonly ControlOwner[] },
  ): Promise<boolean>;
  /**
   * Délai d'inactivité par détenteur, en ms. C'est le DÉFAUT du serveur : il s'applique aux clients qui
   * n'ont rien réglé. 0 ou absent = cet état n'est jamais repris automatiquement.
   */
  timeouts: Partial<Record<ControlOwner, number>>;
  /**
   * Réglage PAR CLIENT de la durée du gel humain, en ms. Absent de la Map = ce client n'a rien réglé, on
   * applique le défaut ci-dessus. Une valeur 0 = ce client ne veut aucune reprise automatique.
   *
   * Ne concerne QUE `app_human` : c'est la seule durée qui relève d'un arbitrage métier du client (combien
   * de temps on laisse un opérateur travailler tranquille). Le délai `mba` reste un garde-fou technique.
   */
  handbackMsByTenant?(tenantIds: readonly string[]): Promise<Map<string, number>>;
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

  // Le lot ramène TOUTES les conversations détenues, sans filtre d'âge : le délai humain est réglable par
  // client et peut être plus court que le défaut du serveur, donc un filtre SQL basé sur le défaut
  // raterait silencieusement les conversations des clients pressés.
  const held = await deps.listHeldControl();
  if (held.length === 0) return 0;

  // Un seul aller-retour pour tous les clients du lot, au lieu d'une requête par conversation.
  const parTenant = deps.handbackMsByTenant
    ? await deps.handbackMsByTenant([...new Set(held.map((c) => c.tenantId))])
    : new Map<string, number>();

  let rendues = 0;
  for (const c of held) {
    // Le réglage du client prime sur le défaut du serveur, et UNIQUEMENT sur le gel humain : c'est la
    // seule durée qui relève d'un arbitrage métier (combien de temps on laisse un opérateur travailler).
    const reglageClient = c.owner === 'app_human' ? parTenant.get(c.tenantId) : undefined;
    const ms = reglageClient ?? deps.timeouts[c.owner];
    // Absent ou 0 = jamais de reprise automatique pour cet état. Un client qui pose 0 garde la main
    // jusqu'à ce qu'un opérateur la rende explicitement, c'est un choix légitime.
    if (ms === undefined || ms <= 0) continue;
    // `changedAt` null = bascule antérieure à la migration 0040, donc éligible (sinon ces conversations
    // resteraient bloquées pour toujours, ce qui est exactement ce que ce balayage existe pour éviter).
    if (c.changedAt !== null && now() - c.changedAt.getTime() < ms) continue;
    // `only` sur le détenteur LU : si une bascule est survenue entre la lecture et l'écriture (un opérateur
    // qui reprend la main juste à cet instant), la garde refuse et on ne détruit pas un contrôle tout neuf.
    if (await deps.setControlOwner(c.tenantId, c.waId, 'app_workflow', { only: [c.owner] })) rendues += 1;
  }
  return rendues;
}
