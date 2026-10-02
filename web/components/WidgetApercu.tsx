'use client';

import { useT } from '@/lib/i18n';
import { Icone } from '@/components/Icone';
import type { PositionWidget } from '@/lib/widgets';

/**
 * L'APERÇU DE LA BULLE, sur une page de site esquissée : ce que le visiteur verra dans le coin de l'écran.
 *
 * Il suit la MISE EN PAGE du script servi (`src/widgets/script.ts`) : la pastille (avatar et libellé) à côté de la
 * bulle, du côté opposé au bord ; « Propulsé par Engage Me » sous la bulle, ou au-dessus quand elle est en haut.
 * Ce n'est pas le script lui-même : il s'exécute dans un Shadow DOM sur la page du client, et le monter ici
 * poserait une vraie bulle par-dessus la console.
 *
 * La couleur se pose par `style.backgroundColor`, comme dans le script, et jamais par une classe : une classe
 * calculée n'est pas vue par Tailwind, donc absente du CSS produit (`lib/ui.ts`, `DOT_HEX`).
 */
export function WidgetApercu({ couleur, position, libelle, avatarUrl, badge, grisee = false }: {
  couleur: string;
  position: PositionWidget;
  libelle: string | null;
  avatarUrl: string | null;
  badge: boolean;
  /** La bulle d'un espace sans numéro relié : grise, sans pastille, comme le script la sert. */
  grisee?: boolean;
}) {
  const t = useT();
  const haut = position.startsWith('haut');
  const gauche = position.endsWith('gauche');
  const coin = `${haut ? 'top-4' : 'bottom-4'} ${gauche ? 'left-4' : 'right-4'}`;
  const pastille = !grisee && (libelle !== null || avatarUrl !== null);

  return (
    <div
      className="relative h-72 overflow-hidden rounded-carte border border-ink-200 bg-ink-50"
      aria-label={t('Aperçu de la bulle sur un site', 'Preview of the bubble on a website')}
      data-testid="widget-apercu"
    >
      {/* Une page de site, esquissée : de quoi situer la bulle, rien à lire. */}
      <div className="space-y-2 p-5" aria-hidden="true">
        <div className="h-3 w-1/3 rounded-controle bg-ink-200" />
        <div className="h-2 w-2/3 rounded-controle bg-ink-100" />
        <div className="h-2 w-1/2 rounded-controle bg-ink-100" />
        <div className="h-2 w-3/5 rounded-controle bg-ink-100" />
      </div>
      <div className={`absolute ${coin} flex ${haut ? 'flex-col-reverse' : 'flex-col'} ${gauche ? 'items-start' : 'items-end'} gap-2`}>
        <div className={`flex items-center gap-2.5 ${gauche ? 'flex-row-reverse' : ''}`}>
          {pastille && (
            <span className="flex max-w-[15rem] items-center gap-2 rounded-full bg-white px-3 py-1.5 text-sm text-ink-900 shadow-mm-sm" data-testid="widget-apercu-pastille">
              {avatarUrl !== null && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatarUrl} alt="" className="h-7 w-7 rounded-full object-cover" />
              )}
              {libelle !== null && <span className="truncate">{libelle}</span>}
            </span>
          )}
          <span
            className={`flex h-14 w-14 items-center justify-center rounded-full shadow-mm-sm${grisee ? ' bg-ink-300 opacity-60' : ''}`}
            style={grisee ? undefined : { backgroundColor: couleur }}
            data-testid="widget-apercu-bulle"
          >
            <Icone nom="message" taille="grande" className="text-white" />
          </span>
        </div>
        {badge && !grisee && <p className="text-xs text-ink-500">Propulsé par Engage Me</p>}
      </div>
    </div>
  );
}
