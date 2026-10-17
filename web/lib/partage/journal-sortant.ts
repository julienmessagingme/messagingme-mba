/** Réponse d'un envoi interactif déjà accepté par le fournisseur. */
export interface ReponseEnvoiInteractif {
  messageId: string;
  journal: 'recorded' | 'unrecorded';
}
