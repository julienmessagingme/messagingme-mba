'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { useT } from '@/lib/i18n';
import { kickerCls } from '@/lib/ui';
import { getAccountStatus } from '@/lib/api';
import { getMbaStatus, type MbaSettings, type MbaStatus } from '@/lib/api-mba';
import { MbaTabs } from '@/components/MbaTabs';
import { MbaNotice } from '@/components/MbaNotice';
import { MbaGateBanner } from '@/components/MbaGateBanner';
import { MbaOverviewPanel } from '@/components/MbaOverviewPanel';
import { MbaBusinessInfoPanel } from '@/components/MbaBusinessInfoPanel';
import { MbaFaqPanel } from '@/components/MbaFaqPanel';
import { MbaSkillsPanel } from '@/components/MbaSkillsPanel';
import { MbaWebsitesPanel } from '@/components/MbaWebsitesPanel';
import { MbaFilesPanel } from '@/components/MbaFilesPanel';
import { MbaAllowlistPanel } from '@/components/MbaAllowlistPanel';
import { MbaTestPanel } from '@/components/MbaTestPanel';

export default function MbaSettingsPage() {
  // `useSearchParams` impose une frontière Suspense au build (règle Next 15), sinon la page bascule en rendu
  // dynamique et `next build` échoue.
  return (
    <AppShell active="mba-settings">
      {(session) => (
        <Suspense fallback={null}>
          <MbaSettings tenantId={session.tenantId} />
        </Suspense>
      )}
    </AppShell>
  );
}

const ONGLETS = ['apercu', 'business', 'faq', 'competences', 'fichiers', 'sites', 'allowlist', 'test'] as const;
type Onglet = (typeof ONGLETS)[number];

function lireOnglet(v: string | null): Onglet {
  return v !== null && (ONGLETS as readonly string[]).includes(v) ? (v as Onglet) : 'apercu';
}

/**
 * Configuration de l'agent MBA, branchée sur les routes `/tenants/:t/mba/:phoneNumberId/*`.
 *
 * Trois états, là où la maquette précédente n'en connaissait qu'un seul (« bloqué ») : pas de numéro, numéro
 * pas encore ouvert par Meta, et le cas normal. `onboarded: false` n'est PAS un blocage : seules les
 * compétences exigent que Meta ait créé la configuration, tout le reste s'édite déjà.
 */
function MbaSettings({ tenantId }: { tenantId: string }) {
  const t = useT();
  const router = useRouter();
  const params = useSearchParams();
  const onglet = lireOnglet(params.get('tab'));

  const [phoneNumberId, setPhoneNumberId] = useState<string | null>(null);
  const [status, setStatus] = useState<MbaStatus | null>(null);
  const [chargement, setChargement] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    let vivant = true;
    (async () => {
      const compte = await getAccountStatus(tenantId);
      if (!vivant) return;
      if (!compte.hasNumber || compte.phoneNumberId === null) return;
      setPhoneNumberId(compte.phoneNumberId);
      const s = await getMbaStatus(tenantId, compte.phoneNumberId);
      if (vivant) setStatus(s);
    })()
      .catch((e: unknown) => { if (vivant) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (vivant) setChargement(false); });
    return () => { vivant = false; };
  }, [tenantId]);

  // L'onglet vit dans l'adresse : la page est partageable, et le navigateur retrouve où on en était.
  const choisirOnglet = useCallback((cle: string) => {
    router.replace(`/mba/parametres?tab=${cle}`, { scroll: false });
  }, [router]);

  const majReglages = useCallback((settings: MbaSettings) => {
    setStatus((s) => (s === null ? s : {
      ...s,
      settings,
      onboarded: true,
      agentId: typeof settings.agent_id === 'string' ? settings.agent_id : s.agentId,
    }));
  }, []);

  const entete = (
    <header className="space-y-1">
      <span className={kickerCls}>{t('MBA', 'MBA')}</span>
      <h2 className="text-xl font-semibold tracking-tight text-ink-900">{t('Paramètres de l’agent', 'Agent settings')}</h2>
      <p className="text-sm text-ink-600">
        {t('Ce que votre agent sait, ce qu’il a le droit de dire, et à qui il répond.', 'What your agent knows, what it may say, and who it answers.')}
      </p>
    </header>
  );
  const coquille = (contenu: React.ReactNode) => <div className="mx-auto max-w-4xl space-y-6">{entete}{contenu}</div>;

  if (chargement) return coquille(<p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>);
  if (err !== '') return coquille(<MbaNotice kind="error" testid="mba-page-error">{err}</MbaNotice>);
  if (phoneNumberId === null) return coquille(<MbaGateBanner reason="no-number" />);
  if (status === null || !status.eligible) return coquille(<MbaGateBanner reason="not-eligible" />);

  const audience = status.settings?.ai_audience === 'ALLOWLISTED_ONLY' ? 'ALLOWLISTED_ONLY' : 'EVERYONE';
  const props = { tenantId, phoneNumberId };

  return coquille(
    <>
      <MbaTabs
        active={onglet}
        onSelect={choisirOnglet}
        tabs={[
          { key: 'apercu', label: t('Vue d’ensemble', 'Overview') },
          { key: 'business', label: t('Informations', 'Business info') },
          { key: 'faq', label: t('FAQ', 'FAQ') },
          { key: 'competences', label: t('Compétences', 'Skills') },
          { key: 'fichiers', label: t('Fichiers', 'Files') },
          { key: 'sites', label: t('Sites web', 'Websites') },
          { key: 'allowlist', label: t('Liste d’autorisation', 'Allowlist') },
          { key: 'test', label: t('Tester', 'Test') },
        ]}
      />

      {onglet === 'apercu' && <MbaOverviewPanel {...props} status={status} onChange={majReglages} />}
      {onglet === 'business' && <MbaBusinessInfoPanel {...props} />}
      {onglet === 'faq' && <MbaFaqPanel {...props} />}
      {onglet === 'competences' && <MbaSkillsPanel {...props} />}
      {onglet === 'fichiers' && <MbaFilesPanel {...props} />}
      {onglet === 'sites' && <MbaWebsitesPanel {...props} />}
      {onglet === 'allowlist' && <MbaAllowlistPanel {...props} audience={audience} />}
      {onglet === 'test' && <MbaTestPanel {...props} />}
    </>,
  );
}
