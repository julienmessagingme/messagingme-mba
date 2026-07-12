'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { DailyChart } from '@/components/DailyChart';
import type { Session } from '@/lib/session';
import {
  getStats, getTemplateStats, getErrorBreakdown, getCampaignFunnel, getCostSeries, listCampaigns,
  type DashboardStats, type TemplateStats, type StatsRange, type ErrorBreakdownRow, type CampaignFunnel,
  type CostSeries, type CampaignSummary,
} from '@/lib/api';
import { metaCodeLabel } from '@/lib/meta-errors';
import { fmtCost, fmtNum, fmtPct } from '@/lib/format';

export default function DashboardPage() {
  return <AppShell active="dashboard">{(session) => <DashboardInner session={session} />}</AppShell>;
}

/** Date du jour Europe/Paris (YYYY-MM-DD). */
function todayParis(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
}
function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + delta * 86400000).toISOString().slice(0, 10);
}
function presetRange(days: number): StatsRange {
  const to = todayParis();
  return { from: addDays(to, -(days - 1)), to };
}
const PRESETS = [7, 30, 90];

function DashboardInner({ session }: { session: Session }) {
  const [range, setRange] = useState<StatsRange>(() => presetRange(30));
  const [draftFrom, setDraftFrom] = useState(range.from);
  const [draftTo, setDraftTo] = useState(range.to);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [templateStats, setTemplateStats] = useState<TemplateStats | null>(null);
  const [errors, setErrors] = useState<ErrorBreakdownRow[]>([]);
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const today = todayParis();
  const activePreset = range.to === today ? PRESETS.find((d) => range.from === addDays(today, -(d - 1))) ?? null : null;

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, ts, eb, cp] = await Promise.all([
        getStats(session.tenantId, range),
        getTemplateStats(session.tenantId, range),
        getErrorBreakdown(session.tenantId, range),
        listCampaigns(session.tenantId),
      ]);
      setStats(s);
      setTemplateStats(ts);
      setErrors(eb.errors);
      setCampaigns(cp.campaigns);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, range]);

  useEffect(() => {
    void load();
  }, [load]);

  function applyPreset(d: number) {
    const r = presetRange(d);
    setRange(r);
    setDraftFrom(r.from);
    setDraftTo(r.to);
  }
  function applyCustom() {
    if (draftFrom && draftTo && draftFrom <= draftTo) setRange({ from: draftFrom, to: draftTo });
  }

  const inputCls ='rounded-md border border-ink-300 bg-white px-2 py-1 text-xs text-ink-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight text-ink-900">Analytics</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex gap-1 rounded-lg bg-ink-100 p-1 text-xs">
            {PRESETS.map((d) => (
              <button
                key={d}
                onClick={() => applyPreset(d)}
                className={`rounded-md px-2.5 py-1 ${activePreset === d ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
              >
                {d} j
              </button>
            ))}
          </div>
          <div className="inline-flex items-center gap-1.5">
            <input type="date" value={draftFrom} max={draftTo || today} onChange={(e) => setDraftFrom(e.target.value)} className={inputCls} />
            <span className="text-ink-400">→</span>
            <input type="date" value={draftTo} min={draftFrom} max={today} onChange={(e) => setDraftTo(e.target.value)} className={inputCls} />
            <button
              onClick={applyCustom}
              disabled={!draftFrom || !draftTo || draftFrom > draftTo}
              className="rounded-md bg-brand-500 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
            >
              Appliquer
            </button>
          </div>
        </div>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {loading ? (
        <p className="text-sm text-ink-500">Chargement des statistiques...</p>
      ) : stats ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <DailyChart
            title="Contacts"
            subtitle="total cumulé"
            from={range.from}
            to={range.to}
            summary="last"
            series={[{ label: 'Contacts', color: '#009AFE', points: stats.contacts }]}
          />
          <DailyChart
            title="Messages échangés"
            subtitle="reçus + réponses (hors template)"
            from={range.from}
            to={range.to}
            series={[{ label: 'Échangés', color: '#6E5AE0', points: stats.exchanged }]}
          />
          <div className="lg:col-span-2">
            <DailyChart
              title="Templates envoyés"
              subtitle="par jour, marketing vs utility"
              from={range.from}
              to={range.to}
              series={[
                { label: 'Marketing', color: '#0080D6', points: stats.templates.marketing },
                { label: 'Utility', color: '#17C74E', points: stats.templates.utility },
              ]}
            />
          </div>
          <div className="lg:col-span-2">
            <CostChartCard tenantId={session.tenantId} range={range} campaigns={campaigns} templates={templateStats?.breakdown ?? []} />
          </div>
          <CampaignFunnelCard tenantId={session.tenantId} campaigns={campaigns} />
          <ErrorBreakdownCard errors={errors} />
          <div className="lg:col-span-2">
            <TemplateBreakdownCard data={templateStats} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Funnel d'UNE campagne : envoyés -> délivrés -> lus -> répondus (+ échecs). Remplace le funnel global.
 * « répondu » = message entrant reçu après l'envoi (peut dépasser « lu » si les accusés sont désactivés).
 */
function CampaignFunnelCard({ tenantId, campaigns }: { tenantId: string; campaigns: CampaignSummary[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [funnel, setFunnel] = useState<CampaignFunnel | null>(null);
  const [loading, setLoading] = useState(false);
  const current = campaigns.find((c) => c.id === selected) ?? campaigns[0] ?? null;
  const currentId = current?.id ?? null;

  // Dépend de l'ID (pas de l'objet `current`) : un rechargement de `campaigns` au changement de plage
  // recrée le tableau mais le funnel d'une campagne ne dépend pas de la plage -> pas de refetch inutile.
  useEffect(() => {
    if (!currentId) { setFunnel(null); return; }
    let alive = true;
    setLoading(true);
    getCampaignFunnel(tenantId, currentId)
      .then((f) => { if (alive) setFunnel(f); })
      .catch(() => { if (alive) setFunnel(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tenantId, currentId]);

  const sent = funnel?.sent ?? 0;
  const pct = (n: number) => (sent > 0 ? Math.max(2, Math.round((n / sent) * 100)) : 0);
  const bars = funnel
    ? [
        { label: 'Envoyés', value: funnel.sent, color: '#009AFE', sub: '' },
        { label: 'Délivrés', value: funnel.delivered, color: '#17C74E', sub: fmtPct(funnel.delivered, sent) },
        { label: 'Lus', value: funnel.read, color: '#6E5AE0', sub: fmtPct(funnel.read, sent) },
        { label: 'Répondus', value: funnel.replied, color: '#F5A623', sub: fmtPct(funnel.replied, sent) },
      ]
    : [];

  return (
    <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold tracking-tight text-ink-900">Funnel par campagne</h3>
          <p className="text-xs text-ink-400">envoyés → délivrés → lus → répondus</p>
        </div>
        {campaigns.length > 0 && (
          <select
            value={current?.id ?? ''}
            onChange={(e) => setSelected(e.target.value)}
            className="max-w-[60%] rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-sm text-ink-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          >
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
      </div>
      {campaigns.length === 0 ? (
        <p className="text-sm text-ink-500">Aucune campagne pour le moment.</p>
      ) : loading ? (
        <p className="text-sm text-ink-500">Chargement…</p>
      ) : !funnel || sent === 0 ? (
        <p className="text-sm text-ink-500">Aucun envoi sur cette campagne.</p>
      ) : (
        <div className="space-y-2.5">
          {bars.map((b) => (
            <div key={b.label} className="flex items-center gap-3">
              <div className="w-24 shrink-0 text-xs text-ink-600">{b.label}</div>
              <div className="h-6 flex-1 overflow-hidden rounded-md bg-ink-50">
                <div className="flex h-full items-center rounded-md px-2 text-[11px] font-medium text-white" style={{ width: `${pct(b.value)}%`, backgroundColor: b.color }}>
                  {fmtNum(b.value)}
                </div>
              </div>
              <div className="w-12 shrink-0 text-right text-xs tabular-nums text-ink-500">{b.sub}</div>
            </div>
          ))}
          {funnel.failed > 0 && (
            <p className="pt-1 text-xs text-ink-400">Échecs : <span className="font-medium text-coral">{fmtNum(funnel.failed)}</span></p>
          )}
        </div>
      )}
    </div>
  );
}

/** Breakdown des codes d'erreur Meta sur la période (avec libellé FR). */
function ErrorBreakdownCard({ errors }: { errors: ErrorBreakdownRow[] }) {
  const total = errors.reduce((a, e) => a + e.count, 0);
  const max = errors.reduce((m, e) => Math.max(m, e.count), 0);
  return (
    <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="mb-3">
        <h3 className="text-sm font-semibold tracking-tight text-ink-900">Erreurs Meta</h3>
        <p className="text-xs text-ink-400">par code, sur la période</p>
      </div>
      {errors.length === 0 ? (
        <p className="text-sm text-ink-500">Aucune erreur sur la période.</p>
      ) : (
        <div className="space-y-2.5">
          {errors.map((e) => (
            <div key={e.code}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-xs font-medium text-ink-700">{e.code}</span>
                <span className="text-xs tabular-nums text-ink-500">{fmtNum(e.count)}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-50">
                <div className="h-full rounded-full bg-coral" style={{ width: `${max > 0 ? Math.max(4, Math.round((e.count / max) * 100)) : 0}%` }} />
              </div>
              <p className="mt-0.5 text-[11px] text-ink-400">{metaCodeLabel(e.code)}</p>
            </div>
          ))}
          <p className="pt-1 text-xs text-ink-400">Total : <span className="font-medium text-ink-700">{fmtNum(total)}</span></p>
        </div>
      )}
    </div>
  );
}

/** Graphe de coût estimé/jour (marketing + utility), filtrable par campagne OU template. */
function CostChartCard({
  tenantId, range, campaigns, templates,
}: { tenantId: string; range: StatsRange; campaigns: CampaignSummary[]; templates: TemplateStats['breakdown'] }) {
  const [campaignId, setCampaignId] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [cost, setCost] = useState<CostSeries | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const filter: { campaignId?: string; templateName?: string } = {
      ...(campaignId ? { campaignId } : {}),
      ...(templateName ? { templateName } : {}),
    };
    getCostSeries(tenantId, range, filter)
      .then((c) => { if (alive) setCost(c); })
      .catch(() => { if (alive) setCost(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tenantId, range, campaignId, templateName]);

  const selectCls = 'rounded-lg border border-ink-300 bg-white px-2.5 py-1 text-xs text-ink-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

  return (
    <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold tracking-tight text-ink-900">Coût estimé</h3>
          <p className="text-xs text-ink-400">
            par jour, tarif Meta × volume{cost ? <> · total ≈ <span className="font-medium text-ink-700">{fmtCost(cost.total)}</span></> : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <select value={campaignId} onChange={(e) => { setCampaignId(e.target.value); setTemplateName(''); }} className={selectCls}>
            <option value="">Toutes campagnes</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={templateName} onChange={(e) => { setTemplateName(e.target.value); setCampaignId(''); }} className={selectCls}>
            <option value="">Tous templates</option>
            {templates.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
          </select>
        </div>
      </div>
      {loading ? (
        <p className="text-sm text-ink-500">Chargement…</p>
      ) : !cost || !cost.hasRates ? (
        <p className="text-sm text-ink-500">Tarif Meta indisponible : coût non estimable pour l&apos;instant.</p>
      ) : (
        <DailyChart
          title=""
          from={range.from}
          to={range.to}
          series={[
            { label: 'Marketing', color: '#0080D6', points: cost.marketing },
            { label: 'Utility', color: '#17C74E', points: cost.utility },
          ]}
        />
      )}
    </div>
  );
}

/** Section « Templates envoyés » détaillée : dropdown par template + volume + prix estimé (Meta). */
function TemplateBreakdownCard({ data }: { data: TemplateStats | null }) {
  const rows = data?.breakdown ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const current = rows.find((r) => r.name === selected) ?? rows[0] ?? null;
  const pricing = data?.pricing ?? null;

  const rate = current && current.category ? pricing?.byCategory[current.category]?.ratePerMessage ?? null : null;
  const estimated = current && rate != null ? current.count * rate : null;

  return (
    <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold tracking-tight text-ink-900">Détail par template</h3>
          <p className="text-xs text-ink-400">volume + prix estimé sur la période</p>
        </div>
        {rows.length > 0 && (
          <select
            value={current?.name ?? ''}
            onChange={(e) => setSelected(e.target.value)}
            className="rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-sm text-ink-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          >
            {rows.map((r) => (
              <option key={r.name} value={r.name}>
                {r.name} ({r.count})
              </option>
            ))}
          </select>
        )}
      </div>

      {!current ? (
        <p className="text-sm text-ink-500">Aucun template envoyé sur la période.</p>
      ) : (
        <div className="flex flex-wrap gap-6">
          <Metric label="Catégorie" value={current.category ?? '—'} />
          <Metric label="Envois" value={String(current.count)} />
          <Metric
            label="Prix estimé"
            value={estimated != null ? `≈ ${fmtCost(estimated)}` : 'indisponible'}
            hint={estimated != null ? 'volume × tarif catégorie (Meta), devise du compte' : 'tarif Meta indisponible'}
          />
        </div>
      )}

      {pricing && (
        <p className="mt-4 border-t border-ink-100 pt-3 text-xs text-ink-500">
          Coût total période (Meta, approx., devise du compte) : <span className="font-semibold text-ink-800">{fmtCost(pricing.totalCost)}</span>
        </p>
      )}
      {data && !pricing && (
        <p className="mt-4 border-t border-ink-100 pt-3 text-xs text-ink-400">Prix Meta indisponible pour l’instant : volumes affichés seuls.</p>
      )}
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div className="text-xl font-bold tracking-tight text-ink-900">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-400">{hint}</div>}
    </div>
  );
}
