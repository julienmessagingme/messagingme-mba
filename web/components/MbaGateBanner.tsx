'use client';

import Link from 'next/link';
import { useT } from '@/lib/i18n';
import { Icone } from '@/components/Icone';

/**
 * Ce qui bloque la configuration, quand quelque chose la bloque. Deux motifs SÉPARÉS, là où la maquette
 * précédente n'en connaissait qu'un : « aucun numéro rattaché » et « Meta n'a pas encore ouvert l'agent » ne se
 * règlent pas au même endroit, et les confondre envoie le client chercher au mauvais endroit.
 */
export function MbaGateBanner({ reason }: { reason: 'no-number' | 'not-eligible' }) {
  const t = useT();

  if (reason === 'no-number') {
    return (
      <div className="flex items-start gap-3 rounded-carte border border-ink-200 bg-white p-4" data-testid="mba-gate-no-number">
        <div className="text-sm leading-relaxed text-ink-900">
          <p className="font-semibold text-ink-900">{t('Aucun numéro WhatsApp rattaché', 'No WhatsApp number connected')}</p>
          <p className="mt-1">
            {t(
              'L’agent se configure sur un numéro. Connectez d’abord votre numéro WhatsApp, puis revenez ici.',
              'The agent is configured on a number. Connect your WhatsApp number first, then come back here.',
            )}
          </p>
          <Link href="/accueil" className="mt-2 inline-block font-medium text-brand-600 hover:text-brand-700">
            {t('Aller au compte', 'Go to account')} →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-carte border border-alerte-300 bg-alerte-50 p-4" data-testid="mba-gate-not-eligible">
      <Icone nom="attention" className="mt-0.5 text-alerte-700" />
      <div className="text-sm leading-relaxed text-ink-900">
        <p className="font-semibold text-ink-900">{t('L’agent n’est pas encore ouvert sur votre numéro', 'The agent isn’t open on your number yet')}</p>
        <p className="mt-1">
          {t(
            'Meta ouvre Business AI progressivement, par pays et par secteur, et les conditions se signent dans WhatsApp Manager. Dès que votre numéro est ouvert, tous les réglages deviennent actifs ici.',
            'Meta opens Business AI gradually, by country and sector, and the terms are signed in WhatsApp Manager. As soon as your number is opened, every setting becomes active here.',
          )}
        </p>
        <Link href="/mba" className="mt-2 inline-block font-medium text-brand-600 hover:text-brand-700">
          {t('Revoir le guide MBA', 'Back to the MBA guide')} →
        </Link>
      </div>
    </div>
  );
}
