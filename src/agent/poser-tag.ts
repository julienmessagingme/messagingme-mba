/**
 * Poser un tag depuis un agent : sur le contact, dans le référentiel du tenant, et l'événement « tag ajouté »
 * qui déclenche les automations.
 *
 * 🔴 L'émission est légitime ici parce qu'un tour d'agent est un démarrage unitaire (une session, un contact) :
 * aucun chemin de masse ne passe par ce module. Et seulement si le tag est nouveau, sinon un agent qui le
 * repose à chaque tour relancerait l'automation (donc un message au contact) à chaque fois.
 */

export interface DepsPoserTagAgent {
  /** Pose le tag sur le contact et rend ceux qui étaient réellement nouveaux. */
  ajouterAuContact(tenantId: string, waId: string, tag: string): Promise<{ added: string[] }>;
  /** Déclare le tag dans le référentiel du tenant (Contenus > Tags). Best-effort : n'échoue jamais l'action. */
  declarer(tenantId: string, tag: string): Promise<void>;
  /** Publie « tag ajouté » sur la file d'automations. */
  emettre(tenantId: string, waId: string, tag: string): Promise<void>;
}

/** Même normalisation que les autres poses de tag : sans elle, « vip » et « vip  » seraient deux tags. */
export function normaliserTag(tag: string): string {
  return tag.trim().slice(0, 64);
}

export function creerPoserTagAgent(deps: DepsPoserTagAgent): (tenantId: string, waId: string, tag: string) => Promise<void> {
  return async (tenantId, waId, tag) => {
    const propre = normaliserTag(tag);
    if (propre === '') return;
    const { added } = await deps.ajouterAuContact(tenantId, waId, propre);
    // Best-effort : un référentiel incomplet est un désagrément, un outil qui lève est un tour d'agent mort.
    try { await deps.declarer(tenantId, propre); } catch { /* best-effort */ }
    if (added.length === 0) return;
    await deps.emettre(tenantId, waId, propre);
  };
}
