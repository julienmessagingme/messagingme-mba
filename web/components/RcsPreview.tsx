'use client';

import { ICONE_KIND } from '@/lib/rcs-boutons';
import { MAX_BOUTONS_CARTE, type BrouillonRcs } from '@/lib/rcs';
import { useT } from '@/lib/i18n';

/**
 * Le message RCS tel que le contact le verra.
 *
 * 🔴 Il dessine DEUX formes différentes, et c'est tout son intérêt. Les boutons d'une carte s'affichent en
 * liste pleine largeur et y restent ; ceux d'un message texte s'affichent en petites pastilles sous la bulle
 * et disparaissent quand la conversation avance (documentation RBM, lue le 2026-08-24). Montrer des pastilles
 * pour un message qui partira en liste ferait croire à un choix qu'on ne fait pas : l'aperçu doit trancher au
 * même endroit que `versMessageRcs`, sinon il ment.
 *
 * Composant partagé par la bibliothèque et par l'inbox : deux aperçus divergeraient au premier ajustement.
 *
 * `sansFond` : posé dans un `RcsPhoneFrame`, qui porte déjà le fond de conversation.
 */
export function RcsPreview({ brouillon, vide, sansFond = false }: { brouillon: BrouillonRcs; vide?: string; sansFond?: boolean }) {
  const t = useT();
  const avecImage = brouillon.imageUrl.trim() !== '';
  const remplis = brouillon.suggestions.filter((s) => s.text.trim() !== '');
  const dansLaCarte = avecImage ? remplis.slice(0, MAX_BOUTONS_CARTE) : [];
  const enPastilles = avecImage ? remplis.slice(MAX_BOUTONS_CARTE) : remplis;

  return (
    <div className={sansFond ? '' : 'rounded-xl bg-ink-50 p-3'}>
      <div className="max-w-[85%] overflow-hidden rounded-2xl bg-mint-100">
        {avecImage && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={brouillon.imageUrl.trim()}
            alt={t('Aperçu de l’image', 'Image preview')}
            referrerPolicy="no-referrer"
            data-testid="rcs-preview-image"
            className="aspect-video w-full bg-ink-100 object-cover"
          />
        )}
        <div data-testid="rcs-preview-text" className="whitespace-pre-wrap px-3 py-2 text-sm text-ink-800">
          {brouillon.text.trim() || <span className="italic text-ink-400">{vide ?? t('Votre message…', 'Your message…')}</span>}
        </div>
        {dansLaCarte.length > 0 && (
          <div data-testid="rcs-preview-card-buttons">
            {dansLaCarte.map((s, i) => (
              <div key={i} className="border-t border-mint-200 bg-white px-3 py-2 text-center text-sm font-medium text-ink-800">
                {ICONE_KIND[s.kind]}{s.text}
              </div>
            ))}
          </div>
        )}
      </div>
      <div data-testid="rcs-preview-buttons" className="mt-2 flex flex-wrap gap-1.5">
        {enPastilles.map((s, i) => (
          <span key={i} className="rounded-full border border-mint-500 bg-white px-3 py-1 text-xs text-mint-700">
            {ICONE_KIND[s.kind]}{s.text}
          </span>
        ))}
      </div>
    </div>
  );
}
