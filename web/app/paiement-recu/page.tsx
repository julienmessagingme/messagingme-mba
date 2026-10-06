'use client';

import { useEffect, useState } from 'react';
import { Logo } from '@/components/Logo';
import { LocaleToggle } from '@/components/LocaleToggle';
import { TitrePage } from '@/components/TitrePage';
import { useT } from '@/lib/i18n';

/**
 * « /paiement-recu » (lot 4) : la page où Stripe renvoie après un réabonnement demandé à Claude
 * (`resubscribe_number`). Publique, sans session : le client de Claude Code n'a pas de session de console. Elle ne lit
 * rien et n'affirme rien du paiement lui-même : c'est le webhook qui le confirme, et Claude le dit
 * (`get_number_subscription`).
 */
export default function PaiementRecuPage() {
  const t = useT();
  /** `null` tant que l'adresse n'est pas lue : la page ne dit rien avant de savoir. */
  const [abandon, setAbandon] = useState<boolean | null>(null);
  useEffect(() => {
    setAbandon(new URLSearchParams(window.location.search).get('abonnement') === 'abandon');
  }, []);

  return (
    <main className="relative flex min-h-screen items-start justify-center px-4 py-12">
      <div className="absolute right-4 top-4"><LocaleToggle /></div>
      <div className="w-full max-w-formulaire">
        <Logo className="mx-auto mb-6 h-9 w-auto" />
        {abandon === null ? null : abandon ? (
          <div data-testid="paiement-abandonne">
            <TitrePage>{t('Paiement abandonné', 'Payment cancelled')}</TitrePage>
            <p className="mt-4 text-sm text-ink-700">{t('Rien n’a été prélevé. Retournez dans Claude : il peut vous redonner le lien quand vous voulez.', 'Nothing was charged. Go back to Claude: it can give you the link again whenever you want.')}</p>
          </div>
        ) : (
          <div data-testid="paiement-recu">
            <TitrePage>{t('Paiement reçu', 'Payment received')}</TitrePage>
            <p className="mt-4 text-sm text-ink-700">{t('Merci. Retournez dans Claude : il vous confirme le réabonnement de votre numéro dès que Stripe l’a validé, en général en quelques secondes.', 'Thank you. Go back to Claude: it confirms your number subscription as soon as Stripe has validated it, usually within seconds.')}</p>
          </div>
        )}
      </div>
    </main>
  );
}
