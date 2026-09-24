import type { SigneOutil } from '@/lib/signes-outils';

/**
 * LE PETIT DESSIN D'UN OUTIL, devant son nom (demande de Julien du 2026-09-24 : « des petites icônes en face
 * de chaque type d'outil qu'on peut rajouter, et qu'on les retrouve dans la liste des outils déployés »).
 *
 * 🔴 `aria-hidden`, COMME LA PASTILLE DE L'EN-TÊTE D'AGENT, et pour la même raison : ces traits sont un
 * DESSIN, pas un mot. Le nom de l'outil est écrit en toutes lettres juste à côté, donc un lecteur d'écran qui
 * annoncerait l'icône répéterait l'information, ou pire, la nommerait autrement que l'écran. Et un `alt`
 * entrerait dans le nom accessible du bouton qui l'entoure, ce qui casse toute recherche par ce nom.
 *
 * 🔴 AUCUNE BIBLIOTHÈQUE D'ICÔNES, ET C'EST DÉLIBÉRÉ. Le dépôt n'en a aucune (`lucide-react`, `heroicons`,
 * `react-icons` : zéro), et ses quelques SVG sont posés à la main là où ils servent. En ajouter une pour neuf
 * dessins ferait entrer un paquet entier dans le bundle du client pour en utiliser un pour cent.
 *
 * ⚠️ TRAITS ET NON SURFACES (`fill: none`, `stroke: currentColor`) : l'icône prend la couleur de son texte,
 * donc elle suit le gris d'un libellé, l'ambre d'un avertissement et le mode sombre sans une seule règle de
 * plus. Un `fill` codé en dur aurait fallu être redit à chaque endroit.
 */
export function IconeOutil({ signe, className = 'h-4 w-4 shrink-0' }: { signe: SigneOutil; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
    >
      {CHEMINS[signe]}
    </svg>
  );
}

/**
 * Les neuf dessins. `Record` EXHAUSTIF : ajouter un signe sans son dessin ne compile pas, ce qui est
 * exactement la garde qu'on veut ici (une icône manquante ne se voit pas en relisant du code).
 */
const CHEMINS: Record<SigneOutil, React.ReactNode> = {
  // Une étiquette percée d'un œillet : le tag.
  tag: (
    <>
      <path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z" />
      <circle cx="7" cy="7" r="1.3" />
    </>
  ),
  // Un crayon sur une ligne : une information qu'on écrit sur la fiche.
  info: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  // Une bulle : un message qui part chez le client.
  bloc: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  // Deux noeuds relies par une courbe : un parcours qui se deroule.
  scenario: (
    <>
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M6 15V6a3 3 0 0 1 3-3h6" />
    </>
  ),
  // Une fiche de branchement : un systeme tiers.
  connecteur: (
    <>
      <path d="M9 2v6M15 2v6" />
      <path d="M6 8h12v3a6 6 0 0 1-12 0z" />
      <path d="M12 17v5" />
    </>
  ),
  // Une loupe : chercher dans la base de connaissance.
  recherche: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>
  ),
  // Une personne : lire la fiche du contact.
  contact: (
    <>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  // Deux personnes : la main passe a quelqu un de l equipe.
  humain: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.9" />
      <path d="M16 3.1a4 4 0 0 1 0 7.8" />
    </>
  ),
  // Un drapeau : la sortie du bloc, la fin du tour.
  fin: (
    <>
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <path d="M4 22v-7" />
    </>
  ),
};
