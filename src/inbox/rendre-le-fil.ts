/**
 * Rendre le fil d'une conversation à l'agent de Meta (`thread_control`, action `release`).
 *
 * 🔴 POURQUOI CE MODULE EXISTE, ALORS QUE LE GESTE ÉTAIT DÉJÀ ÉCRIT. Il vivait dans une fermeture de
 * `buildWorkflowRuntime`, donc atteignable du WORKER seulement. Le bouton « rendre la main » de l'Inbox, lui,
 * est servi par l'API : il ne pouvait pas l'appeler, et il s'est contenté d'écrire notre état local pendant
 * que Meta continuait de croire que NOUS tenions le fil. Vécu le 2026-09-10 : Julien rend la main, écrit sur
 * WhatsApp, et l'agent de Meta reste muet. Recopier la fonction en aurait fait le troisième doublon de cette
 * famille, après le constructeur de composants Meta et la préparation des visuels de carousel, qui ont chacun
 * cassé la production le 2026-08-15.
 *
 * ⚠️ IL N'Y A PAS D'ACTION `take`, ET C'EST CE QUI REND CE GESTE ASYMÉTRIQUE. La spec OpenAPI v1.0.0 de Meta
 * n'a que deux valeurs, `pass` et `release`, et dit « currently only `release` is supported ». On ne PREND
 * donc jamais le fil : on le prend en ENVOYANT un message (mesuré le 2026-09-10 : après un envoi depuis
 * l'Inbox, l'entrant suivant est arrivé en `field: "messages"` et non plus en `standby`), et on le REND avec
 * cette fonction.
 */

/** Ce dont le geste a besoin. Interface étroite : satisfaite par le worker comme par l'API. */
export interface RendreLeFilDeps {
  /** Numéro Meta du client. `null` = aucun numéro connecté, il n'y a aucun fil à rendre. */
  numeroDuTenant(tenantId: string): Promise<string | null>;
  clientMba(tenantId: string): Promise<{ releaseThread(phoneNumberId: string, waId: string): Promise<unknown> }>;
}

export function creerRendreLeFil(deps: RendreLeFilDeps) {
  /**
   * Rend `true` si Meta a CONFIRMÉ, `false` s'il n'y avait rien à rendre (aucun numéro).
   *
   * 🔴 LÈVE si Meta refuse, et c'est délibéré : l'appelant doit pouvoir refuser d'écrire son état local. Un
   * `catch` silencieux ici recréerait exactement le défaut qu'on répare, un état local qui annonce ce que
   * Meta n'a pas fait. Le balayage automatique, lui, est best-effort et attrape de son côté (un fil ne doit
   * pas rester gelé pour toujours à cause d'un hoquet réseau).
   */
  return async function rendreLeFil(tenantId: string, waId: string): Promise<boolean> {
    const phoneNumberId = await deps.numeroDuTenant(tenantId);
    if (!phoneNumberId) return false;
    const client = await deps.clientMba(tenantId);
    await client.releaseThread(phoneNumberId, waId);
    return true;
  };
}
