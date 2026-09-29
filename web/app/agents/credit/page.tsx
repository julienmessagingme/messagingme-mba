'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/lib/i18n';

/**
 * `/agents/credit` RESTE SERVIE pour les liens déjà partagés, et renvoie vers Paramètres > Crédit IA, où le crédit a
 * déménagé le 2026-09-29 (il paie les agents ET la traduction de l'Inbox : c'est un réglage de l'espace, pas d'un
 * agent). `replace` et pas `push` : le retour arrière ne doit pas ramener sur une page qui repart aussitôt. Pas
 * d'`AppShell` : la page ne vit que le temps de partir.
 */
export default function CreditRedirection() {
  const router = useRouter();
  const t = useT();
  useEffect(() => { router.replace('/parametres/credit'); }, [router]);
  return (
    <p className="p-6 text-sm text-ink-500" data-testid="credit-redirection">
      {t('Le crédit IA a déménagé dans Paramètres > Crédit IA.', 'The AI credit moved to Settings > AI credit.')}
    </p>
  );
}
