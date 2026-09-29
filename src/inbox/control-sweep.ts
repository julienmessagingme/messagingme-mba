import type { ControlOwner } from './store.pg';
import type { ControleDuFil } from './fil';
import { FENETRE_SERVICE_MS } from '../workflow/engine';

/**
 * La fenêtre de service client de Meta : 24 h depuis le dernier message entrant. Au-delà, aucun échange sans
 * template, et aucune passation de fil n'a de sens. Une constante et pas un réglage : ce délai appartient à
 * Meta.
 */
const FENETRE_META_MS = FENETRE_SERVICE_MS;

/** Ce dont le balayage a besoin : la liste des fils détenus, ses délais, et le geste qui rend un fil. */
export interface ControlSweepDeps {
  /** Les conversations et leur détenteur (interface étroite, satisfaite par PgInboxStore). */
  inbox: {
    /**
     * Les conversations dont le fil est détenu. `ageScenarioMs` ne ramène que les fils de scénario plus vieux que
     * ce délai : `app_workflow` est l'état normal, les ramener tous saturerait le lot au détriment des fils humains.
     */
    listHeldControl(
      limit?: number,
      ageScenarioMs?: number,
    ): Promise<Array<{ tenantId: string; waId: string; owner: ControlOwner; changedAt: Date | null; lastMessageAt: Date | null; escaladee: boolean }>>;
  };
  /**
   * Délai d'inactivité par détenteur, en ms : le défaut du serveur pour les clients qui n'ont rien réglé. 0 ou
   * absent = cet état n'est jamais repris automatiquement.
   */
  timeouts: Partial<Record<ControlOwner, number>>;
  /** Les réglages des clients. */
  reglages?: {
    /**
     * Réglage par client de la durée du gel humain, en ms (absent = défaut, 0 = aucune reprise). Ne concerne que
     * `app_human`, seule durée qui relève d'un arbitrage métier ; le délai `mba` est un garde-fou technique.
     */
    handbackMsByTenant?(tenantIds: readonly string[]): Promise<Map<string, number>>;
    /**
     * L'agent de Meta est-il allumé chez ce client ? Décide de la destination d'un fil rendu : l'agent quand il
     * est là, le scénario sinon. Absent -> aucun tenant n'a MBA.
     */
    mbaActifParTenant?(tenantIds: readonly string[]): Promise<Set<string>>;
  };
  /**
   * Le geste qui rend un fil (`src/inbox/fil.ts`) : vers `mba`, Meta d'abord (le contact sur la liste de l'agent,
   * puis `release`), et un refus, une absence de numéro ou un fil de test empêchent la bascule, sinon notre colonne annoncerait
   * `mba` quand Meta pense le contraire. Il efface le drapeau d'escalade : une escalade en cours est sautée avant,
   * donc un drapeau qui subsiste est périmé, et le laisser l'armerait pour le jour où le fil redeviendrait humain.
   */
  fil: Pick<ControleDuFil, 'rendreApresInactivite'>;
  now?: () => number;
}

/**
 * Rend la main au scénario (ou à l'agent de Meta) sur les conversations que plus personne ne traite. Meta n'a
 * aucun release automatique : sans ce balayage, un opérateur qui ferme son onglet ou un worker qui meurt
 * gèlerait la conversation indéfiniment. Rend le nombre de conversations réellement rendues.
 */
export async function runControlSweep(deps: ControlSweepDeps): Promise<number> {
  const now = deps.now ?? (() => Date.now());

  // Les fils tenus par un humain ou par l'agent de Meta reviennent sans filtre d'âge : leurs délais sont
  // réglables par client, un filtre SQL sur le défaut raterait les clients pressés. Les fils de scénario, au
  // délai fixe, sont filtrés en SQL, sinon ces fils sains satureraient le lot. 0 ou absent = aucun.
  const held = await deps.inbox.listHeldControl(undefined, deps.timeouts.app_workflow ?? 0);
  if (held.length === 0) return 0;

  // Un seul aller-retour pour tous les clients du lot, au lieu d'une requête par conversation.
  const tenantIds = [...new Set(held.map((c) => c.tenantId))];
  const parTenant = deps.reglages?.handbackMsByTenant
    ? await deps.reglages.handbackMsByTenant(tenantIds)
    : new Map<string, number>();
  // Un seul aller-retour aussi pour savoir qui a l'agent de Meta allumé.
  const avecMba = deps.reglages?.mbaActifParTenant ? await deps.reglages.mbaActifParTenant(tenantIds) : new Set<string>();

  let rendues = 0;
  for (const c of held) {
    // Le réglage du client prime sur le défaut, et seulement pour le gel humain.
    const reglageClient = c.owner === 'app_human' ? parTenant.get(c.tenantId) : undefined;
    const ms = reglageClient ?? deps.timeouts[c.owner];
    // Une escalade sans réponse ne revient pas à l'agent : le client attend un humain. La première réponse d'un
    // opérateur efface l'escalade, et le délai habituel court ensuite.
    if (c.owner === 'app_human' && c.escaladee) continue;
    // Absent ou 0 = jamais de reprise automatique pour cet état : un client qui pose 0 garde la main.
    if (ms === undefined || ms <= 0) continue;
    // `changedAt` null = bascule ancienne, donc éligible (sinon bloquée pour toujours).
    if (c.changedAt !== null && now() - c.changedAt.getTime() < ms) continue;
    // Destination : l'agent de Meta s'il est allumé chez ce client, le scénario sinon (`app_workflow` rend aussi
    // la main, puisqu'un parcours reprend le fil pour de vrai). On ne passe pas la main sur une fenêtre fermée : l'agent
    // ne prendrait rien et personne ne répondrait. On saute, sans replier sur `app_workflow` que « À traiter »
    // exclut. `lastMessageAt` prouve une fenêtre fermée, pas une fenêtre ouverte.
    const fenetreOuverte = c.lastMessageAt !== null && now() - c.lastMessageAt.getTime() < FENETRE_META_MS;
    const versMba = (c.owner === 'app_human' || c.owner === 'app_workflow') && avecMba.has(c.tenantId);
    // La garde ne porte que sur `versMba` : une transition qui ne parle pas à Meta n'a rien à faire d'une fenêtre.
    if (versMba && !fenetreOuverte) continue;
    /**
     * Refuser d'écrire ne gèle rien, la conversation reste visible et ce balayage repasse : un refus de Meta, une
     * absence de numéro ou un fil de test font sauter la ligne, sans repli sur `app_workflow` qui la sortirait de
     * « À traiter ». Le coût est un réexamen à chaque passe. Résidu assumé : la garde `only` ne protège pas d'un
     * « Reprendre la main » cliqué pendant l'appel Meta (course fugace, réparée par un second clic).
     */
    if (!(await deps.fil.rendreApresInactivite(c.tenantId, c.waId, c.owner, versMba ? 'mba' : 'app_workflow'))) continue;
    rendues += 1;
  }
  return rendues;
}
