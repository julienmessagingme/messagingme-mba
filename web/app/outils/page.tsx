'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/lib/i18n';

/**
 * `/outils` RESTE SERVIE pour les liens déjà partagés, et renvoie vers l'onglet « Outils » de l'agent de Meta
 * (spec 2026-09-21-outils-maison-mba, § 9.5). `replace` et pas `push` : le retour arrière ne doit pas ramener
 * sur une page qui repart aussitôt. Pas d'`AppShell` : la page ne vit que le temps de partir.
 */
export default function OutilsRedirection() {
  const router = useRouter();
  const t = useT();
  useEffect(() => { router.replace('/mba/parametres?tab=outils'); }, [router]);
  return (
    <p className="p-6 text-sm text-ink-500" data-testid="outils-redirection">
      {t('Les outils de l’agent de Meta ont déménagé dans Meta Business Agent > Paramètres > Outils.',
        'Meta’s agent tools moved to Meta Business Agent > Settings > Tools.')}
    </p>
  );
}
