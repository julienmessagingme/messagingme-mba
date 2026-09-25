import type { ComponentPropsWithRef } from 'react';

/**
 * LE BOUTON DE LA CONSOLE. Le bouton principal existait en 66 variantes (fond 500 ou 600, quatre graisses,
 * des hauteurs de `py-0.5` à `py-2.5`, un « désactivé » à 30, 40, 50 ou 60 %) : deux pages voisines ne
 * montraient pas le même bouton pour le même geste.
 *
 * - `principal` : LE geste de l'écran (enregistrer, créer, lancer). Fond `brand-600` et non 500 : le texte
 *   blanc n'atteint 4,5:1 que sur la 600.
 * - `secondaire` : un geste possible à côté du principal (annuler, importer, filtrer).
 * - `discret` : une action de ligne ou d'appoint, sans cadre.
 *
 * ⚠️ AUCUN `type` PAR DÉFAUT, et c'est délibéré : un `<button>` sans `type` vaut `submit` dans un formulaire.
 * Le poser ici changerait ce que fait chaque bouton converti. `type`, `disabled`, `aria-*` et `data-testid`
 * passent tels quels.
 *
 * `enCours` : le geste est parti et on attend la réponse. Le bouton garde sa couleur pleine et prend le
 * curseur d'attente, au lieu de pâlir comme un bouton simplement indisponible. Il ne désactive RIEN : c'est
 * toujours `disabled` qui décide.
 */
export type VarianteBouton = 'principal' | 'secondaire' | 'discret';
export type TailleBouton = 'normale' | 'petite';

// `bouton` n'est pas une classe Tailwind : c'est la marque que `globals.css` lit pour ne pas ajouter son retour
// de clic générique (une opacité) à celui du composant (sa couleur de fond qui fonce).
const BASE =
  'bouton inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors duration-150 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const VARIANTES: Record<VarianteBouton, string> = {
  principal: 'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 disabled:hover:bg-brand-600',
  secondaire: 'border border-ink-200 bg-white text-ink-900 hover:bg-ink-50 active:bg-ink-100 disabled:hover:bg-white',
  discret: 'text-brand-600 hover:bg-brand-50 active:bg-brand-100 disabled:hover:bg-transparent',
};

const TAILLES: Record<TailleBouton, string> = {
  normale: 'px-4 py-2 text-sm',
  petite: 'px-3 py-1.5 text-xs',
};

const EN_COURS = 'cursor-progress disabled:cursor-progress disabled:opacity-100';

/** Les classes du bouton, pour un `<Link>` ou un `<label>` qui doit en avoir l'air sans en être un. */
export function classesBouton(variante: VarianteBouton, taille: TailleBouton = 'normale', enPlus = ''): string {
  return `${BASE} ${VARIANTES[variante]} ${TAILLES[taille]}${enPlus ? ` ${enPlus}` : ''}`;
}

export function Bouton({
  variante = 'principal',
  taille = 'normale',
  enCours = false,
  className = '',
  ...props
}: ComponentPropsWithRef<'button'> & { variante?: VarianteBouton; taille?: TailleBouton; enCours?: boolean }) {
  return <button {...props} className={classesBouton(variante, taille, `${enCours ? EN_COURS : ''} ${className}`.trim())} />;
}
