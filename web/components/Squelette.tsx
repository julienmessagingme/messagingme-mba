'use client';

import { useT } from '@/lib/i18n';

/**
 * LA FORME DE CE QUI ARRIVE, AU LIEU DU MOT « CHARGEMENT… ». La console en affichait une soixantaine, en gris,
 * au milieu d'un espace vide qui changeait de hauteur à l'arrivée des données : la page sautait, et le mot ne
 * disait rien de ce qu'on attendait. Le squelette occupe la place du contenu, à peu près à sa forme.
 *
 * - `lignes` : une liste, un tableau (une barre par ligne à venir) ;
 * - `carte` : un bloc de réglages ou un panneau (un titre, puis du texte) ;
 * - `fil` : une conversation (des bulles, alternées).
 *
 * ⚠️ UN SEUL NOM ACCESSIBLE, « Chargement » : les barres elles-mêmes sont muettes. Et `motion-reduce` coupe la
 * pulsation pour qui l'a demandé au système.
 *
 * ⚠️ Les états d'attente DANS un contrôle (un bouton « Envoi… », une option de liste) restent des mots : un
 * squelette dans un bouton ne se lit pas comme une attente.
 */
export type FormeSquelette = 'lignes' | 'carte' | 'fil';

const LARGEURS = ['w-full', 'w-11/12', 'w-4/6', 'w-5/6', 'w-3/5'];

export function Squelette({ forme = 'lignes', lignes = 3, className = '' }: {
  forme?: FormeSquelette;
  /** Le nombre de lignes (ou de bulles) à esquisser. */
  lignes?: number;
  /** La mise en page seulement : marges et rembourrage de l'emplacement. */
  className?: string;
}) {
  const t = useT();
  const barre = 'rounded-controle bg-ink-100';
  return (
    <div
      role="status"
      aria-label={t('Chargement', 'Loading')}
      data-squelette={forme}
      className={`animate-pulse motion-reduce:animate-none ${className}`}
    >
      {forme === 'fil' ? (
        <div className="space-y-3">
          {Array.from({ length: lignes }, (_, i) => (
            <div key={i} className={`h-9 ${i % 2 === 0 ? 'w-3/5' : 'ml-auto w-2/5'} rounded-carte bg-ink-100`} />
          ))}
        </div>
      ) : forme === 'carte' ? (
        <div className="space-y-2.5">
          <div className={`h-4 w-1/3 ${barre}`} />
          {Array.from({ length: lignes }, (_, i) => (
            <div key={i} className={`h-3 ${LARGEURS[(i + 1) % LARGEURS.length]} ${barre}`} />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {Array.from({ length: lignes }, (_, i) => (
            <div key={i} className={`h-4 ${LARGEURS[i % LARGEURS.length]} ${barre}`} />
          ))}
        </div>
      )}
    </div>
  );
}
