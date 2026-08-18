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
  /**
   * L'agent de Meta est-il allumé chez ce client ? Décide de la DESTINATION d'un fil rendu : l'agent quand il
   * est là, le scénario sinon. Absent -> aucun tenant n'a MBA, donc comportement historique.
   */
  mbaActifParTenant?(tenantIds: readonly string[]): Promise<Set<string>>;
  /**
   * Rend effectivement le fil à Meta (`thread_control` action `release`). Appelé UNIQUEMENT quand la
   * destination est `mba`. Best-effort : un échec ne doit pas empêcher la bascule locale, sinon un fil resterait
   * gelé pour toujours à cause d'un hoquet réseau, ce que ce balayage existe précisément pour éviter.
   */
  releaseToMba?(tenantId: string, waId: string): Promise<void>;
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
  const tenantIds = [...new Set(held.map((c) => c.tenantId))];
  const parTenant = deps.handbackMsByTenant
    ? await deps.handbackMsByTenant(tenantIds)
    : new Map<string, number>();
  // Un seul aller-retour aussi pour savoir qui a l'agent de Meta allumé.
  const avecMba = deps.mbaActifParTenant ? await deps.mbaActifParTenant(tenantIds) : new Set<string>();

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
    // Destination : l'agent de Meta quand il est allumé chez ce client, le scénario sinon. Rien à arbitrer, la
    // règle se déduit de l'état du compte, ce qui est tout l'objet de la suppression du réglage de reprise.
    const versMba = c.owner === 'app_human' && avecMba.has(c.tenantId);
    const dest: ControlOwner = versMba ? 'mba' : 'app_workflow';
    if (!(await deps.setControlOwner(c.tenantId, c.waId, dest, { only: [c.owner] }))) continue;
    rendues += 1;
    // Bascule locale d'ABORD, appel Meta ensuite et en best-effort : l'inverse laisserait un fil gelé pour
    // toujours sur un hoquet réseau, ce que ce balayage existe pour éviter.
    if (versMba && deps.releaseToMba) {
      try {
        await deps.releaseToMba(c.tenantId, c.waId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`release vers MBA ignoré pour ${c.waId}:`, err instanceof Error ? err.message : err);
      }
    }
  }
  return rendues;
}
