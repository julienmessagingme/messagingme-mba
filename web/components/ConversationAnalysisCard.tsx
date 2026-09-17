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
import { Modale } from './Modale';
import { TableJoursAnalyse } from './TableJoursAnalyse';
import { repondeursDe, libelleRepondeur } from '@/lib/qui-a-repondu';
import type { LignePeriode } from '@/lib/jours-analyse';
import { BoutonPdf } from './BoutonPdf';
import { phraseResumeAbsent } from '@/lib/resume-conversation';
import { toCsv, downloadCsv } from '@/lib/csv';
import { entetesQuali, ligneQuali } from '@/lib/quali-export';

/**
 * Plafond de lignes ramenées quand on ouvre une liste pour l'exporter.
 *
 * Le tableau de détail en montre 50, ce qui suffit à se faire une idée. Un export, lui, doit couvrir la
 * période : sortir 50 lignes d'une période qui en compte 400 produirait un fichier faux SANS le dire, et
 * c'est précisément ce qu'on ne veut pas d'un export. 1000 est le plafond que la route accepte ; au-delà,
 * l'écran prévient plutôt que de tronquer en silence.
 */
const PLAFOND_EXPORT = 1000;

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

/**
 * Barre horizontale : label + piste + valeur à droite.
 *
 * ⚠️ Ce commentaire disait « patron des barres inline de CampaignFunnelCard ». Ce n'est plus vrai depuis le
 * 2026-09-07 : le funnel est passé en barres VERTICALES à la demande de Julien, et n'a donc plus de barre
 * horizontale à servir de modèle. La référence est retirée plutôt que corrigée vers un autre fichier : ce
 * composant se suffit, et un pointeur vers un patron qui bouge est un pointeur qui redeviendra faux.
 *
 * `onClick` la rend CLIQUABLE : c'est ce qui ouvre la liste des conversations derrière un chiffre. Une barre
 * dont le compte vaut zéro n'est jamais cliquable, même si `onClick` est fourni : ouvrir une fenêtre vide
 * ferait croire à une panne. Le curseur et le soulignement disent que le chiffre mène quelque part, sinon
 * personne ne pense à cliquer un nombre.
 */
function Bar({ label, pct, value, cls, onClick, titre }: { label: string; pct: number; value: string; cls: string; onClick?: () => void; titre?: string }) {
  const corps = (
    <>
      <div className="w-32 shrink-0 truncate text-xs text-ink-600" title={label}>{label}</div>
      <div className="h-6 flex-1 overflow-hidden rounded-md bg-ink-50">
        <div className={`h-full rounded-md ${cls}`} style={{ width: `${pct}%` }} />
      </div>
      <div className={`w-10 shrink-0 text-right text-xs tabular-nums ${onClick ? 'font-medium text-brand-600 underline decoration-dotted underline-offset-2' : 'text-ink-500'}`}>{value}</div>
    </>
  );
  if (!onClick) return <div className="flex items-center gap-3">{corps}</div>;
  return (
    <button type="button" onClick={onClick} title={titre} className="flex w-full items-center gap-3 rounded-md text-left transition hover:bg-ink-50">
      {corps}
    </button>
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
function QuantiBlock({ summary, sujet, onSujet, onAction }: {
  summary: ConversationAnalysisSummary;
  /** Sujet actuellement retenu (partagé avec la table du dessous), `null` = aucun. */
  sujet: string | null;
  onSujet: (sujet: string | null) => void;
  onAction: (action: string) => void;
}) {
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
        {/* Le chiffre d'une action OUVRE la liste des conversations concernées. C'était la demande de
            Julien : le tableau disait « 12 devis à créer » sans dire lesquels, donc le chiffre ne menait à
            aucun geste. Une action à zéro n'ouvre rien : une fenêtre vide se lit comme une panne. */}
        <div className="space-y-2" data-testid="quali-actions">
          {actions.map((a) => (
            <Bar
              key={a.key}
              label={a.label}
              pct={Math.round((a.value / actionMax) * 100)}
              value={fmtNum(a.value, locale)}
              cls="bg-violet"
              titre={t('Voir les conversations concernées', 'See the matching conversations')}
              {...(a.value > 0 ? { onClick: () => onAction(a.key) } : {})}
            />
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
          {/* Chaque sujet est une BASCULE sur la table de détail : cliquer restreint, recliquer le même
              relâche. Une bascule et non une sélection multiple, parce qu'une conversation n'a qu'UN sujet :
              en retenir deux ne pourrait rien ramener, et l'écran promettrait un filtre qui ne marche pas. */}
          <div className="flex flex-wrap gap-2">
            {topics.map((tp) => {
              const retenu = sujet === tp.topic;
              return (
                <button
                  key={tp.topic}
                  type="button"
                  data-testid={`quali-sujet-${tp.topic}`}
                  aria-pressed={retenu}
                  onClick={() => onSujet(retenu ? null : tp.topic)}
                  title={retenu ? t('Retirer ce filtre', 'Remove this filter') : t('Ne garder que ce sujet', 'Keep only this topic')}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition ${
                    retenu ? 'bg-brand-500 text-white' : 'bg-ink-50 hover:bg-ink-100'
                  }`}
                >
                  <span className={retenu ? '' : 'text-ink-700'}>{tp.topic}</span>
                  <span className={`tabular-nums ${retenu ? 'text-white/80' : 'text-ink-400'}`}>{fmtNum(tp.count, locale)}</span>
                  {retenu && <span aria-hidden="true">×</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Bouton d'export CSV d'une liste de conversations. Le même partout : un seul jeu de colonnes (`quali-export`). */
function BoutonCsv({ rows, nom }: { rows: AnalyzedConversation[]; nom: string }) {
  const t = useT();
  const libelles = {
    sentiment: (v: string) => sentimentLabel(v, t),
    intent: (v: string) => intentLabel(v, t),
    action: (v: string) => actionLabel(v, t),
  };
  return (
    <button
      type="button"
      disabled={rows.length === 0}
      data-testid={`csv-${nom}`}
      onClick={() => downloadCsv(`${nom}.csv`, toCsv(entetesQuali(t), rows.map((c) => ligneQuali(c, t, libelles))))}
      title={t('Exporter cette liste en CSV', 'Export this list to CSV')}
      className="sans-impression shrink-0 rounded-md border border-ink-200 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-ink-400 transition hover:border-ink-300 hover:bg-ink-50 hover:text-ink-700 disabled:cursor-not-allowed disabled:opacity-40"
    >
      CSV
    </button>
  );
}

/**
 * La FICHE d'une conversation : tout ce que le tableau montre, plus le résumé, plus les infos extraites.
 *
 * Elle remplace le saut direct vers l'inbox. Julien : « au lieu de t'envoyer sur la conversation dans Inbox,
 * je veux que ça ouvre une pop-up ». La raison tient à ce que faisait l'ancien geste : le tableau ne montre
 * qu'une justification tronquée, et pour la lire en entier il fallait quitter l'analytics et perdre ses
 * filtres. Le bouton vers l'inbox reste, en bas, comme une décision et non comme un effet de bord d'un clic.
 */
function FicheConversation({ c, onClose }: { c: AnalyzedConversation; onClose: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const router = useRouter();
  const entites = Object.entries(c.entities ?? {});
  const champ = (label: string, valeur: React.ReactNode) => (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{label}</div>
      <div className="text-sm text-ink-800">{valeur}</div>
    </div>
  );
  return (
    <Modale
      titre={c.profileName ?? c.waId}
      sousTitre={`${formatDate(c.analyzedAt, locale, { day: '2-digit', month: '2-digit', year: 'numeric' })} ${hourMin(c.analyzedAt, locale)} · ${c.waId}`}
      onClose={onClose}
    >
      <div className="space-y-4" data-testid="fiche-conversation">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{t('Résumé de la conversation', 'Conversation summary')}</div>
          {/* Repli ASSUMÉ et NOMMÉ. Les analyses d'avant la migration 0100 n'ont pas de résumé, et
              afficher `justification` à la place serait un mensonge discret : elle explique le classement,
              pas ce qui s'est dit. Mieux vaut dire qu'il n'y en a pas.
              ⚠️ La PHRASE, elle, vit dans `web/lib/resume-conversation.ts` depuis que la fiche du mini-CRM
              en a besoin elle aussi : deux endroits qui affirment la même chose finissent par ne plus
              l'affirmer pareil. Le texte n'a pas changé, seulement son domicile. */}
          {c.summary && c.summary.trim() !== '' ? (
            <p className="mt-0.5 whitespace-pre-line text-sm text-ink-700" data-testid="fiche-resume">{c.summary}</p>
          ) : (
            <p className="mt-0.5 text-sm italic text-ink-400" data-testid="fiche-resume-absent">
              {phraseResumeAbsent('sans-resume', t)}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 border-t border-ink-100 pt-3 sm:grid-cols-3">
          {champ(t('Sentiment', 'Sentiment'), (
            <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${sentimentBadge(c.sentiment)}`}>{sentimentLabel(c.sentiment, t)}</span>
          ))}
          {champ(t('Intention', 'Intent'), intentLabel(c.intent, t))}
          {champ(t('Sujet', 'Topic'), c.topic)}
          {champ(t('Résolu', 'Resolved'), c.resolved ? t('Oui', 'Yes') : t('Non', 'No'))}
          {champ(t('Action suggérée', 'Suggested action'), actionLabel(c.actionSuggestion, t))}
          {champ(t('Confiance', 'Confidence'), `${Math.round(c.confidence * 100)} %`)}
          {champ(t('Qui a géré', 'Handled by'), c.handledBy === 'humain' ? t('Humain', 'Human') : c.handledBy === 'mba' ? 'MBA' : t('Automatisé', 'Automated'))}
          {champ(t('Échanges', 'Exchanges'), fmtNum(c.exchangesCount, locale))}
        </div>

        <div className="border-t border-ink-100 pt-3">
          {champ(t('Justification de l’action', 'Action rationale'), <span className="text-ink-600">{c.justification}</span>)}
        </div>

        {entites.length > 0 && (
          <div className="border-t border-ink-100 pt-3">
            <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{t('Infos relevées', 'Extracted details')}</div>
            <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
              {entites.map(([cle, valeur]) => (
                <div key={cle}>
                  <dt className="text-[11px] text-ink-400">{cle}</dt>
                  <dd className="text-ink-800">{typeof valeur === 'object' ? JSON.stringify(valeur) : String(valeur)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        <div className="sans-impression flex justify-end border-t border-ink-100 pt-3">
          <button
            type="button"
            data-testid="fiche-vers-inbox"
            onClick={() => router.push(c.inboxHref)}
            className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-600"
          >
            {t('Ouvrir la conversation dans l’inbox', 'Open the conversation in the inbox')}
          </button>
        </div>
      </div>
    </Modale>
  );
}

/**
 * La liste des conversations derrière un chiffre d'action suggérée.
 *
 * Elle charge sa propre liste plutôt que de filtrer celle du tableau : le tableau n'en tient que 50, et une
 * fenêtre qui annoncerait « 120 conversations » pour n'en montrer que 50 mentirait sur son propre titre.
 */
function ListeParAction({ tenantId, range, action, onClose }: {
  tenantId: string; range: StatsRange; action: string; onClose: () => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const router = useRouter();
  const [rows, setRows] = useState<AnalyzedConversation[] | null>(null);
  const [erreur, setErreur] = useState(false);

  useEffect(() => {
    let vivant = true;
    setRows(null);
    setErreur(false);
    listAnalyzedConversations(tenantId, range, { action, limit: PLAFOND_EXPORT })
      .then((r) => { if (vivant) setRows(r.conversations); })
      .catch(() => { if (vivant) { setRows([]); setErreur(true); } });
    return () => { vivant = false; };
  }, [tenantId, range.from, range.to, action]);

  return (
    <Modale
      titre={actionLabel(action, t)}
      sousTitre={rows === null ? t('Chargement…', 'Loading…') : t(`${rows.length} conversation(s)`, `${rows.length} conversation(s)`)}
      taille="large"
      onClose={onClose}
      actions={rows && rows.length > 0 ? (
        <>
          <BoutonCsv rows={rows} nom={`conversations-${action}`} />
          <BoutonPdf zone="quali-liste-action" />
        </>
      ) : undefined}
    >
      <div id="quali-liste-action">
        {erreur ? (
          <p className="text-sm text-red-700">{t('Liste indisponible pour le moment.', 'List unavailable right now.')}</p>
        ) : rows === null ? (
          <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-ink-500">{t('Aucune conversation ne correspond.', 'No conversation matches.')}</p>
        ) : (
          <>
            {rows.length === PLAFOND_EXPORT && (
              // Dire la troncature plutôt que la subir : un export de 1000 lignes exactement est suspect,
              // et sans cette phrase personne ne saurait qu'il en manque.
              <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {t(`Liste limitée aux ${PLAFOND_EXPORT} plus récentes. Réduis la période pour tout voir.`, `List capped at the ${PLAFOND_EXPORT} most recent. Narrow the period to see them all.`)}
              </p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-left text-xs">
                <thead>
                  <tr className="border-b border-ink-100 text-ink-400">
                    <th className="whitespace-nowrap px-2 py-2 font-medium">{t('Date', 'Date')}</th>
                    <th className="px-2 py-2 font-medium">{t('Contact', 'Contact')}</th>
                    <th className="px-2 py-2 font-medium">{t('Sujet', 'Topic')}</th>
                    <th className="px-2 py-2 font-medium">{t('Sentiment', 'Sentiment')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.conversationId}
                      data-testid="liste-action-ligne"
                      onClick={() => router.push(r.inboxHref)}
                      className="cursor-pointer border-b border-ink-50 hover:bg-ink-50"
                      title={t('Ouvrir dans l’inbox', 'Open in the inbox')}
                    >
                      <td className="whitespace-nowrap px-2 py-2 text-ink-500">
                        {formatDate(r.analyzedAt, locale, { day: '2-digit', month: '2-digit', year: '2-digit' })} {hourMin(r.analyzedAt, locale)}
                      </td>
                      <td className="px-2 py-2 font-medium text-ink-800">{r.profileName ?? r.waId}</td>
                      <td className="px-2 py-2 text-ink-600">{r.topic}</td>
                      <td className="px-2 py-2">
                        <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${sentimentBadge(r.sentiment)}`}>{sentimentLabel(r.sentiment, t)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modale>
  );
}

/** Table quali (fetch séparé, filtrable) : 50 conversations analysées, ligne cliquable vers sa fiche. */
function QualiTable({ tenantId, range, sujet, onSujet, intentionInitiale, journee }: {
  tenantId: string; range: StatsRange; sujet: string | null; onSujet: (sujet: string | null) => void;
  intentionInitiale?: string;
  /**
   * La journee (ou la semaine) choisie dans le tableau du dessus. `null` = toute la periode.
   *
   * 🔴 LE FILTRE PASSE PAR LA PLAGE, PAS PAR UN FILTRE DE PLUS. Le serveur sait deja borner par dates,
   * et lui demander la meme chose d une seconde facon ferait deux chemins pour une question, qui
   * divergeraient au premier changement. Une semaine ouvre du PREMIER au DERNIER de ses jours, pris
   * dans la ligne elle-meme : recalculer la plage ferait ouvrir des jours qu elle ne comptait pas.
   */
  journee?: LignePeriode | null;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [sentiment, setSentiment] = useState('');
  /**
   * ⚠️ L INTENTION DE L ADRESSE N EST QU UN ETAT INITIAL : elle se pose au premier rendu, puis se change
   * comme n importe quel filtre. VALIDEE contre l enumeration, sinon une adresse bricolee poserait un
   * filtre que le serveur refuserait ensuite en silence, et l ecran afficherait « aucun resultat » sans
   * que rien n explique pourquoi.
   */
  const [intent, setIntent] = useState(
    intentionInitiale && (INTENTS as readonly string[]).includes(intentionInitiale) ? intentionInitiale : '',
  );
  const [action, setAction] = useState('');
  const [rows, setRows] = useState<AnalyzedConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [fiche, setFiche] = useState<AnalyzedConversation | null>(null);

  /**
   * LA PLAGE REELLEMENT DEMANDEE : celle de la journee choisie, sinon celle de l ecran.
   *
   * ⚠️ LES JOURS VIENNENT DE LA LIGNE, pas d un calcul : une semaine de bord de periode est PARTIELLE,
   * et recalculer lundi-dimanche ouvrirait des journees que la ligne ne comptait pas. Le chiffre
   * affiche et la liste ouverte doivent porter sur exactement le meme ensemble.
   */
  const plage = journee && journee.jours.length > 0
    ? { from: [...journee.jours].sort()[0]!, to: [...journee.jours].sort().slice(-1)[0]! }
    : range;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    listAnalyzedConversations(tenantId, plage, {
      ...(sentiment ? { sentiment } : {}),
      ...(intent ? { intent } : {}),
      ...(action ? { action } : {}),
      // Le sujet vient des pastilles du bloc du dessus : c'est le SERVEUR qui filtre, pas un tri en mémoire
      // sur les 50 lignes déjà chargées, qui aurait donné une liste plus courte que la réalité.
      ...(sujet ? { topic: sujet } : {}),
      limit: 50,
    })
      .then((r) => { if (alive) setRows(r.conversations); })
      .catch(() => { if (alive) setRows([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  // 🔴 LA PLAGE EST DANS LES DEPENDANCES, sinon cliquer une journee ne redemanderait RIEN : la table
  // resterait sur toute la periode pendant que le tableau du dessus annonce une journee. Ce sont ses deux
  // bornes qui y entrent, pas l objet, qui est recree a chaque rendu et relancerait l appel en boucle.
  }, [tenantId, plage.from, plage.to, sentiment, intent, action, sujet]);

  const th = 'px-2 py-2 font-medium whitespace-nowrap';
  const td = 'px-2 py-2 align-top';

  return (
    <div className="mt-6 border-t border-ink-100 pt-5" id="quali-detail">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="mr-auto text-xs font-medium uppercase tracking-wide text-ink-400">{t('Détail des conversations', 'Conversation details')}</div>
        <select value={sentiment} onChange={(e) => setSentiment(e.target.value)} className={SELECT}>
          <option value="">{t('Sentiment : tous', 'Sentiment: all')}</option>
          {SENTIMENTS.map((s) => <option key={s} value={s}>{sentimentLabel(s, t)}</option>)}
        </select>
        <select value={intent} onChange={(e) => setIntent(e.target.value)} className={SELECT} data-testid="quali-filtre-intent">
          <option value="">{t('Intention : toutes', 'Intent: all')}</option>
          {INTENTS.map((i) => <option key={i} value={i}>{intentLabel(i, t)}</option>)}
        </select>
        <select value={action} onChange={(e) => setAction(e.target.value)} className={SELECT}>
          <option value="">{t('Action : toutes', 'Action: all')}</option>
          {ACTIONS.map((a) => <option key={a} value={a}>{actionLabel(a, t)}</option>)}
        </select>
        <BoutonCsv rows={rows} nom="conversations-analysees" />
        <BoutonPdf zone="quali-detail" />
      </div>

      {/* Le sujet est choisi dans les pastilles, plus haut : sans ce rappel ici, on lit une table filtrée
          sans voir pourquoi, et on croit à des données manquantes. */}
      {sujet && (
        <div className="sans-impression mb-2 flex items-center gap-2 text-xs">
          <span className="text-ink-500">{t('Sujet :', 'Topic:')}</span>
          <button
            type="button"
            data-testid="quali-sujet-retirer"
            onClick={() => onSujet(null)}
            className="inline-flex items-center gap-1.5 rounded-full bg-brand-500 px-2.5 py-1 text-white transition hover:bg-brand-600"
          >
            {sujet}<span aria-hidden="true">×</span>
          </button>
        </div>
      )}

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
                {/**
                  * 🔴 QUI A REPONDU, EN BADGES ET PAS EN CASES A COCHER. Julien avait propose des cases
                  * (2026-09-17). Mais ces quatre etats se LISENT dans `conversation_messages.origin`,
                  * ecrit au moment de l envoi : une case a cocher promet qu on peut les changer, et
                  * quelqu un qui decocherait ferait mentir les compteurs de la synthese sans qu aucun
                  * ecran ne puisse le signaler.
                  */}
                <th className={th}>{t('Répondu par', 'Answered by')}</th>
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
                    data-testid="quali-ligne"
                    onClick={() => setFiche(r)}
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
                    <td className={td} data-testid="quali-repondeurs">
                      {/**
                        * ⚠️ AUCUN BADGE EST UN CAS NORMAL, PAS UN TROU : une conversation dont tous les
                        * sortants sont anterieurs a la migration 0099 n a pas d origine, et une
                        * conversation nee d une campagne a laquelle personne n a repondu non plus. Le
                        * tiret le dit, plutot que d inventer un repondeur par defaut.
                        */}
                      {repondeursDe(r.origines ?? []).length === 0
                        ? <span className="text-ink-300" title={t('Aucun message sortant identifié : personne n’a répondu, ou la conversation est antérieure à la mesure.', 'No identified outbound message: nobody answered, or the conversation predates the measure.')}>—</span>
                        : (
                          <span className="flex flex-wrap gap-1">
                            {repondeursDe(r.origines ?? []).map((rep) => (
                              <span
                                key={rep}
                                data-testid={'quali-badge-' + rep}
                                className="inline-block rounded-full bg-ink-100 px-2 py-0.5 text-[11px] font-medium text-ink-600"
                              >
                                {libelleRepondeur(rep, t)}
                              </span>
                            ))}
                          </span>
                        )}
                    </td>
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

      {fiche && <FicheConversation c={fiche} onClose={() => setFiche(null)} />}
    </div>
  );
}

/** Carte « Conversations (analyse) » : agrégats quanti + table quali. Champs LLM = indicatifs. */
export function ConversationAnalysisCard({ tenantId, range, intentionInitiale }: {
  tenantId: string;
  range: StatsRange;
  /**
   * L intention demandee par l ADRESSE (`?intention=<cle>`), posee par un clic sur une barre de la
   * carte des intentions de la synthese (2026-09-17).
   *
   * ⚠️ C EST UN DEFAUT, PAS UN VERROU : des que l utilisateur touche au selecteur, son choix gagne. Un
   * filtre qu on ne pourrait pas defaire serait pire que pas de filtre. Meme motif que
   * `/dashboard/funnel?campagne=<id>`, deja en place.
   */
  intentionInitiale?: string;
}) {
  const t = useT();
  const [summary, setSummary] = useState<ConversationAnalysisSummary | null>(null);
  const [loading, setLoading] = useState(true);
  // Le sujet retenu vit ICI et pas dans la table : il se CHOISIT dans les pastilles du bloc quanti et
  // s'APPLIQUE à la table du dessous. Deux états séparés se seraient désynchronisés au premier oubli.
  const [sujet, setSujet] = useState<string | null>(null);
  const [actionOuverte, setActionOuverte] = useState<string | null>(null);
  /**
   * LA JOURNEE (ou la semaine) DEPLIEE, ou `null` quand on regarde toute la periode.
   *
   * ⚠️ ELLE VIT ICI ET PAS DANS LA TABLE, pour la meme raison que `sujet` juste au-dessus : elle se
   * CHOISIT dans le tableau des journees et s APPLIQUE a la table du dessous. Deux etats separes se
   * seraient desynchronises au premier oubli.
   */
  const [journee, setJournee] = useState<LignePeriode | null>(null);

  /**
   * 🔴 LA JOURNEE CHOISIE SE RELACHE QUAND LA PERIODE CHANGE, et sans ca l'ecran restait epingle DEHORS.
   * On cliquait le 10 septembre, on basculait la barre de periode sur « 7 derniers jours », et la liste du
   * dessous continuait de montrer le 10 septembre, hors de la periode affichee juste au-dessus. L'ecran ne
   * mentait pas (il nomme la journee retenue), mais il montrait deux periodes differentes en meme temps.
   * Releve en revue finale le 2026-09-17. Le bouton de bascule jour/semaine, lui, relachait deja son choix.
   */
  useEffect(() => { setJournee(null); }, [range.from, range.to]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getConversationAnalysisSummary(tenantId, range)
      .then((s) => { if (alive) setSummary(s); })
      .catch(() => { if (alive) setSummary(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tenantId, range.from, range.to]);

  // Changer de période relâche le sujet : une pastille retenue sur l'ancienne période peut ne plus exister
  // dans la nouvelle, et la table serait alors vide sans que rien ne l'explique.
  useEffect(() => { setSujet(null); }, [range.from, range.to]);

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
          <QuantiBlock summary={summary} sujet={sujet} onSujet={setSujet} onAction={setActionOuverte} />
          <TableJoursAnalyse tenantId={tenantId} range={range} choisie={journee} onChoisir={setJournee} />
          <QualiTable tenantId={tenantId} range={range} sujet={sujet} onSujet={setSujet} intentionInitiale={intentionInitiale} journee={journee} />
          {/* La rétention, DITE. Sans cette ligne, une période qui remonte au-delà d'un an rend moins de
              conversations que prévu et l'écran passe pour cassé. Le nombre vient du serveur (la même
              variable que la purge), il ne peut donc pas dériver de ce qui est réellement appliqué.

              🔴 ZÉRO ne veut PAS dire « zéro jour » : c'est la valeur qui DÉSACTIVE la purge
              (`CONVERSATION_RETENTION_DAYS` dans `config.ts`, et `purgeConversationsOlderThan` qui rend 0
              sans rien effacer). Écrire « conservées 0 jours, au-delà elles ne sont plus consultables »
              dirait exactement l'inverse de ce que fait le serveur. */}
          {summary.retentionDays !== undefined && (
            <p className="mt-4 text-[11px] text-ink-400">
              {summary.retentionDays > 0
                ? t(
                  `Les conversations et leurs analyses sont conservées ${summary.retentionDays} jours. Au-delà, elles ne sont plus consultables ni exportables.`,
                  `Conversations and their analyses are kept for ${summary.retentionDays} days. Beyond that, they can no longer be viewed or exported.`,
                )
                : t(
                  'Les conversations et leurs analyses sont conservées sans limite de durée : la purge est désactivée sur cet espace.',
                  'Conversations and their analyses are kept indefinitely: the purge is disabled on this workspace.',
                )}
            </p>
          )}
          {actionOuverte && (
            <ListeParAction tenantId={tenantId} range={range} action={actionOuverte} onClose={() => setActionOuverte(null)} />
          )}
        </>
      )}
    </div>
  );
}
