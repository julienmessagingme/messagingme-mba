'use client';

import Link from 'next/link';
import { Icone } from './Icone';
import { classesBouton } from './Bouton';
import { useT } from '@/lib/i18n';
import { libelleFonction, nomDeLOffre, offreQuiOuvre, type FonctionOffre, type VueOffre } from '@/lib/offre';

/**
 * L'ÉCRAN D'UNE FONCTION QUE L'OFFRE N'OUVRE PAS (lot 6), à la place de l'écran lui-même : la coquille le pose quand on
 * arrive sur une adresse payante (un favori, un lien partagé, le menu grisé). Sans lui, l'écran se monterait et chacun de
 * ses appels prendrait un 402 : une page d'erreurs au lieu d'une phrase qui dit quoi faire.
 */
export function EncartOffre({ fonction, vue }: { fonction: FonctionOffre; vue: VueOffre }) {
  const t = useT();
  const offre = offreQuiOuvre(vue, fonction);
  return (
    <div className="mx-auto max-w-formulaire px-4 py-12 text-center" data-testid="encart-offre">
      <Icone nom="cadenas" taille="grande" className="mx-auto text-ink-400" />
      <h1 className="mt-3 text-lg font-semibold text-ink-900">{libelleFonction(fonction, t)}</h1>
      <p className="mt-2 text-sm text-ink-500">
        {offre
          ? t(`Cet écran fait partie de l’offre ${nomDeLOffre(offre, t)}. Votre espace est en offre ${nomDeLOffre(vue.offre, t)}.`,
            `This screen is part of the ${nomDeLOffre(offre, t)} plan. Your workspace is on the ${nomDeLOffre(vue.offre, t)} plan.`)
          : t('Cet écran ne fait pas partie de votre offre.', 'This screen is not part of your plan.')}
      </p>
      <Link href={`/offre?fonction=${fonction}`} className={classesBouton('principal', 'normale', 'mt-5')} data-testid="encart-offre-lien">
        {t('Voir les offres', 'See plans')}
      </Link>
    </div>
  );
}
