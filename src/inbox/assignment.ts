/**
 * Qui a le droit d'écrire dans une conversation, selon son affectation.
 *
 * Fonction PURE et isolée, appelée par toutes les routes d'écriture de l'inbox. Une règle d'accès recopiée
 * dans chaque route diverge au premier ajustement, et c'est la route oubliée qui devient la faille.
 *
 * La règle, telle qu'elle a été décidée :
 *   - conversation NON affectée -> tout le monde peut répondre, agents compris ;
 *   - conversation affectée     -> seul l'agent désigné ;
 *   - manager et admin          -> peuvent TOUJOURS reprendre la main ;
 *   - un agent peut PRENDRE une conversation non affectée si l'espace l'y autorise (`peutPrendre`), et
 *     jamais la passer à quelqu'un d'autre.
 *
 * ⚠️ C'est la seule barrière qui compte. Griser un bouton à l'écran n'empêche personne d'appeler l'API : le
 * refus doit venir du serveur, l'écran n'étant qu'un confort.
 */
export interface ActeurConversation {
  userId: string | null;
  role: string | null;
}

/** Peut-on écrire dans cette conversation ? `assignedTo` null = personne ne se l'est vu confier. */
export function peutEcrire(acteur: ActeurConversation, assignedTo: string | null): boolean {
  if (assignedTo === null) return true;
  if (acteur.role === 'admin' || acteur.role === 'manager') return true;
  // Un acteur sans identité (câblage sans authentification) n'est PAS l'agent affecté : fail-closed.
  return acteur.userId !== null && acteur.userId === assignedTo;
}

/** Peut-on AFFECTER une conversation ? Réservé aux managers et aux admins. */
export function peutAffecter(acteur: ActeurConversation): boolean {
  return acteur.role === 'admin' || acteur.role === 'manager';
}

/**
 * Peut-on PRENDRE cette conversation, c'est-à-dire se l'affecter à SOI (migration 0160) ?
 *
 * 🔴 PRENDRE, JAMAIS RÉAFFECTER : c'est l'arbitrage de Julien du 2026-09-19, mot pour mot « un agent ne peut
 * pas réaffecter de conversations, ni les siennes, ni celles du pot commun, en revanche il peut prendre parmi
 * celles du pot commun ». Trois conditions, et chacune ferme une porte :
 *   - la conversation est à PERSONNE : prendre celle d'un collègue serait la lui retirer ;
 *   - l'espace l'a AUTORISÉ (`tenant_settings.agents_peuvent_prendre`, réglé par un admin ou un manager) ;
 *   - l'acteur a une IDENTITÉ : sans elle, il n'y a personne à qui l'affecter (fail-closed).
 *
 * ⚠️ L'ENCADREMENT PEUT TOUJOURS PRENDRE, réglage ou pas : il peut déjà tout affecter à n'importe qui, se
 * l'affecter à soi en fait partie. Le réglage ne gouverne QUE les agents.
 *
 * ⚠️ UNE SEULE RÈGLE POUR DEUX LECTEURS : la route qui écrit, et le drapeau que la liste rend pour que
 * l'écran montre le bouton. Écrites deux fois, elles finiraient par proposer un geste que le serveur refuse.
 */
export function peutPrendre(acteur: ActeurConversation, assignedTo: string | null, agentsPeuventPrendre: boolean): boolean {
  if (assignedTo !== null || acteur.userId === null) return false;
  return peutAffecter(acteur) || agentsPeuventPrendre;
}

/**
 * Voit-on TOUT, quelle que soit l'affectation ? Managers et admins.
 *
 * ⚠️ Exactement la même frontière que `peutAffecter`, mais ce n'est PAS la même question : l'une donne le
 * droit de distribuer le travail, l'autre celui de le voir. Les confondre en une seule fonction ferait qu'en
 * bougeant l'une on bougerait l'autre sans s'en apercevoir.
 */
export function voitTout(acteur: ActeurConversation): boolean {
  return acteur.role === 'admin' || acteur.role === 'manager';
}

/**
 * LA MÊME RÈGLE QUE `peutEcrire`, EN SQL, pour les compteurs qui ne peuvent pas la faire tourner ligne à
 * ligne. `c` est l'alias de `conversations`.
 *
 * 🔴 DEUX ÉCRITURES D'UNE MÊME RÈGLE, ET C'EST ASSUMÉ : une pastille se calcule en une requête sur toute la
 * base, on ne va pas rapatrier les conversations pour leur appliquer une fonction. Ce qui rend la
 * duplication tenable, c'est qu'elles vivent DANS LE MÊME FICHIER, sous les yeux l'une de l'autre, et qu'un
 * test d'intégration vérifie qu'elles rendent le MÊME verdict sur les mêmes lignes.
 *
 * ⚠️ `assigned_to is null` D'ABORD : une conversation que personne ne s'est vu confier appartient au pot
 * commun, et tout le monde doit la voir, sinon une conversation non affectée n'allumerait la pastille de
 * personne et resterait invisible jusqu'à ce qu'un manager la distribue.
 */
export function visibiliteSql(paramVoitTout: string, paramUserId: string): string {
  return `(${paramVoitTout}::boolean or c.assigned_to is null or c.assigned_to = ${paramUserId}::uuid)`;
}
