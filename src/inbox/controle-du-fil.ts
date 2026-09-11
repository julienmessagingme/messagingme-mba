/**
 * LES DEUX GESTES DE CONTRÔLE DU FIL chez Meta (`thread_control`) : le PRENDRE et le RENDRE.
 *
 * 🔴 POURQUOI CE MODULE EXISTE, ALORS QUE LE GESTE ÉTAIT DÉJÀ ÉCRIT. Il vivait dans une fermeture de
 * `buildWorkflowRuntime`, donc atteignable du WORKER seulement. Le bouton de l'Inbox, lui, est servi par
 * l'API : il ne pouvait pas l'appeler, et il s'est contenté d'écrire notre état local pendant que Meta
 * continuait de croire que NOUS tenions le fil. Vécu le 2026-09-10 : Julien rend la main, écrit sur
 * WhatsApp, et l'agent de Meta reste muet. Recopier la fonction en aurait fait le troisième doublon de cette
 * famille, après le constructeur de composants Meta et la préparation des visuels de carousel, qui ont chacun
 * cassé la production le 2026-08-15.
 *
 * 🔴 CE FICHIER A AFFIRMÉ QU'IL N'Y AVAIT PAS D'ACTION `take`, ET C'ÉTAIT FAUX. Il s'appuyait sur le corpus
 * OpenAPI v1.0.0 téléchargé dans `mba documentation/`, qui n'énumère que `pass` et `release`. Mais un corpus
 * téléchargé est un INSTANTANÉ : Meta a réécrit la page le 2026-08-13 pour ajouter `take`, et la
 * documentation vivante, relue le 2026-09-11, l'énumère bien. Le prix de cette erreur a été exactement le
 * bug signalé par Julien ce soir-là : « Reprendre la main » n'éteignait pas l'agent de Meta, qui se
 * remettait à répondre au message suivant du client.
 *
 * ⚠️ LA LEÇON N'EST PAS « Meta bouge », C'EST QU'UN DOCUMENT TÉLÉCHARGÉ NE VIEILLIT PAS TOUT SEUL. Il a
 * l'air d'une source primaire et il n'en est plus une. Quand un point de contrat décide d'un comportement
 * produit, il se relit EN LIGNE.
 *
 * ⚠️ LES DEUX GESTES NE SONT PAS SYMÉTRIQUES POUR AUTANT. Rendre est un droit (« you must currently hold
 * thread control »), prendre est un PRIVILÈGE : Meta le réserve au « configured escalation partner », notion
 * qu'il ne définit nulle part. Un refus de `take` est donc un cas normal, et la porte de secours reste
 * vraie dans tous les cas : ÉCRIRE prend le fil à coup sûr (mesuré le 2026-09-10, l'entrant suivant arrive
 * en `field: "messages"` et non plus en `standby`).
 */

/**
 * Ce dont les gestes ont besoin. Interface étroite : satisfaite par le worker comme par l'API.
 *
 * ⚠️ `clientMba` promet les DEUX actes. Un client qui n'en porterait qu'un ne compile pas, ce qui est le
 * seul moyen d'éviter que la moitié du couple reparte vivre ailleurs.
 */
export interface ControleDuFilDeps {
  /** Numéro Meta du client. `null` = aucun numéro connecté, il n'y a aucun fil à contrôler. */
  numeroDuTenant(tenantId: string): Promise<string | null>;
  clientMba(tenantId: string): Promise<{
    releaseThread(phoneNumberId: string, waId: string): Promise<unknown>;
    takeThread(phoneNumberId: string, waId: string): Promise<unknown>;
  }>;
}

export function creerRendreLeFil(deps: ControleDuFilDeps) {
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

export function creerPrendreLeFil(deps: ControleDuFilDeps) {
  /**
   * Prend le fil à l'agent de Meta SANS écrire au client. Rend `true` si Meta a confirmé, `false` s'il n'y
   * avait aucun numéro connecté.
   *
   * 🔴 LÈVE si Meta refuse, pour la MÊME raison que son jumeau, et elle compte davantage ici : un opérateur
   * qui croit avoir éteint l'agent de Meta ne surveille plus la conversation. Le silence serait le pire des
   * retours.
   */
  return async function prendreLeFil(tenantId: string, waId: string): Promise<boolean> {
    const phoneNumberId = await deps.numeroDuTenant(tenantId);
    if (!phoneNumberId) return false;
    const client = await deps.clientMba(tenantId);
    await client.takeThread(phoneNumberId, waId);
    return true;
  };
}
