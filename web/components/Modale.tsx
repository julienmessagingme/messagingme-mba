'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useT } from '@/lib/i18n';

/**
 * La coquille d'une fenêtre modale : voile, panneau centré, titre, croix de fermeture.
 *
 * Écrite pour les deux fenêtres de l'analytics qualitatif, mais posée en composant plutôt qu'en copie : le
 * dépôt porte déjà six copies de cette même structure (`app/tags`, `app/flows`, `app/inbox`, `ContactDetail`,
 * `MbaFaqPanel`, `MbaSkillsPanel`), et l'audit du 2026-08-18 a passé une journée à retirer ce genre de
 * copies. En ajouter deux de plus aurait été le geste que ce dépôt s'est explicitement interdit. Les six
 * existantes peuvent venir ici quand on les touchera, ce n'était pas le sujet de ce lot.
 *
 * Ce que la coquille apporte en plus des copies : la touche Échap ferme, et le panneau s'annonce comme un
 * dialogue aux lecteurs d'écran. Les copies n'ont ni l'un ni l'autre.
 */
export function Modale({
  titre, titreHref, sousTitre, taille = 'moyenne', actions, onClose, children,
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
  /** `moyenne` pour une fiche, `large` pour une liste qui a besoin de colonnes. */
  taille?: 'moyenne' | 'large';
  /** Boutons posés à droite du titre (export, par exemple). Ils portent `sans-impression` d'eux-mêmes. */
  actions?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const t = useT();

  // Échap ferme. Sans ça, la seule sortie est la croix ou le voile, et une modale qui couvre l'écran sans
  // sortie au clavier est une impasse pour qui ne se sert pas de la souris.
  useEffect(() => {
    const auClavier = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', auClavier);
    return () => window.removeEventListener('keydown', auClavier);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={titre}
    >
      <div
        className={`flex max-h-[85vh] w-full flex-col overflow-hidden rounded-2xl bg-white shadow-mm-lg ${taille === 'large' ? 'max-w-4xl' : 'max-w-xl'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-ink-100 px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-ink-900">
              {titreHref
                ? <Link href={titreHref} data-testid="modale-titre-lien" className="hover:text-brand-600 hover:underline">{titre}</Link>
                : titre}
            </h3>
            {sousTitre && <div className="mt-0.5 text-xs text-ink-400">{sousTitre}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {actions}
            <button
              type="button"
              onClick={onClose}
              data-testid="modale-fermer"
              aria-label={t('Fermer', 'Close')}
              className="sans-impression text-2xl leading-none text-ink-400 transition-colors duration-150 hover:text-ink-900"
            >
              ×
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
