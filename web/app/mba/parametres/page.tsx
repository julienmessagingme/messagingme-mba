'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { useT } from '@/lib/i18n';
import { kickerCls } from '@/lib/ui';
import { getAccountStatus } from '@/lib/api';
import { getMbaStatus, type MbaSettings, type MbaStatus } from '@/lib/api-mba';
import { MbaTabs } from '@/components/MbaTabs';
import { MbaAssistantPanel } from '@/components/MbaAssistantPanel';
import { HistoriquePanel } from '@/components/HistoriquePanel';
import { MbaNotice } from '@/components/MbaNotice';
import { MbaGateBanner } from '@/components/MbaGateBanner';
import { MbaOverviewPanel } from '@/components/MbaOverviewPanel';
import { MbaActivationPanel } from '@/components/MbaActivationPanel';
import { MbaBusinessInfoPanel } from '@/components/MbaBusinessInfoPanel';
import { MbaFaqPanel } from '@/components/MbaFaqPanel';
import { MbaSkillsPanel } from '@/components/MbaSkillsPanel';
import { MbaWebsitesPanel } from '@/components/MbaWebsitesPanel';
import { MbaFilesPanel } from '@/components/MbaFilesPanel';
import { MbaTestPanel } from '@/components/MbaTestPanel';
import { MbaCompletion } from '@/components/MbaCompletion';
import { BibliothequeOutils } from '@/components/BibliothequeOutils';

export default function MbaSettingsPage() {
  // `useSearchParams` impose une frontière Suspense au build (règle Next 15), sinon la page bascule en rendu
  // dynamique et `next build` échoue.
  return (
    <AppShell active="mba-settings">
      {(session) => (
        <Suspense fallback={null}>
          {/* `isAdmin` descend d'ici parce que l'onglet Outils en a besoin : la création d'un outil pour
              Meta et la publication chez Meta sont réservées aux administrateurs, exactement comme sur
              `Tools > Outils`. Le déduire plus bas aurait fait deux vérités sur un même droit. */}
          <MbaSettings tenantId={session.tenantId} isAdmin={session.role === 'admin'} />
        </Suspense>
      )}
    </AppShell>
  );
}

// ⚠️ « assistant » EN DEUXIÈME, après l'aperçu : un onglet parmi les autres (décision de Julien), pas la
// porte d'entrée. En faire le premier déplacerait les repères de ceux qui utilisent déjà l'écran.
// ⚠️ « outils » APRÈS « competences », et le voisinage est le bon : une compétence dit QUOI FAIRE en
// langage naturel, un outil est ce que l'agent peut APPELER. Les deux répondent à « de quoi il est capable ».
const ONGLETS = ['apercu', 'assistant', 'activation', 'business', 'faq', 'competences', 'outils', 'fichiers', 'sites', 'historique', 'test'] as const;
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
function MbaSettings({ tenantId, isAdmin }: { tenantId: string; isAdmin: boolean }) {
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
  /**
   * ⚠️ `max-w-6xl` et non `4xl` (demandé par Julien le 2026-09-10) : huit onglets et des panneaux qui
   * listent des FAQ, des fichiers et des compétences n'ont rien à faire dans une colonne de 896 px sur un
   * écran de 1600. C'est l'écran le plus dense de la console, il est désormais le plus large.
   */
  const coquille = (contenu: React.ReactNode) => <div className="mx-auto max-w-6xl space-y-6">{entete}{contenu}</div>;

  if (chargement) return coquille(<p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>);
  if (err !== '') return coquille(<MbaNotice kind="error" testid="mba-page-error">{err}</MbaNotice>);
  if (phoneNumberId === null) return coquille(<MbaGateBanner reason="no-number" />);
  if (status === null || !status.eligible) return coquille(<MbaGateBanner reason="not-eligible" />);

  const props = { tenantId, phoneNumberId };

  return coquille(
    <>
      {/* La complétion AVANT les onglets : c'est ce qui manque qui doit se voir en arrivant, pas la liste
          des endroits où chercher. Elle n'apparaît que si la lecture a abouti. */}
      {phoneNumberId && <MbaCompletion tenantId={tenantId} phoneNumberId={phoneNumberId} onOnglet={choisirOnglet} />}
      <MbaTabs
        active={onglet}
        onSelect={choisirOnglet}
        tabs={[
          { key: 'apercu', label: t('Vue d’ensemble', 'Overview') },
          { key: 'assistant', label: t('Assistant', 'Assistant') },
          { key: 'activation', label: t('Activation', 'Activation') },
          { key: 'business', label: t('Informations', 'Business info') },
          { key: 'faq', label: t('FAQ', 'FAQ') },
          { key: 'competences', label: t('Compétences', 'Skills') },
          { key: 'outils', label: t('Outils', 'Tools') },
          { key: 'fichiers', label: t('Fichiers', 'Files') },
          { key: 'sites', label: t('Sites web', 'Websites') },
          { key: 'historique', label: t('Historique', 'History') },
          { key: 'test', label: t('Tester', 'Test') },
        ]}
      />

      {onglet === 'apercu' && <MbaOverviewPanel {...props} status={status} onChange={majReglages} />}
      {onglet === 'assistant' && <MbaAssistantPanel tenantId={tenantId} />}
      {onglet === 'activation' && <MbaActivationPanel tenantId={tenantId} />}
      {onglet === 'business' && <MbaBusinessInfoPanel {...props} />}
      {onglet === 'faq' && <MbaFaqPanel {...props} />}
      {onglet === 'competences' && <MbaSkillsPanel {...props} />}
      {/* 🔴 LE MÊME ÉCRAN QUE `Tools > Outils`, ET C'EST VOULU. La bibliothèque appartient à l'ESPACE : elle
          est partagée par tous les consommateurs, donc sa place est bien dans Tools. Mais c'est là, et nulle
          part ailleurs, qu'on décide ce que l'agent de Meta peut appeler (`exposerOutilAuMba`), qu'on crée un
          outil pour lui sans passer par un agent IA, et qu'on publie chez Meta (`publierChezMeta`) : les
          trois n'ont chacun qu'un seul appelant, ce fichier-ci. Un client qui configure son MBA cherche ses
          outils dans les onglets du MBA, et il n'y en avait aucun. Deux chemins vers un écran unique, pas
          deux écrans. */}
      {onglet === 'outils' && <BibliothequeOutils tenantId={tenantId} isAdmin={isAdmin} />}
      {onglet === 'fichiers' && <MbaFilesPanel {...props} />}
      {onglet === 'sites' && <MbaWebsitesPanel {...props} />}
      {onglet === 'historique' && <HistoriquePanel tenantId={tenantId} surface="mba" />}
      {onglet === 'test' && <MbaTestPanel {...props} />}
    </>,
  );
}
