/**
 * QUEL DESSIN POUR QUEL OUTIL. Le nom des signes, et la traduction depuis les outils maison d'un agent IA.
 *
 * Module PUR et SANS import, comme `lib/range.ts` : il est partagé par le catalogue des types de l'agent de
 * Meta (`lib/mba-outils.ts`, une lib) et par le composant qui dessine (`components/IconeOutil.tsx`). Le
 * mettre dans le composant aurait fait importer un composant par une lib.
 *
 * 🔴 UN SIGNE EST UNE FAMILLE D'ACTES, PAS UN TYPE D'OUTIL, et c'est ce qui permet UN SEUL jeu de dessins
 * pour les deux écrans. « Poser un tag » est le type `tag` chez l'agent de Meta et le handler `poser_tag`
 * chez un agent IA : même geste, donc même dessin. Deux jeux d'icônes auraient divergé au premier ajout, et
 * le client aurait vu deux images pour la même chose selon l'écran.
 */

/** Les familles d'actes qu'un outil peut accomplir. Une de plus = un dessin de plus dans `IconeOutil`. */
export type SigneOutil =
  | 'tag'
  | 'info'
  | 'bloc'
  | 'scenario'
  | 'connecteur'
  | 'recherche'
  | 'contact'
  | 'humain'
  | 'fin';

/**
 * Le signe d'un outil maison d'un agent IA, depuis son `handler` (`src/agent/outils-maison.ts`).
 *
 * ⚠️ `null` POUR UN HANDLER INCONNU, ET L'APPELANT N'AFFICHE ALORS RIEN. Un handler inconnu arrive vraiment :
 * le catalogue vit côté serveur, donc une console plus ancienne que l'API en verra un qu'elle ne connaît pas.
 * Un dessin par défaut serait pire qu'aucun, il affirmerait une nature que personne n'a vérifiée.
 */
export function signeDuHandler(handler: string): SigneOutil | null {
  switch (handler) {
    case 'poser_tag': return 'tag';
    case 'ecrire_variable': return 'info';
    case 'envoyer_bloc': return 'bloc';
    case 'chercher_connaissance': return 'recherche';
    case 'lire_contact': return 'contact';
    case 'escalader': return 'humain';
    case 'terminer': return 'fin';
    default: return null;
  }
}
