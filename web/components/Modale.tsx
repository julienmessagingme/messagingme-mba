'use client';

import { useEffect, useId, useRef } from 'react';
import Link from 'next/link';
import { useT } from '@/lib/i18n';
import { Icone } from '@/components/Icone';

/**
 * LA FENÊTRE MODALE DE LA CONSOLE, ET LA SEULE : voile, panneau centré, titre, croix de fermeture, pied
 * d'actions facultatif.
 *
 * 🔴 VINGT COPIES VIVAIENT À CÔTÉ D'ELLE jusqu'au 2026-09-25 (dix-sept fichiers qui posaient leur propre
 * `fixed inset-0` et leur voile), chacune avec sa largeur, son rayon, sa croix, et presque aucune avec Échap
 * ou un rôle de dialogue. Elles passent toutes ici ; `tests/web-formes.test.ts` refuse qu'une nouvelle copie
 * pose son voile ailleurs.
 *
 * Ce que la coquille garantit, partout :
 * - le panneau s'annonce comme un dialogue (`role="dialog"`, `aria-modal`) ;
 * - Échap ferme, mais SEULEMENT la fenêtre du dessus : une confirmation ouverte depuis une modale ne ferme
 *   pas les deux d'un coup ;
 * - un clic sur le voile ferme, mais pas un glissé qui a COMMENCÉ dans le panneau (sélectionner un texte
 *   jusqu'au bord et lâcher sur le voile fermait la fenêtre, et perdait la saisie) ;
 * - le focus entre dans le panneau à l'ouverture, et revient là où il était à la fermeture.
 */

/** La pile des fenêtres ouvertes : seule la dernière répond à Échap. */
const pile: string[] = [];

export type TailleModale = 'petite' | 'moyenne' | 'large' | 'plein';
const LARGEURS: Record<TailleModale, string> = {
  petite: 'max-w-md',
  moyenne: 'max-w-xl',
  large: 'max-w-4xl',
  // Un éditeur entier (le builder de scénario ouvert depuis une campagne) : environ trois quarts de l'écran,
  // borné pour respirer en 13 pouces.
  plein: 'h-[min(85vh,48rem)] w-[min(92vw,80rem)] max-w-none',
};

export function Modale({
  titre, titreHref, sousTitre, taille = 'moyenne', actions, pied, testId, testIdFermer = 'modale-fermer', fermeture = 'partout', onClose, children,
}: {
  titre: string;
  /**
   * Quand il est fourni, le titre devient un LIEN vers cette adresse (demande de Julien, 2026-09-23 : depuis
   * la fiche de coût d'une campagne, recliquer sur son nom doit mener à ses résultats).
   *
   * ⚠️ UN VRAI LIEN, PAS UN `onClick` : il s'ouvre dans un nouvel onglet au clic du milieu, se copie et se
   * partage, exactement comme le bouton « Voir les résultats » de l'onglet Campagnes, qui va au même endroit.
   * Absent, le titre reste le texte qu'il a toujours été : les autres fenêtres du produit ne bougent pas.
   */
  titreHref?: string;
  sousTitre?: React.ReactNode;
  /** `petite` pour une question ou un champ, `moyenne` pour une fiche, `large` pour une liste à colonnes. */
  taille?: TailleModale;
  /** Boutons posés à droite du titre (export, par exemple). Ils portent `sans-impression` d'eux-mêmes. */
  actions?: React.ReactNode;
  /** Les boutons de décision (annuler, valider), posés dans une barre en bas, alignés à droite. */
  pied?: React.ReactNode;
  /** Le `data-testid` du dialogue, pour les fenêtres qui en portaient un avant de venir ici. */
  testId?: string;
  /** Celui de la croix, pour la fenêtre dont la croix en portait un propre (`fenetre-scenario-fermer`). */
  testIdFermer?: string;
  /**
   * `boutons` : seules la croix et les boutons du contenu ferment, ni Échap ni un clic sur le voile. Pour une
   * fenêtre dont la fermeture PERD quelque chose qu'on ne retrouve pas (une clé d'API affichée une seule fois,
   * un scénario en cours d'édition) : un clic à côté ne doit pas coûter ce travail.
   */
  fermeture?: 'partout' | 'boutons';
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t = useT();
  const id = useId();
  const panneau = useRef<HTMLDivElement>(null);
  const departDuClic = useRef<EventTarget | null>(null);
  // `onClose` change à chaque rendu chez la plupart des appelants : on lit la dernière sans réabonner Échap.
  const fermer = useRef(onClose);
  fermer.current = onClose;
  const fermetureRef = useRef(fermeture);
  fermetureRef.current = fermeture;
  /**
   * L'élément qui avait le focus AVANT l'ouverture, lu AU PREMIER RENDU. L'effet ci-dessous passe APRÈS
   * l'`autoFocus` d'un enfant (le bouton « oui » d'une confirmation) : lu là, il désignait cet enfant, qui
   * disparaît avec la fenêtre, et le focus tombait sur `body` à la fermeture. `undefined` = pas encore lu
   * (rendu serveur, où `document` n'existe pas) ; l'effet le lit alors, faute de mieux.
   */
  const avant = useRef<HTMLElement | null | undefined>(undefined);
  if (avant.current === undefined && typeof document !== 'undefined') {
    avant.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  useEffect(() => {
    pile.push(id);
    if (avant.current === undefined) avant.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const retour = avant.current;
    // Un champ `autoFocus` du contenu a déjà pris le focus : on ne le lui vole pas.
    if (panneau.current && !panneau.current.contains(document.activeElement)) panneau.current.focus();
    const auClavier = (e: KeyboardEvent): void => {
      // Un Échap déjà TRAITÉ plus bas (une édition en ligne qui s'annule, `preventDefault`) ne ferme rien.
      if (e.defaultPrevented) return;
      if (e.key === 'Escape' && pile[pile.length - 1] === id && fermetureRef.current === 'partout') { e.stopPropagation(); fermer.current(); }
    };
    window.addEventListener('keydown', auClavier);
    return () => {
      window.removeEventListener('keydown', auClavier);
      const i = pile.lastIndexOf(id);
      if (i >= 0) pile.splice(i, 1);
      if (retour && document.contains(retour)) retour.focus();
    };
  }, [id]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-900/30 p-4"
      onMouseDown={(e) => { departDuClic.current = e.target; }}
      onClick={(e) => { if (fermeture === 'partout' && e.target === e.currentTarget && departDuClic.current === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={titre}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <div
        ref={panneau}
        tabIndex={-1}
        // Un clic DANS la fenêtre ne remonte pas aux parents : une fenêtre ouverte depuis une ligne cliquable
        // (une fiche de contact depuis la liste) rejouerait sinon le geste de la ligne à chaque clic.
        onClick={(e) => e.stopPropagation()}
        className={`flex max-h-[85vh] ${taille === 'plein' ? '' : 'w-full '}flex-col overflow-hidden rounded-carte bg-white shadow-mm-lg outline-none ${LARGEURS[taille]}`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-ink-100 px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-ink-900">
              {titreHref
                ? <Link href={titreHref} data-testid="modale-titre-lien" className="hover:text-brand-600 hover:underline">{titre}</Link>
                : titre}
            </h3>
            {sousTitre && <div className="mt-0.5 text-xs text-ink-500">{sousTitre}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            <button
              type="button"
              onClick={onClose}
              data-testid={testIdFermer}
              aria-label={t('Fermer', 'Close')}
              className="sans-impression rounded-controle p-1 text-ink-400 transition-colors duration-150 hover:bg-ink-50 hover:text-ink-900"
            ><Icone nom="fermer" /></button>
          </div>
        </div>
        <div className={`min-h-0 flex-1 ${taille === 'plein' ? 'overflow-auto p-3' : 'overflow-y-auto px-5 py-4'}`}>{children}</div>
        {pied && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ink-100 px-5 py-3">{pied}</div>}
      </div>
    </div>
  );
}
