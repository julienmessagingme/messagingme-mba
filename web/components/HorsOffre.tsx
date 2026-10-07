'use client';

import Link from 'next/link';
import { Icone } from './Icone';
import { useT } from '@/lib/i18n';
import { phraseInclusDans, type FonctionOffre, type VueOffre } from '@/lib/offre';

/**
 * LA LIGNE D'UNE FONCTION QUE L'OFFRE N'OUVRE PAS (lot 6), dans un écran ouvert : « Inclus dans l'offre Pro. Voir les
 * offres ». Elle remplace l'état qu'une carte aurait lu (et qu'elle ne lit plus), plutôt qu'un « État inconnu » qui
 * ferait chercher une panne.
 */
export function HorsOffre({ fonction, vue, className = '' }: { fonction: FonctionOffre; vue: VueOffre; className?: string }) {
  const t = useT();
  return (
    <p className={`flex flex-wrap items-center gap-1.5 text-sm text-ink-500 ${className}`} data-testid={`hors-offre-${fonction}`}>
      <Icone nom="cadenas" taille="petite" className="text-ink-400" />
      <span>{phraseInclusDans(vue, fonction, t)}</span>
      <Link href={`/offre?fonction=${fonction}`} className="font-medium text-brand-600 hover:underline">{t('Voir les offres', 'See plans')}</Link>
    </p>
  );
}
