'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { TitrePage, IntroPage } from '@/components/TitrePage';
import { classesBouton } from '@/components/Bouton';
import { PiloterDepuisClaude } from '@/components/PiloterDepuisClaude';
import type { Session } from '@/lib/session';
import { useT } from '@/lib/i18n';
import { getAccountStatus, type AccountStatusResponse } from '@/lib/api';
import { CLE_SUITE, SUITE_DEMARRER } from '@/lib/demarrer';

/**
 * LA PAGE FINALE DU TUNNEL DE LA BASE (lot 19, plan `docs/superpowers/plans/2026-10-08-tunnel-de-la-base.md`) : un
 * espace qui vient de naître y trouve tout pour vivre dans Claude Code, dans l'ordre où il s'en sert. Le numéro (connecté,
 * ou à connecter maintenant ou plus tard), les deux commandes qui installent le plugin Claude Code (lot 10, B), la clé de
 * son application, et `/messagingme:demarrer`, qui lance la mise en service. La logique est dans `lib/demarrer.ts`.
 */
export default function DemarrerPage() {
  return <AppShell active="accueil">{(session) => <Demarrer session={session} />}</AppShell>;
}

function Demarrer({ session }: { session: Session }) {
  const t = useT();
  const tenantId = session.tenantId;
  const isAdmin = session.role === 'admin';
  const [compte, setCompte] = useState<AccountStatusResponse | null>(null);
  useEffect(() => {
    getAccountStatus(tenantId).then(setCompte).catch(() => { /* la page reste utilisable sans le statut */ });
  }, [tenantId]);
  const connecte = compte?.hasNumber === true;
  // Le tunnel est fini : la page du numéro, rouverte plus tard dans cet onglet, redevient elle-même.
  useEffect(() => { try { window.sessionStorage.removeItem(CLE_SUITE); } catch { /* mémoire indisponible */ } }, []);

  return (
    <div className="mx-auto max-w-formulaire">
      <TitrePage>{t('Votre espace est prêt', 'Your workspace is ready')}</TitrePage>
      <IntroPage>{t('Tout pour piloter WhatsApp depuis Claude Code, en quelques copier-coller.', 'Everything to run WhatsApp from Claude Code, in a few copy-pastes.')}</IntroPage>

      <section className="mt-6 rounded-carte border border-ink-200 bg-white p-5" data-testid="demarrer-numero">
        <h2 className="text-base font-semibold text-ink-900">{t('Votre numéro WhatsApp', 'Your WhatsApp number')}</h2>
        {connecte ? (
          <p className="mt-1 text-sm text-ink-500">{t('Connecté', 'Connected')} : {compte?.number ?? ''}</p>
        ) : (
          <>
            <p className="mt-1 text-sm text-ink-500">
              {t('Pas encore connecté. Vous pouvez le faire maintenant, ou plus tard : Claude saura vous y mener.', 'Not connected yet. Do it now, or later: Claude will guide you there.')}
            </p>
            {compte && (
              <Link href={`/connecter-whatsapp?suite=${SUITE_DEMARRER}`} className={classesBouton('secondaire', 'petite', 'mt-3 inline-flex')} data-testid="demarrer-connecter-numero">
                {t('Connecter mon numéro', 'Connect my number')}
              </Link>
            )}
          </>
        )}
      </section>

      <PiloterDepuisClaude tenantId={tenantId} isAdmin={isAdmin} />

      <Link href="/accueil" className="mt-6 inline-block text-sm font-semibold text-ink-900 underline" data-testid="demarrer-accueil">
        {t('Aller à l’accueil de la console', 'Go to the console home')}
      </Link>
    </div>
  );
}
