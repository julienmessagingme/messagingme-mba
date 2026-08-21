/**
 * Qui a le droit d'écrire dans une conversation, selon son affectation.
 *
 * Fonction PURE et isolée, appelée par toutes les routes d'écriture de l'inbox. Une règle d'accès recopiée
 * dans chaque route diverge au premier ajustement, et c'est la route oubliée qui devient la faille.
 *
 * La règle, telle qu'elle a été décidée :
 *   - conversation NON affectée -> tout le monde peut répondre, agents compris ;
 *   - conversation affectée     -> seul l'agent désigné ;
 *   - manager et admin          -> peuvent TOUJOURS reprendre la main.
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
