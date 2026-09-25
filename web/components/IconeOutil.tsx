import type { SigneOutil } from '@/lib/signes-outils';
import { Icone, type NomIcone, type TailleIcone } from '@/components/Icone';

/**
 * LE PETIT DESSIN D'UN OUTIL, devant son nom (demande de Julien du 2026-09-24 : « des petites icônes en face
 * de chaque type d'outil qu'on peut rajouter, et qu'on les retrouve dans la liste des outils déployés »).
 *
 * 🔴 MASQUÉ AUX LECTEURS D'ÉCRAN, COMME LA PASTILLE DE L'EN-TÊTE D'AGENT, et pour la même raison : c'est un
 * DESSIN, pas un mot. Le nom de l'outil est écrit en toutes lettres juste à côté, donc un lecteur d'écran qui
 * annoncerait l'icône répéterait l'information, ou pire, la nommerait autrement que l'écran. Et un `alt`
 * entrerait dans le nom accessible du bouton qui l'entoure, ce qui casse toute recherche par ce nom.
 *
 * Les dessins viennent de la famille d'icônes de la console (`components/Icone.tsx`, Phosphor) depuis le
 * 2026-09-25 : ils étaient tracés à la main, en traits de 1,8, à côté d'icônes qui n'avaient pas la même
 * épaisseur. Un même geste garde son dessin partout : « transfert à un humain » est le casque du bloc
 * « Assigner à un agent » du builder.
 */
export function IconeOutil({ signe, taille = 'ligne', className }: { signe: SigneOutil; taille?: TailleIcone; className?: string }) {
  return <Icone nom={DESSINS[signe]} taille={taille} {...(className ? { className } : {})} />;
}

/**
 * Les neuf dessins. `Record` EXHAUSTIF : ajouter un signe sans son dessin ne compile pas, ce qui est
 * exactement la garde qu'on veut ici (une icône manquante ne se voit pas en relisant du code).
 */
const DESSINS: Record<SigneOutil, NomIcone> = {
  tag: 'etiquette',
  info: 'modifier',
  bloc: 'message',
  scenario: 'scenario',
  connecteur: 'outils',
  recherche: 'rechercher',
  contact: 'contact',
  humain: 'humain',
  fin: 'fin',
};
