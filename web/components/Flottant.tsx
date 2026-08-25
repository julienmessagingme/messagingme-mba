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
export function Flottant({
  children, onClose, large, ancrage = 'bas',
}: {
  children: React.ReactNode;
  onClose: () => void;
  large?: boolean;
  /** `bas` : le panneau monte au-dessus du bouton (corps de message, le bouton est en bas à droite du champ).
   *  `haut` : il descend sous le bouton (sujet, où il n'y a rien au-dessus). */
  ancrage?: 'bas' | 'haut';
}) {
  const t = useT();
  return (
    <>
      <button type="button" aria-label={t('Fermer', 'Close')} className="fixed inset-0 z-40 cursor-default" onClick={onClose} />
      <div
        className={`absolute right-0 z-50 max-h-56 overflow-y-auto rounded-xl border border-ink-200 bg-white p-1 shadow-lg ${
          ancrage === 'bas' ? 'bottom-11' : 'top-8'
        } ${large ? 'w-64 p-2' : 'w-56'}`}
      >
        {children}
      </div>
    </>
  );
}
