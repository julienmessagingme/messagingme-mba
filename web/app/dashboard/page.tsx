'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { DailyChart } from '@/components/DailyChart';
import { Logo } from '@/components/Logo';
import type { Session } from '@/lib/session';
import { getStats, getSettings, putSettings, getTemplateStats, getDeliveryFunnel, type DashboardStats, type TemplateStats, type DeliveryFunnel, type StatsRange } from '@/lib/api';
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
  const [funnel, setFunnel] = useState<DeliveryFunnel | null>(null);
  const [mbaEnabled, setMbaEnabled] = useState(false);
  const [savingMba, setSavingMba] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = session.role === 'admin';
  const today = todayParis();
  const activePreset = range.to === today ? PRESETS.find((d) => range.from === addDays(today, -(d - 1))) ?? null : null;

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, cfg, ts, fn] = await Promise.all([
        getStats(session.tenantId, range),
        getSettings(session.tenantId),
        getTemplateStats(session.tenantId, range),
        getDeliveryFunnel(session.tenantId, range),
      ]);
      setStats(s);
      setMbaEnabled(cfg.mbaEnabled);
      setTemplateStats(ts);
      setFunnel(fn);
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

  async function toggleMba() {
    if (!isAdmin) return;
    const next = !mbaEnabled;
    setSavingMba(true);
    setMbaEnabled(next); // optimiste
    try {
      await putSettings(session.tenantId, next);
    } catch {
      setMbaEnabled(!next); // rollback
    } finally {
      setSavingMba(false);
    }
  }

  const inputCls = 'rounded-md border border-ink-300 bg-white px-2 py-1 text-xs text-ink-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

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

      {/* Carte MBA */}
      <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-ink-200 bg-gradient-to-br from-white to-navy-50 p-5 shadow-sm">
        <Logo className="h-11 w-11 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold tracking-tight text-ink-900">Meta Business Agent</div>
          <p className="text-xs text-ink-500">
            {mbaEnabled ? "Activé : l'agent IA répondra quand Meta ouvrira la fonctionnalité sur ton numéro." : "Désactivé. Active-le pour préparer l'agent IA WhatsApp."}
            <span className="ml-1 text-ink-400">En attente d'ouverture Meta (mur ToS Business AI).</span>
          </p>
        </div>
        <button
          onClick={toggleMba}
          disabled={!isAdmin || savingMba}
          title={isAdmin ? '' : 'Réservé aux admins'}
          className={`relative h-7 w-12 shrink-0 rounded-full transition ${mbaEnabled ? 'bg-brand-500' : 'bg-ink-300'} ${!isAdmin ? 'cursor-not-allowed opacity-60' : ''}`}
        >
          <span className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-all ${mbaEnabled ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
      </div>

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
            <FunnelCard funnel={funnel} />
          </div>
          <div className="lg:col-span-2">
            <TemplateBreakdownCard data={templateStats} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Funnel de livraison des campagnes : envoyés -> délivrés -> lus (accusés de lecture). */
function FunnelCard({ funnel }: { funnel: DeliveryFunnel | null }) {
  if (!funnel) return null;
  const { sent, delivered, read, failed } = funnel;
  const pct = (n: number) => (sent > 0 ? Math.max(2, Math.round((n / sent) * 100)) : 0);
  const bars: Array<{ label: string; value: number; color: string; sub?: string }> = [
    { label: 'Envoyés', value: sent, color: '#009AFE' },
    { label: 'Délivrés', value: delivered, color: '#17C74E', sub: fmtPct(delivered, sent) },
    { label: 'Lus (accusés de lecture)', value: read, color: '#6E5AE0', sub: fmtPct(read, sent) },
  ];
  return (
    <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <div className="mb-3">
        <h3 className="text-sm font-semibold tracking-tight text-ink-900">Livraison &amp; lecture</h3>
        <p className="text-xs text-ink-400">campagnes sur la période · « lus » = accusés de lecture (sous-estimé si le destinataire les a désactivés)</p>
      </div>
      {sent === 0 ? (
        <p className="text-sm text-ink-500">Aucun envoi de campagne sur la période.</p>
      ) : (
        <div className="space-y-2.5">
          {bars.map((b) => (
            <div key={b.label} className="flex items-center gap-3">
              <div className="w-40 shrink-0 text-xs text-ink-600">{b.label}</div>
              <div className="h-6 flex-1 overflow-hidden rounded-md bg-ink-50">
                <div className="flex h-full items-center rounded-md px-2 text-[11px] font-medium text-white" style={{ width: `${pct(b.value)}%`, backgroundColor: b.color }}>
                  {fmtNum(b.value)}
                </div>
              </div>
              <div className="w-12 shrink-0 text-right text-xs tabular-nums text-ink-500">{b.sub ?? ''}</div>
            </div>
          ))}
          {failed > 0 && (
            <p className="pt-1 text-xs text-ink-400">Échecs de livraison sur la période : <span className="font-medium text-coral">{fmtNum(failed)}</span></p>
          )}
        </div>
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
