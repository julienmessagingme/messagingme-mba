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
        {/*
          🔴 CE BANDEAU DISAIT « Meta ouvre Business AI progressivement, par pays et par secteur », ce que Meta ne
          documente pas : sa page de référence donne une liste d'EXCLUSION (relue le 2026-09-24, cf. l'ancien guide).
          Le guide qui le disait juste a été retiré le 2026-09-29 : ce bandeau est désormais le seul endroit qui
          explique l'éligibilité, donc il reprend la phrase vraie.
        */}
        <p className="mt-1">
          {t(
            'Meta accepte tous les secteurs sauf la finance, le secteur public, la santé, l’alcool, les jeux d’argent, les médicaments sans ordonnance et les services matrimoniaux, dans les pays autorisés. Les conditions Meta Business AI se signent dans WhatsApp Manager. Dès que votre numéro est ouvert, tous les réglages deviennent actifs ici.',
            'Meta supports all sectors except finance, government, health, alcohol, gambling, over-the-counter drugs and matrimony services, in authorized countries. The Meta Business AI terms are signed in WhatsApp Manager. As soon as your number is opened, every setting becomes active here.',
          )}
        </p>
        {/* Un vrai rechargement (`<a>`, pas `Link`) : la page relit l'état du numéro chez Meta, ce qu'une navigation
            vers la même adresse ne ferait pas. C'est le geste utile après avoir signé les conditions. */}
        <a href="/mba/parametres" className="mt-2 inline-block font-medium text-brand-600 hover:text-brand-700" data-testid="mba-gate-reverifier">
          {t('Vérifier à nouveau', 'Check again')} →
        </a>
      </div>
    </div>
  );
}
