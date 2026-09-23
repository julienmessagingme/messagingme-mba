'use client';

/**
 * Barre d'onglets de la configuration MBA. Purement présentationnelle : elle ne sait pas ce qu'il y a derrière.
 *
 * Le dépôt n'avait qu'un jeu d'onglets, recopié inline dans la fiche contact pour DEUX onglets. Ici, ses deux
 * consommateurs (l'écran de réglage de l'agent de Meta et la fiche d'un agent IA) en déclarent chacun une
 * longue liste : recopier ce marquage pour chaque entrée, c'est autant d'endroits à réaligner au premier
 * ajustement de style. ⚠️ Le compte exact n'est pas écrit ici, il vit dans les deux `ONGLETS` des pages : il
 * a déjà dérivé une fois (« huit », alors qu'il y en avait onze et neuf).
 */
export interface MbaTab {
  key: string;
  label: string;
}

/**
 * L'orientation du menu. 🔴 ELLE NE CHANGE QUE DES CLASSES, jamais le marquage : une seule liste est
 * rendue dans les deux cas. Rendre une colonne ET une barre ferait exister chaque `data-testid` en double,
 * ce que `tests/web-mbatabs-parite.test.ts` refuse et que cinq suites e2e paieraient.
 *
 * ⚠️ Le repli sous `lg` est porté par les classes elles-memes, pas par un second bloc : en colonne, le
 * composant est `flex-row` par defaut et `lg:flex-col`, donc un telephone retrouve exactement la barre
 * horizontale d'aujourd'hui, avec le meme defilement.
 */
export type OrientationOnglets = 'horizontale' | 'verticale';

export function MbaTabs({ tabs, active, onSelect, orientation = 'horizontale' }: {
  tabs: MbaTab[];
  active: string;
  onSelect: (key: string) => void;
  orientation?: OrientationOnglets;
}) {
  const vertical = orientation === 'verticale';
  /**
   * ⚠️ `-mb-px` ET `border-b` SONT UN COUPLE. En horizontal, le `-mb-px` du bouton fait chevaucher sa
   * bordure basse active sur le trait du conteneur. En colonne, il n'y a plus de trait bas a chevaucher :
   * garder le couple laisserait un decalage d'un pixel sur chaque entree.
   */
  const conteneur = vertical
    ? 'flex gap-1 overflow-x-auto lg:flex-col lg:overflow-x-visible'
    : 'flex gap-1 overflow-x-auto border-b border-ink-200';
  const base = vertical
    ? 'shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition lg:w-full'
    : '-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition';
  const actif = vertical
    ? 'bg-brand-50 font-medium text-brand-700'
    : 'border-brand-500 font-medium text-brand-700';
  const inactif = vertical
    ? 'text-ink-600 hover:bg-ink-100 hover:text-ink-900'
    : 'border-transparent text-ink-500 hover:text-ink-800';

  return (
    <div
      className={conteneur}
      role="tablist"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
    >
      {tabs.map((tab) => {
        const courant = tab.key === active;
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={courant}
            data-testid={`mba-tab-${tab.key}`}
            onClick={() => onSelect(tab.key)}
            className={`${base} ${courant ? actif : inactif}`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
