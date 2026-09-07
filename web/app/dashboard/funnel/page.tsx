'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { CampaignFunnelCard } from '@/components/analytics/cartes';
import type { Session } from '@/lib/session';
import { listCampaigns, type CampaignSummary } from '@/lib/api';
import { useT } from '@/lib/i18n';

/**
 * Analytics > Quantitatif > **Funnel** : ce que devient une campagne, de l'envoi à la réponse.
 *
 * ⚠️ PAS DE BARRE DE PÉRIODE ICI, et c'est délibéré. Un funnel décrit UNE campagne du début à sa fin, pas
 * une fenêtre de temps : lui poser une période découperait l'entonnoir en tranches qui ne veulent rien dire
 * (des envois d'avant la fenêtre, des réponses d'après). C'est la campagne qui est l'unité, pas le jour.
 * C'était déjà vrai quand la carte vivait dans la page unique, où la barre de période ne l'affectait pas.
 */
export default function FunnelPage() {
  return <AppShell active="quanti-funnel">{(session) => <FunnelInner session={session} />}</AppShell>;
}

function FunnelInner({ session }: { session: Session }) {
  const t = useT();
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const cp = await listCampaigns(session.tenantId);
      setCampaigns(Array.isArray(cp?.campaigns) ? cp.campaigns : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-ink-900">
          {t('Funnel par campagne', 'Funnel by campaign')}
        </h1>
        <p className="text-sm text-ink-500">
          {t('envoyés, délivrés, lus, répondus, et les échecs', 'sent, delivered, read, replied, and failures')}
        </p>
        {/* DIT l'absence de barre de période au lieu de la laisser passer pour un oubli. Les trois autres
            sous-onglets en ont une ; ici elle n'aurait rien à filtrer, et découperait l'entonnoir en
            tranches fausses (des envois d'avant la fenêtre, des réponses d'après). */}
        <p className="pt-1 text-xs text-ink-400">
          {t(
            'Pas de période ici : un funnel porte sur toute la campagne, de son premier envoi à sa dernière réponse.',
            'No period here: a funnel covers the whole campaign, from its first send to its last reply.',
          )}
        </p>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {loading ? (
        <p className="text-sm text-ink-500">{t('Chargement des statistiques...', 'Loading statistics...')}</p>
      ) : (
        <CampaignFunnelCard tenantId={session.tenantId} campaigns={campaigns} />
      )}
    </div>
  );
}
