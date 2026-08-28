/**
 * Poser un tag DEPUIS UN AGENT, en TROIS effets.
 *
 * C'est un module à part, minuscule, pour la même raison que `escalade.ts` : ce qu'il apporte n'est pas le
 * code, c'est la règle, et cette règle a déjà menti une fois. L'outil `mba_poser_tag` posait le tag sur le
 * contact et s'arrêtait là, alors que sa description, montrée au client dans la console, promet « pour le
 * retrouver dans le mini-CRM ou DÉCLENCHER UNE AUTOMATION ». Un client qui règle une automation sur tag et
 * instruit son agent de le poser ne voyait jamais rien se déclencher, en silence.
 *
 * 🔴 POURQUOI L'ÉMISSION EST LÉGITIME ICI. La règle du dépôt est que l'émission d'un événement d'automation
 * est gouvernée par le CHEMIN appelant, et que le défaut est « n'émet pas » : l'exécuteur de scénario sert
 * AUSSI les campagnes, où poser un tag sur 5 000 destinataires enfilerait 5 000 événements. Un tour d'agent
 * est un démarrage UNITAIRE par construction (une session, une conversation, un contact), au même titre
 * qu'une réponse de contact. Ce chemin-ci passe donc le drapeau, et aucun chemin de masse ne l'atteint.
 *
 * 🔴 ET SEULEMENT SI LE TAG EST NOUVEAU. Un agent qui repose le même tag à chaque tour relancerait
 * l'automation pour un non-événement, donc enverrait un message au contact à chaque fois qu'il se répète.
 */

export interface DepsPoserTagAgent {
  /** Pose le tag sur le contact et rend ceux qui étaient RÉELLEMENT nouveaux. */
  ajouterAuContact(tenantId: string, waId: string, tag: string): Promise<{ added: string[] }>;
  /** Déclare le tag dans le référentiel du tenant (Contenus > Tags). Best-effort : n'échoue jamais l'action. */
  declarer(tenantId: string, tag: string): Promise<void>;
  /** Publie « tag ajouté » sur la file d'automations. */
  emettre(tenantId: string, waId: string, tag: string): Promise<void>;
}

/** Même normalisation que partout ailleurs (`applyTag`, `removeTag`, les routes de contacts) : sans elle,
 *  « vip » et « vip  » seraient deux tags, et un tag de plus de 64 caractères serait tronqué d'un seul côté. */
export function normaliserTag(tag: string): string {
  return tag.trim().slice(0, 64);
}

export function creerPoserTagAgent(deps: DepsPoserTagAgent): (tenantId: string, waId: string, tag: string) => Promise<void> {
  return async (tenantId, waId, tag) => {
    const propre = normaliserTag(tag);
    if (propre === '') return;
    const { added } = await deps.ajouterAuContact(tenantId, waId, propre);
    // La déclaration ne doit jamais faire échouer la pose : un référentiel incomplet est un désagrément, un
    // outil qui lève est un tour d'agent mort.
    try { await deps.declarer(tenantId, propre); } catch { /* best-effort */ }
    if (added.length === 0) return;
    await deps.emettre(tenantId, waId, propre);
  };
}
