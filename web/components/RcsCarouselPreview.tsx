'use client';

import { ICONE_KIND } from '@/lib/rcs-boutons';
import type { BrouillonCarrouselRcs } from '@/lib/rcs-carrousel';
import { useT } from '@/lib/i18n';

/**
 * LE CARROUSEL RCS TEL QUE LE CONTACT LE VERRA : des cartes qui défilent à l'horizontale, chacune avec son
 * visuel, son titre, son texte, et ses boutons EN LISTE pleine largeur. Ce sont des boutons de CARTE : ils
 * restent affichés, contrairement aux pastilles d'un message texte (cf. `RcsPreview`).
 *
 * Le dessin d'une carte est celui de la carte simple de `RcsPreview`, répété : deux dessins pour la même carte
 * divergeraient au premier ajustement. Partagé par la bibliothèque, l'assistant de campagne et l'Inbox.
 *
 * ⚠️ UNE CARTE SANS VISUEL N'A PAS D'EMPLACEMENT GRIS : en RCS le visuel est facultatif (une carte peut n'être
 * qu'un titre), et l'aperçu montrerait un trou que le téléphone ne montre pas. Seule une carte ENTIÈREMENT
 * vide se signale, pour qu'on voie qu'elle existe.
 */
export function RcsCarouselPreview({ brouillon, sansFond = false }: { brouillon: BrouillonCarrouselRcs; sansFond?: boolean }) {
  const t = useT();
  return (
    <div className={sansFond ? '' : 'rounded-xl bg-ink-50 p-3'}>
      <div data-testid="rcs-carrousel-apercu" className="flex gap-2 overflow-x-auto pb-1">
        {brouillon.cartes.map((c, i) => {
          const image = c.imageUrl.trim();
          const titre = c.title.trim();
          const texte = c.text.trim();
          const boutons = c.suggestions.filter((s) => s.text.trim() !== '');
          const vide = image === '' && titre === '' && texte === '' && boutons.length === 0;
          return (
            <div key={i} data-testid={`rcs-carrousel-apercu-carte-${i}`} className="w-48 shrink-0 overflow-hidden rounded-2xl bg-mint-100">
              {image !== '' && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={image} alt={`${t('Carte', 'Card')} ${i + 1}`} referrerPolicy="no-referrer" className="aspect-video w-full bg-ink-100 object-cover" />
              )}
              {vide && <div className="px-3 py-2 text-sm italic text-ink-400">{t(`Carte ${i + 1}…`, `Card ${i + 1}…`)}</div>}
              {(titre !== '' || texte !== '') && (
                <div className="px-3 py-2">
                  {titre !== '' && <div className="text-sm font-semibold text-ink-900">{titre}</div>}
                  {texte !== '' && <div className="whitespace-pre-wrap text-sm text-ink-800">{texte}</div>}
                </div>
              )}
              {boutons.map((s, j) => (
                <div key={j} className="border-t border-mint-200 bg-white px-3 py-2 text-center text-sm font-medium text-ink-800">
                  {ICONE_KIND[s.kind]}{s.text}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
