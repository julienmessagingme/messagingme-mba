'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RangeBar } from '@/components/RangeBar';
import { CostChartCard, FactureCard, TemplateBreakdownCard } from '@/components/analytics/cartes';
import type { Session } from '@/lib/session';
import { getTemplateStats, listCampaigns, type CampaignSummary, type StatsRange, type TemplateStats } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { presetRange } from '@/lib/range';

/**
 * Analytics > Quantitatif > **Coûts** : ce qui a été estimé, ce que Meta a facturé, et le détail par template.
 *
 * 🔴 LES TROIS CARTES SONT ENSEMBLE PARCE QU'ELLES SE LISENT ENSEMBLE, et surtout parce que deux d'entre
 * elles se contredisent en apparence : l'estimation (notre volume multiplié par un tarif moyen) ne donnera
 * jamais le montant facturé par Meta. Séparées, la question « pourquoi 1,98 et pas 2,42 ? » revenait à
 * chaque lecture. Voisines, l'explication tient dans une phrase de `FactureCard`.
 */
export default function CoutsPage() {
  return <AppShell active="quanti-couts">{(session) => <CoutsInner session={session} />}</AppShell>;
}

function CoutsInner({ session }: { session: Session }) {
  const t = useT();
  // Même période par défaut que les autres sous-onglets : passer de l'un à l'autre ne doit pas changer la
  // fenêtre sous les pieds du lecteur.
  const [range, setRange] = useState<StatsRange>(() => presetRange(30));
  const [templateStats, setTemplateStats] = useState<TemplateStats | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [ts, cp] = await Promise.all([
        getTemplateStats(session.tenantId, range),
        listCampaigns(session.tenantId),
      ]);
      setTemplateStats(ts ?? null);
      setCampaigns(Array.isArray(cp?.campaigns) ? cp.campaigns : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, range, t]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      <RangeBar title={t('Coûts', 'Costs')} range={range} onChange={setRange} />
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {loading ? (
        <p className="text-sm text-ink-500">{t('Chargement des statistiques...', 'Loading statistics...')}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="lg:col-span-2">
            <CostChartCard tenantId={session.tenantId} range={range} campaigns={campaigns} templates={templateStats?.breakdown ?? []} />
          </div>
          <FactureCard data={templateStats} />
          <TemplateBreakdownCard data={templateStats} />
        </div>
      )}
    </div>
  );
}
