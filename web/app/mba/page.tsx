'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useT } from '@/lib/i18n';

/**
 * `/mba` RESTE SERVIE pour les liens déjà partagés, et renvoie vers les paramètres de l'agent de Meta. Le guide qui
 * vivait ici a été retiré le 2026-09-29 (décision de Julien) : le menu « AI Agent » mène désormais droit aux
 * paramètres, et ce qui est vrai de l'éligibilité est dit là où elle bloque (`MbaGateBanner`). `replace` et pas
 * `push` : le retour arrière ne doit pas ramener sur une page qui repart aussitôt.
 */
export default function MbaRedirection() {
  const router = useRouter();
  const t = useT();
  useEffect(() => { router.replace('/mba/parametres'); }, [router]);
  return (
    <p className="p-6 text-sm text-ink-500" data-testid="mba-redirection">
      {t('Ouverture des paramètres de l’agent de Meta.', 'Opening Meta’s agent settings.')}
    </p>
  );
}
