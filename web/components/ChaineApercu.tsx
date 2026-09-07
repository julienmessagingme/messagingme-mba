'use client';

import { useT } from '@/lib/i18n';
import { morceauxApercu, imageAffichable } from '@/lib/chaine-apercu';

/**
 * Le post tel que l'abonné le verra dans WhatsApp, avec son bouton « Discuter ».
 *
 * 🔴 C'est la DERNIÈRE chose que le client voit avant qu'un message parte à toute une audience, sans retour
 * arrière possible. Tout ce qui est dessiné ici doit correspondre à ce qui part vraiment : l'ordre des
 * morceaux vient de `morceauxApercu`, qui recopie la composition du serveur, et le libellé du bouton n'est
 * jamais dérivé du texte (WhatsApp le dessine lui-même, il n'est pas réglable).
 *
 * ⚠️ Ce composant ne DÉCIDE rien : toutes les décisions sont dans `lib/chaine-apercu.ts`, qui est testé.
 * Ici il n'y a que du balisage.
 */

export interface ChaineApercuProps {
  texte: string;
  imageUrl: string;
  /** L'adresse composée PAR LE SERVEUR. `null` = pas de bouton, et c'est un état normal. */
  waMeUrl: string | null;
  nomChaine: string | null;
}

export function ChaineApercu({ texte, imageUrl, waMeUrl, nomChaine }: ChaineApercuProps) {
  const t = useT();
  const morceaux = morceauxApercu(texte, waMeUrl);
  const image = imageAffichable(imageUrl);
  const vide = morceaux.length === 0 && image === null;

  return (
    <div className="rounded-2xl border border-ink-200 bg-ink-50 p-4" data-testid="chaine-apercu">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-400">
        {t('Aperçu', 'Preview')}
      </p>

      {/* La bulle, aux couleurs de WhatsApp plutôt qu'à celles de la console : c'est une simulation de ce que
          l'abonné voit, pas un élément de notre interface. */}
      <div className="mx-auto max-w-sm rounded-2xl bg-[#E7FFDB] p-3 shadow-sm">
        <p className="mb-2 text-xs font-semibold text-ink-500" data-testid="chaine-apercu-nom">
          {nomChaine ?? t('Ta chaîne', 'Your channel')}
        </p>

        {image !== null ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt=""
            className="mb-2 max-h-48 w-full rounded-lg object-cover"
            data-testid="chaine-apercu-image"
          />
        ) : null}

        {vide ? (
          <p className="text-sm italic text-ink-400" data-testid="chaine-apercu-vide">
            {t('Écris ton message pour voir l’aperçu.', 'Write your message to see the preview.')}
          </p>
        ) : null}

        {morceaux.map((m, i) => {
          if (m.kind === 'texte') {
            return (
              <p key={i} className="whitespace-pre-wrap break-words text-sm text-ink-800" data-testid="chaine-apercu-texte">
                {m.contenu}
              </p>
            );
          }
          if (m.kind === 'lien') {
            return (
              <p key={i} className="mt-2 break-all text-xs text-sky underline" data-testid="chaine-apercu-lien">
                {m.contenu}
              </p>
            );
          }
          return (
            <div
              key={i}
              className="mt-2 border-t border-ink-200/60 pt-2 text-center text-sm font-medium text-sky"
              data-testid="chaine-apercu-bouton"
            >
              {m.contenu}
            </div>
          );
        })}
      </div>

      {waMeUrl === null ? (
        <p className="mt-3 text-center text-xs text-ink-400" data-testid="chaine-apercu-sans-bouton">
          {t(
            'Sans scénario rattaché, la publication part sans bouton.',
            'Without an attached scenario, the post goes out without a button.',
          )}
        </p>
      ) : (
        <p className="mt-3 text-center text-xs text-ink-400">
          {t(
            'WhatsApp dessine ce bouton lui-même à partir du lien : son libellé n’est pas modifiable.',
            'WhatsApp draws this button from the link: its label cannot be changed.',
          )}
        </p>
      )}
    </div>
  );
}
