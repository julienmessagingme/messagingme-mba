'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AppShell } from '@/components/AppShell';
import { TitrePage, IntroPage } from '@/components/TitrePage';
import { ParcoursNumero } from '@/components/ParcoursNumero';
import type { Session } from '@/lib/session';
import { useT } from '@/lib/i18n';
import { getAccountStatus, type AccountStatusResponse } from '@/lib/api';
import { apiDeLaSession } from '@/lib/api/connexion-numero';

/**
 * « CONNECTER WHATSAPP » dans la console (lot 3b, spec `docs/superpowers/specs/2026-10-05-numero-fourni-design.md`).
 * Le parcours lui-même vit dans `ParcoursNumero`, partagé avec `/brancher`, la page qu'ouvre le lien de Claude Code
 * (lot 3c) ; celle-ci y ajoute la coquille, la session et l'état du compte.
 */
export default function ConnecterWhatsappPage() {
  return <AppShell active="accueil">{(session) => <ConnecterWhatsapp session={session} />}</AppShell>;
}

function ConnecterWhatsapp({ session }: { session: Session }) {
  const t = useT();
  const tenantId = session.tenantId;
  const isAdmin = session.role === 'admin';
  const [compte, setCompte] = useState<AccountStatusResponse | null>(null);
  const [avertissements, setAvertissements] = useState<string[]>([]);
  const api = useMemo(() => apiDeLaSession(tenantId), [tenantId]);

  const chargerCompte = useCallback(() => {
    getAccountStatus(tenantId).then(setCompte).catch(() => { /* l'écran reste utilisable sans le statut */ });
  }, [tenantId]);
  useEffect(() => { chargerCompte(); }, [chargerCompte]);

  const connecte = compte?.hasNumber === true;
  return (
    <div className="mx-auto max-w-formulaire">
      <TitrePage>{t('Connecter WhatsApp', 'Connect WhatsApp')}</TitrePage>
      <IntroPage>{t('Un numéro WhatsApp pour votre espace : le vôtre, ou un numéro que nous vous fournissons.', 'A WhatsApp number for your workspace: yours, or one we provide.')}</IntroPage>

      {connecte ? (
        <div data-testid="numero-connecte" className="mt-6 rounded-carte border border-ink-200 bg-white p-5">
          <div className="text-lg font-semibold text-ink-900">{t('Votre numéro WhatsApp est connecté', 'Your WhatsApp number is connected')}</div>
          <p className="mt-1 text-sm text-ink-500">{compte?.number ?? ''}</p>
          <Link href="/accueil" className="mt-4 inline-block text-sm font-semibold text-ink-900 underline">{t('Retour à l’accueil', 'Back to home')}</Link>
        </div>
      ) : !isAdmin ? (
        <p className="mt-6 text-sm text-ink-500">{t('Réservé aux admins de l’espace.', 'Workspace admins only.')}</p>
      ) : (
        <ParcoursNumero
          tenantId={tenantId}
          api={api}
          choixInitial={null}
          connecte={connecte}
          surConnexion={(av) => { setAvertissements(av); chargerCompte(); }}
        />
      )}

      {avertissements.length > 0 && (
        <p data-testid="avertissements-connexion" className="mt-4 rounded-controle bg-alerte-50 px-3 py-2 text-xs text-alerte-700">
          {t('À savoir', 'Note')} : {avertissements.join(' · ')}
        </p>
      )}
    </div>
  );
}
