'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  getConversationAnalysisSummary,
  listAnalyzedConversations,
  type ConversationAnalysisSummary,
  type AnalyzedConversation,
  type StatsRange,
} from '@/lib/api';
import { fmtNum, fmtPct } from '@/lib/format';
import { formatDate, hourMin } from '@/lib/day';
import { useT, useLocale } from '@/lib/i18n';
import type { Locale } from '@/lib/locale';

/** Traducteur au point d'appel (cf. i18n.tsx). Réutilisé par les helpers de libellé. */
type Tr = (fr: string, en?: string) => string;

const CARD = 'rounded-2xl border border-ink-200 bg-white p-5 shadow-sm';
const SELECT =
  'rounded-lg border border-ink-300 bg-white px-2.5 py-1 text-xs text-ink-800 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';
const SECTION_LABEL = 'mb-2 text-xs font-medium uppercase tracking-wide text-ink-400';

// Clés d'énumération LLM (filtres + mapping libellé). Les VALEURS backend passent telles quelles si inconnues.
const SENTIMENTS = ['positif', 'neutre', 'negatif'] as const;
const INTENTS = ['demande_devis', 'sav', 'reclamation', 'information', 'prise_rdv', 'autre'] as const;
const ACTIONS = ['creer_devis', 'rappeler', 'relancer', 'escalader', 'aucune'] as const;

/** Libellé localisé d'un sentiment (repli : valeur brute si clé inconnue). */
function sentimentLabel(s: string, t: Tr): string {
  switch (s) {
    case 'positif': return t('Positif', 'Positive');
    case 'neutre': return t('Neutre', 'Neutral');
    case 'negatif': return t('Négatif', 'Negative');
    default: return s;
  }
}
function intentLabel(i: string, t: Tr): string {
  switch (i) {
    case 'demande_devis': return t('Demande de devis', 'Quote request');
    case 'sav': return t('SAV', 'After-sales');
    case 'reclamation': return t('Réclamation', 'Complaint');
    case 'information': return t('Information', 'Information');
    case 'prise_rdv': return t('Prise de RDV', 'Appointment');
    case 'autre': return t('Autre', 'Other');
    default: return i;
  }
}
function actionLabel(a: string, t: Tr): string {
  switch (a) {
    case 'creer_devis': return t('Créer un devis', 'Create a quote');
    case 'rappeler': return t('Rappeler', 'Call back');
    case 'relancer': return t('Relancer', 'Follow up');
    case 'escalader': return t('Escalader', 'Escalate');
    case 'aucune': return t('Aucune', 'None');
    default: return a;
  }
}

/** Classe de badge selon le sentiment (3 couleurs). */
function sentimentBadge(s: string): string {
  if (s === 'positif') return 'bg-mint-50 text-mint-700';
  if (s === 'negatif') return 'bg-red-50 text-red-700';
  return 'bg-ink-100 text-ink-500';
}

/** Compteur (même style que Metric du dashboard, gardé local pour ne pas le redéclarer globalement). */
function Counter({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div className="text-xl font-bold tracking-tight text-ink-900">{value}</div>
    </div>
  );
}

/** Barre horizontale (patron des barres inline de CampaignFunnelCard) : label + piste + valeur à droite. */
function Bar({ label, pct, value, cls }: { label: string; pct: number; value: string; cls: string }) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-32 shrink-0 truncate text-xs text-ink-600" title={label}>{label}</div>
      <div className="h-6 flex-1 overflow-hidden rounded-md bg-ink-50">
        <div className={`h-full rounded-md ${cls}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="w-10 shrink-0 text-right text-xs tabular-nums text-ink-500">{value}</div>
    </div>
  );
}

/** Donut sentiment en SVG pur (pathLength=100, arcs par stroke-dasharray). Positif=mint, neutre=gris, négatif=coral. */
function SentimentDonut({ summary, locale, t }: { summary: ConversationAnalysisSummary; locale: Locale; t: Tr }) {
  const { positif, neutre, negatif } = summary.sentiment;
  const total = positif + neutre + negatif;
  const segs = [
    { key: 'positif', label: sentimentLabel('positif', t), value: positif, color: '#17C74E' },
    { key: 'neutre', label: sentimentLabel('neutre', t), value: neutre, color: '#9AA3AF' },
    { key: 'negatif', label: sentimentLabel('negatif', t), value: negatif, color: '#E4604A' },
  ];
  let acc = 0; // offset cumulé (en % de circonférence) pour enchaîner les arcs
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 36 36" className="h-28 w-28 shrink-0 -rotate-90" aria-hidden="true">
        <circle cx="18" cy="18" r="15.915" fill="none" stroke="#F4F5F9" strokeWidth="4" />
        {total > 0 && segs.map((s) => {
          if (s.value <= 0) return null;
          const pct = (s.value / total) * 100;
          const offset = -acc;
          acc += pct;
          return (
            <circle
              key={s.key}
              cx="18" cy="18" r="15.915"
              fill="none" stroke={s.color} strokeWidth="4"
              pathLength={100}
              strokeDasharray={`${pct} ${100 - pct}`}
              strokeDashoffset={offset}
            />
          );
        })}
      </svg>
      <div className="space-y-1 text-xs">
        {segs.map((s) => (
          <div key={s.key} className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
            <span className="text-ink-600">{s.label}</span>
            <span className="font-medium tabular-nums text-ink-800">{fmtNum(s.value, locale)}</span>
            <span className="tabular-nums text-ink-400">{fmtPct(s.value, total, locale)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Bloc quanti : compteurs, donut sentiment, barres intention/action, split humain vs automatisé, top topics. */
function QuantiBlock({ summary }: { summary: ConversationAnalysisSummary }) {
  const t = useT();
  const { locale } = useLocale();

  const resolvedDen = summary.resolution.resolved + summary.resolution.unresolved;
  const avg = summary.exchanges.avg;

  // Intentions triées par volume décroissant (demande_devis remonte = signal commercial).
  const intents = INTENTS.map((k) => ({ key: k, label: intentLabel(k, t), value: summary.intent[k] }))
    .sort((a, b) => b.value - a.value);
  const intentMax = Math.max(1, ...intents.map((i) => i.value));

  // Actions dans l'ordre du pipeline (pas de tri) : créer devis -> rappeler -> relancer -> escalader -> aucune.
  const actions = ACTIONS.map((k) => ({ key: k, label: actionLabel(k, t), value: summary.actions[k] }));
  const actionMax = Math.max(1, ...actions.map((a) => a.value));

  const hb = summary.handledBy;
  const hbTotal = hb.humain + hb.automatise + hb.mba;
  const hbW = (n: number) => (hbTotal > 0 ? (n / hbTotal) * 100 : 0);

  const topics = summary.topTopics.slice(0, 8);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-x-8 gap-y-3">
        <Counter label={t('Conversations analysées', 'Conversations analyzed')} value={fmtNum(summary.total, locale)} />
        <Counter label={t('Taux de résolution', 'Resolution rate')} value={fmtPct(summary.resolution.resolved, resolvedDen, locale)} />
        <Counter label={t('Échanges / conv en moyenne', 'Exchanges / conv on average')} value={avg != null ? avg.toFixed(1) : '-'} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <div className={SECTION_LABEL}>{t('Sentiment', 'Sentiment')}</div>
          <SentimentDonut summary={summary} locale={locale} t={t} />
        </div>
        <div>
          <div className={SECTION_LABEL}>{t('Par intention', 'By intent')}</div>
          <div className="space-y-2">
            {intents.map((i) => (
              <Bar key={i.key} label={i.label} pct={Math.round((i.value / intentMax) * 100)} value={fmtNum(i.value, locale)} cls="bg-brand-500" />
            ))}
          </div>
        </div>
      </div>

      <div>
        <div className={SECTION_LABEL}>{t('Action suggérée (pipeline)', 'Suggested action (pipeline)')}</div>
        <div className="space-y-2">
          {actions.map((a) => (
            <Bar key={a.key} label={a.label} pct={Math.round((a.value / actionMax) * 100)} value={fmtNum(a.value, locale)} cls="bg-violet" />
          ))}
        </div>
      </div>

      <div>
        <div className={SECTION_LABEL}>{t('Qui a géré', 'Handled by')}</div>
        <div className="flex h-6 overflow-hidden rounded-md bg-ink-50">
          {hb.humain > 0 && <div className="bg-brand-500" style={{ width: `${hbW(hb.humain)}%` }} title={t('Humain', 'Human')} />}
          {hb.automatise > 0 && <div className="bg-mint-400" style={{ width: `${hbW(hb.automatise)}%` }} title={t('Automatisé', 'Automated')} />}
          {hb.mba > 0 && <div className="bg-violet" style={{ width: `${hbW(hb.mba)}%` }} title="MBA" />}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-brand-500" /><span className="text-ink-600">{t('Humain', 'Human')}</span><span className="font-medium tabular-nums text-ink-800">{fmtNum(hb.humain, locale)}</span></span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-mint-400" /><span className="text-ink-600">{t('Automatisé', 'Automated')}</span><span className="font-medium tabular-nums text-ink-800">{fmtNum(hb.automatise, locale)}</span></span>
          {hb.mba > 0 && <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-violet" /><span className="text-ink-600">MBA</span><span className="font-medium tabular-nums text-ink-800">{fmtNum(hb.mba, locale)}</span></span>}
        </div>
      </div>

      {topics.length > 0 && (
        <div>
          <div className={SECTION_LABEL}>{t('Sujets fréquents', 'Frequent topics')}</div>
          <div className="flex flex-wrap gap-2">
            {topics.map((tp) => (
              <span key={tp.topic} className="inline-flex items-center gap-1.5 rounded-full bg-ink-50 px-2.5 py-1 text-xs">
                <span className="text-ink-700">{tp.topic}</span>
                <span className="tabular-nums text-ink-400">{fmtNum(tp.count, locale)}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Table quali (fetch séparé, filtrable) : 50 conversations analysées, ligne cliquable vers l'inbox. */
function QualiTable({ tenantId, range }: { tenantId: string; range: StatsRange }) {
  const t = useT();
  const { locale } = useLocale();
  const router = useRouter();
  const [sentiment, setSentiment] = useState('');
  const [intent, setIntent] = useState('');
  const [action, setAction] = useState('');
  const [rows, setRows] = useState<AnalyzedConversation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    listAnalyzedConversations(tenantId, range, {
      ...(sentiment ? { sentiment } : {}),
      ...(intent ? { intent } : {}),
      ...(action ? { action } : {}),
      limit: 50,
    })
      .then((r) => { if (alive) setRows(r.conversations); })
      .catch(() => { if (alive) setRows([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tenantId, range.from, range.to, sentiment, intent, action]);

  const th = 'px-2 py-2 font-medium whitespace-nowrap';
  const td = 'px-2 py-2 align-top';

  return (
    <div className="mt-6 border-t border-ink-100 pt-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="mr-auto text-xs font-medium uppercase tracking-wide text-ink-400">{t('Détail des conversations', 'Conversation details')}</div>
        <select value={sentiment} onChange={(e) => setSentiment(e.target.value)} className={SELECT}>
          <option value="">{t('Sentiment : tous', 'Sentiment: all')}</option>
          {SENTIMENTS.map((s) => <option key={s} value={s}>{sentimentLabel(s, t)}</option>)}
        </select>
        <select value={intent} onChange={(e) => setIntent(e.target.value)} className={SELECT}>
          <option value="">{t('Intention : toutes', 'Intent: all')}</option>
          {INTENTS.map((i) => <option key={i} value={i}>{intentLabel(i, t)}</option>)}
        </select>
        <select value={action} onChange={(e) => setAction(e.target.value)} className={SELECT}>
          <option value="">{t('Action : toutes', 'Action: all')}</option>
          {ACTIONS.map((a) => <option key={a} value={a}>{actionLabel(a, t)}</option>)}
        </select>
      </div>

      {loading ? (
        <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-500">{t('Aucune conversation ne correspond.', 'No conversation matches.')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead>
              <tr className="border-b border-ink-100 text-ink-400">
                <th className={th}>{t('Date', 'Date')}</th>
                <th className={th}>{t('Contact', 'Contact')}</th>
                <th className={th}>{t('Sentiment', 'Sentiment')}</th>
                <th className={th}>{t('Intention', 'Intent')}</th>
                <th className={th}>{t('Sujet', 'Topic')}</th>
                <th className={th}>{t('Résolu', 'Resolved')}</th>
                <th className={th}>{t('Action', 'Action')}</th>
                <th className={th}>{t('Confiance', 'Confidence')}</th>
                <th className={th}>{t('Justification', 'Justification')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const conf = Math.round(r.confidence * 100);
                return (
                  <tr
                    key={r.conversationId}
                    onClick={() => router.push(r.inboxHref)}
                    className="cursor-pointer border-b border-ink-50 hover:bg-ink-50"
                  >
                    <td className={`${td} whitespace-nowrap text-ink-500`}>
                      {formatDate(r.analyzedAt, locale, { day: '2-digit', month: '2-digit', year: '2-digit' })} {hourMin(r.analyzedAt, locale)}
                    </td>
                    <td className={`${td} font-medium text-ink-800`}>{r.profileName ?? r.waId}</td>
                    <td className={td}>
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${sentimentBadge(r.sentiment)}`}>
                        {sentimentLabel(r.sentiment, t)}
                      </span>
                    </td>
                    <td className={`${td} text-ink-600`}>{intentLabel(r.intent, t)}</td>
                    <td className={`${td} text-ink-600`}>{r.topic}</td>
                    <td className={td}>{r.resolved ? <span className="text-mint-600">✓</span> : <span className="text-ink-400">✗</span>}</td>
                    <td className={`${td} text-ink-600`}>{actionLabel(r.actionSuggestion, t)}</td>
                    <td className={`${td} tabular-nums ${conf < 50 ? 'text-ink-400' : 'text-ink-700'}`}>{conf}%</td>
                    <td className={`${td} max-w-[16rem] truncate text-ink-500`} title={r.justification}>{r.justification}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Carte « Conversations (analyse) » : agrégats quanti + table quali. Champs LLM = indicatifs. */
export function ConversationAnalysisCard({ tenantId, range }: { tenantId: string; range: StatsRange }) {
  const t = useT();
  const [summary, setSummary] = useState<ConversationAnalysisSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getConversationAnalysisSummary(tenantId, range)
      .then((s) => { if (alive) setSummary(s); })
      .catch(() => { if (alive) setSummary(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tenantId, range.from, range.to]);

  return (
    <div className={CARD}>
      <div className="mb-3">
        <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Conversations (analyse)', 'Conversations (analysis)')}</h3>
        <p className="text-xs text-ink-400">{t('Analyse IA, indicative', 'AI analysis, indicative')}</p>
      </div>

      {loading ? (
        <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
      ) : !summary || summary.total === 0 ? (
        <p className="text-sm text-ink-500">
          {summary && summary.enabled === false
            ? t("L'analyse de conversation n'est pas activée.", 'Conversation analysis is not enabled.')
            : t('Aucune conversation analysée sur cette période.', 'No conversation analyzed over this period.')}
        </p>
      ) : (
        <>
          <QuantiBlock summary={summary} />
          <QualiTable tenantId={tenantId} range={range} />
        </>
      )}
    </div>
  );
}
