'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { DailyChart } from '@/components/DailyChart';
import { Logo } from '@/components/Logo';
import type { Session } from '@/lib/session';
import { getStats, getSettings, putSettings, type DashboardStats } from '@/lib/api';

export default function DashboardPage() {
  return <AppShell active="dashboard">{(session) => <DashboardInner session={session} />}</AppShell>;
}

function DashboardInner({ session }: { session: Session }) {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [mbaEnabled, setMbaEnabled] = useState(false);
  const [savingMba, setSavingMba] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = session.role === 'admin';

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, cfg] = await Promise.all([getStats(session.tenantId, days), getSettings(session.tenantId)]);
      setStats(s);
      setMbaEnabled(cfg.mbaEnabled);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, days]);

  useEffect(() => {
    void load();
  }, [load]);

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold tracking-tight text-ink-900">Tableau de bord</h2>
        <div className="inline-flex gap-1 rounded-lg bg-ink-100 p-1 text-xs">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded-md px-2.5 py-1 ${days === d ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
            >
              {d} j
            </button>
          ))}
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
            subtitle="nouveaux contacts par jour"
            days={days}
            series={[{ label: 'Contacts', color: '#009AFE', points: stats.contacts }]}
          />
          <DailyChart
            title="Messages échangés"
            subtitle="reçus + réponses (hors template)"
            days={days}
            series={[{ label: 'Échangés', color: '#6E5AE0', points: stats.exchanged }]}
          />
          <div className="lg:col-span-2">
            <DailyChart
              title="Templates envoyés"
              subtitle="par jour, marketing vs utility"
              days={days}
              series={[
                { label: 'Marketing', color: '#0080D6', points: stats.templates.marketing },
                { label: 'Utility', color: '#17C74E', points: stats.templates.utility },
              ]}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
