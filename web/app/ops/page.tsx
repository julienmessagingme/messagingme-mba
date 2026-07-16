'use client';

import { useCallback, useEffect, useState } from 'react';
import { DailyChart } from '@/components/DailyChart';
import { getOpsOverview, type OpsOverview, type TenantOverviewRow, type QueueLoadRow } from '@/lib/api';
import { fmtNum } from '@/lib/format';
import { useT } from '@/lib/i18n';

const KEY = 'mba.ops';

export default function OpsPage() {
  const t = useT();
  const [token, setToken] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [data, setData] = useState<OpsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const tok = localStorage.getItem(KEY);
    if (tok) setToken(tok);
  }, []);

  const load = useCallback(async (tok: string) => {
    setLoading(true);
    setError(null);
    try {
      setData(await getOpsOverview(tok));
    } catch (e) {
      setData(null);
      const msg = e instanceof Error ? e.message : t('Erreur', 'Error');
      setError(msg);
      if (/401|autoris/i.test(msg)) { localStorage.removeItem(KEY); setToken(null); }
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (token) void load(token);
  }, [token, load]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const tok = input.trim();
    if (!tok) return;
    localStorage.setItem(KEY, tok);
    setToken(tok);
  }
  function logout() {
    localStorage.removeItem(KEY);
    setToken(null);
    setData(null);
    setInput('');
  }

  if (!token) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#F7F8FB] p-4">
        <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold tracking-tight text-ink-900">{t("Console d'exploitation", 'Operations console')}</h1>
          <p className="mt-1 text-sm text-ink-500">{t("Accès cross-tenant en lecture seule. Saisis le jeton d'exploitation.", 'Read-only cross-tenant access. Enter the operations token.')}</p>
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="OPS token"
            className="mt-4 w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
          <button type="submit" className="mt-4 w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600">
            {t('Accéder', 'Access')}
          </button>
        </form>
      </main>
    );
  }

  const totalMessages = data?.tenants.reduce((a, tn) => a + tn.messages, 0) ?? 0;
  const totalContacts = data?.tenants.reduce((a, tn) => a + tn.contacts, 0) ?? 0;
  const dailyFrom = data?.daily[0]?.date;
  const dailyTo = data?.daily[data.daily.length - 1]?.date;

  return (
    <main className="min-h-screen bg-[#F7F8FB] px-4 py-8 sm:px-6">
      <div className="mx-auto w-full max-w-7xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-ink-900">{t("Console d'exploitation", 'Operations console')}</h1>
            <p className="text-sm text-ink-500">{t('Vue cross-tenant, lecture seule.', 'Cross-tenant view, read-only.')}</p>
          </div>
          <button onClick={logout} className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-600 hover:bg-ink-100">{t('Quitter', 'Exit')}</button>
        </div>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {loading && !data ? (
          <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
        ) : data ? (
          <>
            <div className="grid grid-cols-3 gap-4">
              <Stat label={t('Clients', 'Clients')} value={fmtNum(data.tenants.length)} />
              <Stat label={t('Messages', 'Messages')} value={fmtNum(totalMessages)} />
              <Stat label={t('Contacts', 'Contacts')} value={fmtNum(totalContacts)} />
            </div>

            <QueueCard queues={data.queues} />

            {dailyFrom && dailyTo && data.daily.length > 0 && (
              <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
                <DailyChart
                  title={t('Messages échangés (tous clients)', 'Messages exchanged (all clients)')}
                  subtitle={t('par jour, 14 derniers jours', 'per day, last 14 days')}
                  from={dailyFrom}
                  to={dailyTo}
                  series={[{ label: t('Messages', 'Messages'), color: '#009AFE', points: data.daily }]}
                />
              </div>
            )}

            <TenantTable tenants={data.tenants} />
          </>
        ) : null}
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div className="mt-1 text-2xl font-bold tracking-tight text-ink-900">{value}</div>
    </div>
  );
}

/** Charge des files pg-boss : signal de bascule VPS -> Railway (backlog qui monte = saturation). */
function QueueCard({ queues }: { queues: QueueLoadRow[] }) {
  const t = useT();
  return (
    <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-sm font-semibold tracking-tight text-ink-900">{t('Files de traitement (pg-boss)', 'Processing queues (pg-boss)')}</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {queues.map((q) => (
          <div key={q.queue} className="flex items-center justify-between rounded-lg bg-ink-50 px-3 py-2">
            <span className="font-mono text-xs text-ink-700">{q.queue}</span>
            <span className="flex gap-3 text-xs tabular-nums">
              <span title={t('en attente', 'pending')} className="text-ink-600">{fmtNum(q.backlog)} {t('en file', 'queued')}</span>
              <span title={t('actifs', 'active')} className="text-brand-600">{fmtNum(q.active)} {t('actifs', 'active')}</span>
              <span title={t('échoués', 'failed')} className={q.failed > 0 ? 'font-medium text-coral' : 'text-ink-400'}>{fmtNum(q.failed)} {t('échoués', 'failed')}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TenantTable({ tenants }: { tenants: TenantOverviewRow[] }) {
  const t = useT();
  const dot = (q: string | null) => (q === 'GREEN' ? '#17C74E' : q === 'YELLOW' ? '#E8A400' : q === 'RED' ? '#FF4D4F' : '#B8BEC9');
  const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—');
  return (
    <div className="overflow-x-auto rounded-2xl border border-ink-200 bg-white shadow-sm">
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
            <th className="px-4 py-3 font-medium">{t('Client', 'Client')}</th>
            <th className="px-3 py-3 font-medium">MBA</th>
            <th className="px-3 py-3 font-medium">{t('Numéro', 'Number')}</th>
            <th className="px-3 py-3 text-right font-medium">{t('Users', 'Users')}</th>
            <th className="px-3 py-3 text-right font-medium">{t('Contacts', 'Contacts')}</th>
            <th className="px-3 py-3 text-right font-medium">{t('Messages', 'Messages')}</th>
            <th className="px-3 py-3 text-right font-medium">{t('Templates', 'Templates')}</th>
            <th className="px-3 py-3 font-medium">{t('Dernier envoi', 'Last send')}</th>
          </tr>
        </thead>
        <tbody>
          {tenants.map((tn) => (
            <tr key={tn.id} className="border-b border-ink-50 last:border-0">
              <td className="px-4 py-2.5">
                <div className="font-medium text-ink-900">{tn.name}</div>
                <div className="text-[11px] text-ink-400">{t('créé le', 'created on')} {fmtDate(tn.createdAt)}</div>
              </td>
              <td className="px-3 py-2.5">
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tn.mbaEnabled ? 'bg-mint-50 text-mint-700' : 'bg-ink-100 text-ink-500'}`}>
                  {tn.mbaEnabled ? t('actif', 'active') : t('inactif', 'inactive')}
                </span>
              </td>
              <td className="px-3 py-2.5">
                {tn.phone ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: dot(tn.quality) }} title={`${t('qualité', 'quality')} ${tn.quality ?? t('inconnue', 'unknown')}`} />
                    <span className="font-mono text-xs text-ink-700">{tn.phone}</span>
                  </span>
                ) : (
                  <span className="text-xs text-ink-400">—</span>
                )}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{fmtNum(tn.users)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{fmtNum(tn.contacts)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{fmtNum(tn.messages)}</td>
              <td className="px-3 py-2.5 text-right tabular-nums text-ink-700">{fmtNum(tn.templatesUsed)}</td>
              <td className="px-3 py-2.5 text-xs text-ink-500">{fmtDate(tn.lastSendAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
