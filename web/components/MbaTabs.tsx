'use client';

/**
 * Barre d'onglets de la configuration MBA. Purement présentationnelle : elle ne sait pas ce qu'il y a derrière.
 *
 * Le dépôt n'avait qu'un jeu d'onglets, recopié inline dans la fiche contact pour DEUX onglets. Ici il en faut
 * huit : recopier ce marquage huit fois, c'est huit endroits à réaligner au premier ajustement de style.
 */
export interface MbaTab {
  key: string;
  label: string;
}

export function MbaTabs({ tabs, active, onSelect }: {
  tabs: MbaTab[];
  active: string;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-ink-200" role="tablist">
      {tabs.map((tab) => {
        const courant = tab.key === active;
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={courant}
            data-testid={`mba-tab-${tab.key}`}
            onClick={() => onSelect(tab.key)}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition ${
              courant ? 'border-brand-500 font-medium text-brand-700' : 'border-transparent text-ink-500 hover:text-ink-800'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
