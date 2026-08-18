'use client';

import { useState } from 'react';
import type { TemplateButtonInput } from '@/lib/api';
import { TemplateBodyText } from '@/components/WhatsAppPreview';
import { useT } from '@/lib/i18n';
import { PhoneFrame } from '@/components/PhoneFrame';

/**
 * Une carte d'aperçu. Deux sources, même rendu : les images LOCALES du formulaire de création (data URL du
 * fichier choisi) et les images RELUES chez Meta sur un template déjà créé (URL CDN).
 */
export interface CarouselPreviewCard {
  /** Image affichable. Absente -> emplacement gris (on n'invente pas de visuel). */
  imageUrl?: string;
  mediaFormat?: 'IMAGE' | 'VIDEO';
  body?: string;
  /** Boutons PROPRES à la carte. Absents -> les boutons communs passés au composant. */
  buttons?: TemplateButtonInput[];
}

/** Vignette d'une carte. Une URL Meta porte une expiration : si le chargement échoue, on le DIT au lieu de
 *  laisser l'icône d'image cassée du navigateur. */
function CardMedia({ card, index }: { card: CarouselPreviewCard; index: number }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const label = card.mediaFormat === 'VIDEO' ? t('vidéo', 'video') : failed ? t('image indisponible', 'image unavailable') : t('image', 'image');
  const showImage = card.imageUrl && card.mediaFormat !== 'VIDEO' && !failed;
  return (
    <div className="flex aspect-video w-full items-center justify-center bg-ink-100 text-center text-[11px] text-ink-400">
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={card.imageUrl}
          alt={`${t('Carte', 'Card')} ${index + 1}`}
          onError={() => setFailed(true)}
          // Les images viennent du CDN de Meta : on ne lui envoie pas l'URL de la console au passage.
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover"
        />
      ) : (
        label
      )}
    </div>
  );
}

/**
 * Aperçu façon WhatsApp d'un carousel : bulle d'introduction commune puis les cartes défilables
 * (image, texte, boutons). Partagé par la création d'un template et l'aperçu d'un template déjà créé.
 */
export function CarouselPreview({
  body,
  cards,
  buttons,
  examples = [],
  varLabels,
  senderName,
}: {
  body: string;
  cards: CarouselPreviewCard[];
  /** Boutons communs (contrainte Meta à la création). Une carte qui porte les siens les affiche à la place. */
  buttons: TemplateButtonInput[];
  /** Valeurs des variables `{{n}}` du message d'introduction. Même contrat que WhatsAppPreview. */
  examples?: string[];
  /** Libellés de champ par position : affiche un chip `[Prénom]` au lieu de l'exemple (mode création). */
  varLabels?: Array<string | undefined>;
  /** Nom affiché dans l'en-tête. Absent -> libellé générique (le nom vérifié n'est pas connu ici). */
  senderName?: string;
}) {
  const t = useT();
  return (
    <PhoneFrame {...(senderName ? { senderName } : {})} contentClassName="space-y-2 px-3 py-4">
          <div className="max-w-[88%] rounded-lg rounded-tl-none bg-white px-2.5 py-1.5 text-[13px] leading-snug text-ink-800 shadow-sm">
            {body.trim()
              ? <span className="whitespace-pre-wrap break-words"><TemplateBodyText body={body} examples={examples} {...(varLabels ? { varLabels } : {})} /></span>
              : <span className="text-ink-400">{t("Message d'introduction…", 'Introduction message…')}</span>}
          </div>
          {cards.length === 0 ? (
            <p className="text-[12px] text-ink-500">{t('Aucune carte à afficher.', 'No card to display.')}</p>
          ) : (
            <div data-testid="carousel-cards" className="flex gap-2 overflow-x-auto pb-1">
              {cards.map((c, i) => {
                const cardButtons = c.buttons ?? buttons;
                return (
                  <div key={i} className="w-44 shrink-0 overflow-hidden rounded-lg bg-white shadow-sm">
                    {/* Clé sur l'URL : changer d'image REMONTE la vignette, donc un échec précédent ne reste
                        pas collé sur une image qui, elle, est bonne. */}
                    <CardMedia key={c.imageUrl ?? `sans-image-${i}`} card={c} index={i} />
                    {c.body?.trim() && <div className="px-2 py-1.5 text-[12px] leading-snug text-ink-800">{c.body}</div>}
                    {cardButtons.length > 0 && (
                      <div>
                        {cardButtons.map((b, j) => (
                          <div key={j} className="border-t border-ink-100 py-1.5 text-center text-[12px] font-medium text-[#00a5f4]">
                            {b.text?.trim() || (b.type === 'URL' ? t('Lien', 'Link') : t('Réponse', 'Reply'))}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
    </PhoneFrame>
  );
}
