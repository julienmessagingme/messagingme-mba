'use client';

import { useT } from '@/lib/i18n';

/**
 * Panneau flottant qui se ferme au clic extérieur. Extrait de `RcsBodyField` le 2026-08-25 : trois surfaces
 * de saisie doivent désormais ouvrir le même sélecteur de variables (sujet, corps texte, corps HTML), et le
 * recopier trois fois est exactement la faute que ce lot corrige.
 *
 * Le voile est un `<button>` plein écran et non un `<div>` : il capte le clic extérieur tout en restant
 * atteignable au clavier.
 */
/**
 * LE VOILE D'UN MENU : invisible, plein écran, il capte le clic extérieur qui ferme le menu. Un `<button>` et
 * non un `<div>` : il reste atteignable au clavier. Cinq menus posaient chacun le leur (`fixed inset-0`), avec
 * ou sans nom accessible ; ils passent tous ici. `z` place le voile sous le menu qu'il ferme.
 */
export function VoileMenu({ onClose, z = 'z-40' }: { onClose: () => void; z?: 'z-10' | 'z-40' }) {
  const t = useT();
  return <button type="button" aria-label={t('Fermer', 'Close')} className={`fixed inset-0 ${z} cursor-default`} onClick={onClose} />;
}

export function Flottant({
  children, onClose, large, ancrage = 'bas', alignement = 'droite', hauteur = 'normale',
}: {
  children: React.ReactNode;
  onClose: () => void;
  large?: boolean;
  /** `bas` : le panneau monte au-dessus du bouton (corps de message, le bouton est en bas à droite du champ).
   *  `haut` : il descend sous le bouton (sujet, où il n'y a rien au-dessus). */
  ancrage?: 'bas' | 'haut';
  /**
   * De quel bord le panneau part. 🔴 `droite` était en dur, et ça tenait tant que TOUS les déclencheurs
   * étaient en bas à droite de leur champ. Le bouton de smileys de la barre du composeur de chaîne est à
   * GAUCHE : les 256 px du panneau partaient alors hors de la carte, et hors de l'écran en mono-colonne.
   */
  alignement?: 'droite' | 'gauche';
  /**
   * `haute` pour un contenu qui doit tenir en entier. 🔴 `max-h-56` (224 px) coupait la grille de smileys,
   * qui fait dix rangées : combinée à la fermeture après chaque choix, poser trois smileys coûtait trois
   * réouvertures ET trois défilements, alors que l'ancien sélecteur les montrait tous.
   */
  hauteur?: 'normale' | 'haute';
}) {
  return (
    <>
      <VoileMenu onClose={onClose} />
      <div
        className={`absolute z-50 overflow-y-auto rounded-carte border border-ink-200 bg-white p-1 shadow-mm-md ${
          alignement === 'droite' ? 'right-0' : 'left-0'
        } ${hauteur === 'haute' ? 'max-h-80' : 'max-h-56'} ${
          ancrage === 'bas' ? 'bottom-11' : 'top-8'
        } ${large ? 'w-64 p-2' : 'w-56'}`}
      >
        {children}
      </div>
    </>
  );
}
