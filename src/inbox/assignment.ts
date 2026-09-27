/**
 * Qui a le droit d'écrire dans une conversation, selon son affectation. Fonction pure, appelée par toutes les
 * routes d'écriture de l'inbox : une règle d'accès recopiée par route diverge, et la route oubliée devient la
 * faille.
 *
 *   - conversation non affectée -> tout le monde peut répondre, agents compris ;
 *   - conversation affectée     -> seul l'agent désigné ;
 *   - manager et admin          -> peuvent toujours reprendre la main ;
 *   - un agent peut prendre une conversation non affectée si l'espace l'y autorise, jamais la passer à un autre.
 *
 * 🔴 C'est la seule barrière qui compte : le refus doit venir du serveur, griser un bouton n'empêche personne
 * d'appeler l'API.
 */
export interface ActeurConversation {
  userId: string | null;
  role: string | null;
}

/** Peut-on écrire dans cette conversation ? `assignedTo` null = personne ne se l'est vu confier. */
export function peutEcrire(acteur: ActeurConversation, assignedTo: string | null): boolean {
  if (assignedTo === null) return true;
  if (acteur.role === 'admin' || acteur.role === 'manager') return true;
  // Un acteur sans identité (câblage sans authentification) n'est pas l'agent affecté : fail-closed.
  return acteur.userId !== null && acteur.userId === assignedTo;
}

/** Peut-on affecter une conversation ? Réservé aux managers et aux admins. */
export function peutAffecter(acteur: ActeurConversation): boolean {
  return acteur.role === 'admin' || acteur.role === 'manager';
}

/**
 * Peut-on prendre cette conversation, c'est-à-dire se l'affecter à soi ? Prendre, jamais réaffecter : la
 * conversation est à personne (prendre celle d'un collègue la lui retirerait), l'espace l'a autorisé
 * (`agents_peuvent_prendre`), et l'acteur a une identité (fail-closed). L'encadrement peut toujours prendre.
 * Une seule règle pour la route qui écrit et le drapeau qui montre le bouton.
 */
export function peutPrendre(acteur: ActeurConversation, assignedTo: string | null, agentsPeuventPrendre: boolean): boolean {
  if (assignedTo !== null || acteur.userId === null) return false;
  return peutAffecter(acteur) || agentsPeuventPrendre;
}

/**
 * Voit-on tout, quelle que soit l'affectation ? Managers et admins. Même frontière que `peutAffecter` mais pas
 * la même question (voir le travail, pas le distribuer) : les fusionner ferait bouger l'une avec l'autre.
 */
export function voitTout(acteur: ActeurConversation): boolean {
  return acteur.role === 'admin' || acteur.role === 'manager';
}

/**
 * La même règle que `peutEcrire`, en SQL, pour les compteurs (`c` = alias de `conversations`). Deux écritures
 * d'une règle, dans le même fichier, et un test d'intégration vérifie qu'elles rendent le même verdict.
 * `assigned_to is null` d'abord : une conversation du pot commun doit allumer la pastille de tout le monde.
 */
export function visibiliteSql(paramVoitTout: string, paramUserId: string): string {
  return `(${paramVoitTout}::boolean or c.assigned_to is null or c.assigned_to = ${paramUserId}::uuid)`;
}
