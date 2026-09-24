'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
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
  /**
   * ⚠️ `Suspense` PARCE QUE `useSearchParams` L'EXIGE dans l'App Router, comme sur le Funnel : sans lui, la
   * page entière bascule en rendu client au build et Next le signale. Le repli est l'écran sans période
   * demandée, donc exactement le comportement d'avant l'adresse datée.
   */
  return (
    <AppShell active="quanti-couts">
      {(session) => (
        <Suspense fallback={null}>
          <CoutsInner session={session} />
        </Suspense>
      )}
    </AppShell>
  );
}

/**
 * La période demandée par l'adresse (`?du=&au=`), posée par les postes de messages de la synthèse.
 *
 * 🔴 VALIDÉE, PAS SEULEMENT LUE. Ces deux valeurs partent droit dans un appel d'API : une adresse bricolée
 * à la main enverrait n'importe quoi au serveur. Le format civil est le seul accepté, et le moindre doute
 * retombe sur le défaut, qui est le comportement d'avant.
 */
function periodeDemandee(du: string | null, au: string | null): StatsRange | null {
  const civil = /^\d{4}-\d{2}-\d{2}$/;
  if (du === null || au === null || !civil.test(du) || !civil.test(au) || du > au) return null;
  return { from: du, to: au };
}

function CoutsInner({ session }: { session: Session }) {
  const t = useT();
  /**
   * Même période par DÉFAUT que les autres sous-onglets : passer de l'un à l'autre ne change pas la fenêtre
   * sous les pieds du lecteur. Mais l'ADRESSE gagne quand elle en porte une, parce qu'on arrive ici depuis
   * la synthèse : rendre 30 jours là où elle en montrait 90 ferait deux écrans qui se contredisent sur la
   * même question, et c'est le pire des deux défauts.
   *
   * 🔴 CE CHOIX CASSE L'INVARIANT DU DESSUS DANS UN SENS, ET C'EST ASSUMÉ. Arrivé ici sur 90 jours par un
   * lien, le lecteur qui repart vers « Messages & contacts » retombe sur 30 : cet écran-là ne lit aucune
   * période dans l'adresse. Le jour où ça gêne, la réparation n'est pas de retirer la lecture ici, c'est de
   * faire voyager la période entre tous les sous-onglets, ce qui est un autre lot.
   */
  const params = useSearchParams();
  const [range, setRange] = useState<StatsRange>(
    () => periodeDemandee(params.get('du'), params.get('au')) ?? presetRange(30));
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
