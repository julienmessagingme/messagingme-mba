'use client';

import { Fragment, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppShell, UNREAD_CHANGED_EVENT } from '@/components/AppShell';
import { TemplatePreview } from '@/components/TemplatePreview';
import { dayKey, dayLabel, hourMin } from '@/lib/day';
import type { ControlOwner, ReturnBehavior } from '@/lib/api';
import type { Session } from '@/lib/session';
import { useT, useLocale } from '@/lib/i18n';
import {
  listConversations,
  getConversationMessages,
  releaseConversation,
  setConversationReturnBehavior,
  replyConversation,
  listTemplates,
  sendTemplateToConversation,
  markConversationRead,
  type Conversation,
  type InboxMessage,
  type TemplateSummary,
} from '@/lib/api';

export default function InboxPage() {
  // Suspense : useSearchParams (deep-link ?c=) exige une frontière Suspense au build (Next 15).
  return (
    <AppShell active="inbox" fullBleed>
      {(session) => (
        <Suspense fallback={null}>
          <InboxInner session={session} />
        </Suspense>
      )}
    </AppShell>
  );
}

/** Réponse de formulaire Flow (nfm_reply) : le payload est un objet JSON {champ: valeur}. Renvoie les
 *  paires à afficher, ou null si ce n'est pas un objet (bouton simple, ou JSON tronqué non parsable). */
function parseFormResponse(payload: string): Array<[string, unknown]> | null {
  try {
    const o = JSON.parse(payload) as unknown;
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      const entries = Object.entries(o).filter(([k]) => k !== 'flow_token' && !k.startsWith('__'));
      return entries.length > 0 ? entries : null;
    }
  } catch {
    /* JSON tronqué/non parsable -> repli sur le brut */
  }
  return null;
}
function prettyKey(k: string): string {
  const s = k.replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Initiales d'un nom : 2 lettres (1re de 2 mots, sinon 2 premières lettres). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Pastille d'auteur d'une bulle sortante (initiales + tooltip nom). */
function AgentBadge({ name }: { name: string }) {
  const t = useT();
  return (
    <span
      title={t(`Envoyé par ${name}`, `Sent by ${name}`)}
      aria-label={t(`Envoyé par ${name}`, `Sent by ${name}`)}
      className="flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-full bg-ink-700 text-[10px] font-semibold text-white"
    >
      {initials(name)}
    </span>
  );
}

/** Rendu d'un message entrant à payload : carte « formulaire rempli » si c'est un objet, sinon bouton. */
function InboundPayload({ body, payload }: { body: string | null; payload: string }) {
  const t = useT();
  const entries = parseFormResponse(payload);
  if (!entries) return <span>👆 {body ?? payload}</span>;
  return (
    <div className="space-y-0.5">
      <div className="mb-1 text-xs font-semibold opacity-70">📋 {t('Formulaire rempli', 'Form response')}</div>
      {entries.map(([k, v]) => (
        <div key={k} className="text-sm">
          <span className="opacity-60">{prettyKey(k)} : </span>
          {String(v)}
        </div>
      ))}
    </div>
  );
}

function InboxInner({ session }: { session: Session }) {
  const t = useT();
  const { locale } = useLocale();
  const searchParams = useSearchParams();
  const deepLinkId = searchParams.get('c');
  const deepLinkApplied = useRef(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [onlyTodo, setOnlyTodo] = useState(false); // filtre « À traiter » : conversations que le scénario ne gère plus (control_owner != app_workflow)

  const reload = useCallback(async () => {
    setError(null);
    try {
      setConversations((await listConversations(session.tenantId)).conversations);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Failed to load'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Deep-link ?c=<id> : quand la liste est chargée, pré-sélectionne la conversation correspondante (une seule
  // fois, pour ne pas ré-écraser un choix manuel aux refresh suivants). Conv absente de la liste -> ignorée.
  useEffect(() => {
    if (deepLinkApplied.current || !deepLinkId || conversations.length === 0) return;
    const match = conversations.find((c) => c.id === deepLinkId);
    if (match) {
      setSelected(match);
      deepLinkApplied.current = true;
    }
  }, [deepLinkId, conversations]);

  // Auto-refresh de la liste (~15 s), seulement quand l'onglet est visible (pas de martèlement en arrière-plan) ;
  // reload immédiat au retour de focus. Réutilise l'endpoint existant, aucun changement backend.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') void reload(); };
    const id = setInterval(tick, 15000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [reload]);

  // « À traiter » = le scénario ne gère plus le fil (opérateur a pris la main, ou node inbox a escaladé, ou MBA).
  const todoCount = conversations.filter((c) => c.controlOwner !== 'app_workflow').length;
  const visible = onlyTodo ? conversations.filter((c) => c.controlOwner !== 'app_workflow') : conversations;

  return (
    <div className="grid gap-4 p-4 lg:h-full lg:grid-cols-[320px_1fr]">
      <section className="lg:flex lg:min-h-0 lg:flex-col">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Conversations', 'Conversations')} ({conversations.length})</h2>
          <button onClick={reload} className="text-xs text-brand-600 hover:underline">{t('Rafraîchir', 'Refresh')}</button>
        </div>
        <div className="mb-3 flex gap-1 text-xs">
          <button onClick={() => setOnlyTodo(false)} className={`rounded-md px-2 py-1 ${!onlyTodo ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-500 hover:bg-ink-100'}`}>{t('Toutes', 'All')}</button>
          <button onClick={() => setOnlyTodo(true)} data-testid="inbox-filter-todo" className={`rounded-md px-2 py-1 ${onlyTodo ? 'bg-brand-50 font-medium text-brand-700' : 'text-ink-500 hover:bg-ink-100'}`}>
            {t('À traiter', 'To handle')}{todoCount > 0 ? ` (${todoCount})` : ''}
          </button>
        </div>
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {loading ? (
          <p className="text-sm text-ink-500">{t('Chargement...', 'Loading...')}</p>
        ) : visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-ink-300 bg-white px-4 py-10 text-center text-sm text-ink-500">
            {conversations.length === 0
              ? t('Aucune conversation. Elles apparaissent quand un client répond à une campagne.', 'No conversations yet. They appear when a customer replies to a campaign.')
              : t('Rien à traiter : toutes les conversations sont gérées par le scénario.', 'Nothing to handle: every conversation is handled by the scenario.')}
          </div>
        ) : (
          <ul className="space-y-1.5 lg:flex-1 lg:overflow-y-auto">
            {visible.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => setSelected(c)}
                  className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
                    selected?.id === c.id ? 'border-brand-500 bg-brand-50' : 'border-ink-200 bg-white hover:bg-ink-50'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`truncate text-sm ${c.unread ? 'font-semibold text-ink-900' : 'font-medium'}`}>
                      {/* Point de non-lu : le compteur du menu doit pouvoir se traduire en action, sinon il dit
                          « 3 » sans dire lesquelles. */}
                      {c.unread && <span data-testid="unread-dot" className="mr-1.5 inline-block h-2 w-2 rounded-full bg-coral align-middle" aria-label={t('non lu', 'unread')} />}
                      {c.profileName ?? `+${c.waId}`}
                    </span>
                    <span className="shrink-0 text-[11px] text-ink-400">{hourMin(c.lastMessageAt, locale)}</span>
                  </div>
                  <p className="truncate text-xs text-ink-500">{c.lastPreview ?? ''}</p>
                  {/* Le badge n'apparaît QUE si quelqu'un détient le fil : l'afficher sur toutes les
                      lignes noierait l'information, alors que c'est l'exception qui doit sauter aux yeux. */}
                  {c.controlOwner !== 'app_workflow' && (
                    <span className="mt-1 inline-block"><ControlBadge owner={c.controlOwner} /></span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="lg:min-h-0">
        {selected ? (
          <Thread key={selected.id} session={session} conversation={selected} onSent={reload} />
        ) : (
          <div className="flex h-full min-h-[300px] items-center justify-center rounded-2xl border border-dashed border-ink-300 bg-white text-sm text-ink-400">
            {t('Sélectionne une conversation', 'Select a conversation')}
          </div>
        )}
      </section>
    </div>
  );
}

function Thread({ session, conversation, onSent }: { session: Session; conversation: Conversation; onSent: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [windowOpen, setWindowOpen] = useState(true);
  // Qui détient le fil. Sans cette information, l'opérateur voit le scénario se taire sans comprendre
  // pourquoi, et ne sait pas s'il doit rendre la main.
  const [controlOwner, setControlOwner] = useState<ControlOwner>('app_workflow');
  // Surcharge de reprise de CE fil (C.4). '' = suit le défaut du tenant. Dit au sweep de handback si, à la
  // reprise, ce fil précis repart au scénario ou reste à traiter.
  const [returnBehavior, setReturnBehaviorState] = useState<ReturnBehavior | ''>('');
  const [savingReturn, setSavingReturn] = useState(false);
  // Garde de synchro : tant qu'une sauvegarde de l'override est en vol, le poll ne réécrit pas le select.
  const savingReturnRef = useRef(false);
  const [releasing, setReleasing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Dernier message DÉJÀ vu dans ce fil : sert à ne marquer « lu » qu'au vrai changement, et pas à chacun
  // des rafraîchissements de 4 s. Remis à zéro par le remontage du composant à chaque conversation.
  const dernierVuRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await getConversationMessages(session.tenantId, conversation.id);
      // Le fil est ouvert à l'écran : il est lu. On le dit au serveur à l'ouverture, puis à chaque nouveau
      // message, jamais à chaque tick. Best-effort : la pastille n'est pas une raison de casser le fil.
      const dernier = res.messages[res.messages.length - 1]?.id ?? null;
      if (dernier !== dernierVuRef.current) {
        dernierVuRef.current = dernier;
        markConversationRead(session.tenantId, conversation.id)
          .then(() => window.dispatchEvent(new Event(UNREAD_CHANGED_EVENT)))
          .catch(() => { /* pastille d'appoint */ });
      }
      // GARDE anti-saut de scroll : on ne remplace `messages` (nouvelle référence) QUE si le fil a réellement
      // changé (nombre de messages ou dernier id). Sinon l'effet scrollIntoView ci-dessous ramènerait le scroll
      // en bas à chaque tick de poll pendant que l'agent lit l'historique.
      setMessages((prev) =>
        prev.length === res.messages.length && prev[prev.length - 1]?.id === res.messages[res.messages.length - 1]?.id
          ? prev
          : res.messages,
      );
      setWindowOpen(res.windowOpen);
      setControlOwner(res.controlOwner);
      // Ne pas écraser une saisie en cours : on ne (re)synchronise l'override que si aucune sauvegarde n'est en vol.
      if (!savingReturnRef.current) setReturnBehaviorState(res.returnBehavior ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Failed to load'));
    }
  }, [session.tenantId, conversation.id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-refresh du fil ouvert (~4 s, chat vivant) tant que l'onglet est visible. Thread est remonté par
  // conversation (key=selected.id), donc l'interval se recrée proprement à chaque changement de conversation.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const id = setInterval(tick, 4000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function send() {
    if (text.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      await replyConversation(session.tenantId, conversation.id, text.trim());
      setText('');
      await load();
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Envoi impossible', 'Failed to send'));
    } finally {
      setBusy(false);
    }
  }

  async function release() {
    setReleasing(true);
    setError(null);
    try {
      const res = await releaseConversation(session.tenantId, conversation.id);
      setControlOwner(res.controlOwner);
      onSent(); // rafraîchit la liste : le badge y change aussi
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Reprise impossible', 'Hand back failed'));
    } finally {
      setReleasing(false);
    }
  }

  /** Surcharge de reprise de CE fil (C.4). '' = suit le défaut du tenant. Sauvegarde optimiste au changement. */
  async function saveReturn(next: ReturnBehavior | '') {
    setReturnBehaviorState(next);
    savingReturnRef.current = true;
    setSavingReturn(true);
    setError(null);
    try {
      await setConversationReturnBehavior(session.tenantId, conversation.id, next === '' ? null : next);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Réglage impossible', 'Failed to save'));
    } finally {
      savingReturnRef.current = false;
      setSavingReturn(false);
    }
  }

  return (
    <div className="flex h-[540px] flex-col rounded-2xl border border-ink-200 bg-white shadow-sm lg:h-full">
      <div className="flex items-center justify-between border-b border-ink-100 px-4 py-2.5">
        <div>
          <span className="text-sm font-semibold">{conversation.profileName ?? `+${conversation.waId}`}</span>
          <span className="ml-2 font-mono text-xs text-ink-400">+{conversation.waId}</span>
        </div>
        <div className="flex items-center gap-2">
          <ControlBadge owner={controlOwner} />
          {/* Rendre la main : sans ce bouton, le seul retour possible serait le délai d'inactivité, donc un
              opérateur qui règle une question en deux minutes devrait attendre des heures. */}
          {controlOwner === 'app_human' && (
            <button
              onClick={() => { void release(); }}
              disabled={releasing}
              className="rounded-lg border border-ink-300 px-2 py-0.5 text-[11px] font-medium text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
            >
              {releasing ? t('...', '...') : t('Rendre la main', 'Hand back')}
            </button>
          )}
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${windowOpen ? 'bg-mint-50 text-mint-700' : 'bg-amber-50 text-amber-700'}`}>
            {windowOpen ? t('fenêtre 24 h ouverte', '24h window open') : t('fenêtre 24 h fermée', '24h window closed')}
          </span>
        </div>
      </div>

      {/* Surcharge de reprise de CE fil (C.4) : après une prise en main, ce fil précis repart au scénario,
          reste à traiter, ou suit le défaut du tenant. Réglage lu par le sweep de handback, ne bascule rien tout de suite. */}
      <div className="flex items-center gap-2 border-b border-ink-100 px-4 py-1.5 text-[11px] text-ink-500">
        <label htmlFor="thread-return" className="shrink-0">{t('À la reprise :', 'On resume:')}</label>
        <select
          id="thread-return"
          data-testid="thread-return-select"
          value={returnBehavior}
          onChange={(e) => { void saveReturn(e.target.value as ReturnBehavior | ''); }}
          disabled={savingReturn}
          className="rounded-md border border-ink-200 px-1.5 py-0.5 text-[11px] text-ink-700 outline-none focus:border-brand-500 disabled:opacity-60"
        >
          <option value="">{t('défaut du compte', 'account default')}</option>
          <option value="resume">{t('repart au scénario', 'resumes the scenario')}</option>
          <option value="inbox">{t('reste à traiter', 'stays to handle')}</option>
        </select>
        {savingReturn && <span className="text-ink-400">{t('enregistrement...', 'saving...')}</span>}
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {messages.map((m, i) => {
          // Séparateur de jour (fuseau Paris) quand le jour change vs le message précédent.
          const showSep = i === 0 || dayKey(m.createdAt) !== dayKey(messages[i - 1]!.createdAt);
          return (
            <Fragment key={m.id}>
              {showSep && (
                <div className="flex justify-center py-1">
                  <span className="rounded-full bg-ink-100 px-2.5 py-0.5 text-[11px] font-medium text-ink-500">{dayLabel(m.createdAt, locale)}</span>
                </div>
              )}
              <div className={`flex items-end gap-1.5 ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[75%] rounded-2xl px-3 py-1.5 text-sm ${
                    m.direction === 'out' ? 'bg-brand-500 text-white' : 'bg-ink-100 text-ink-800'
                  }`}
                >
                  {m.type === 'template' ? (
                    <span className="italic opacity-90">📋 {m.body}</span>
                  ) : m.buttonPayload && m.direction === 'in' ? (
                    <InboundPayload body={m.body} payload={m.buttonPayload} />
                  ) : (
                    m.body ?? <span className="italic opacity-70">[{m.type}]</span>
                  )}
                  <div className={`mt-0.5 text-right text-[10px] ${m.direction === 'out' ? 'text-white/70' : 'text-ink-400'}`}>{hourMin(m.createdAt, locale)}</div>
                </div>
                {/* Pastille de l'auteur (repli neutre : rien si pas d'auteur, legacy ou réponse auto). */}
                {m.direction === 'out' && m.senderName ? <AgentBadge name={m.senderName} /> : null}
              </div>
            </Fragment>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {error && <p className="mx-4 mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {windowOpen ? (
        <div className="flex items-center gap-2 border-t border-ink-100 p-3">
          <button
            onClick={() => setShowTemplate(true)}
            title={t('Envoyer un template', 'Send a template')}
            className="shrink-0 rounded-lg border border-ink-300 px-2.5 py-2 text-sm text-ink-600 hover:bg-ink-50"
          >
            📋
          </button>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void send(); }}
            placeholder={t('Répondre (fenêtre de service 24 h)...', 'Reply (24h service window)...')}
            className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          <button
            onClick={send}
            disabled={busy || text.trim() === ''}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? '...' : t('Envoyer', 'Send')}
          </button>
        </div>
      ) : (
        <div className="border-t border-ink-100 p-3">
          <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {t('Fenêtre de 24 h fermée : WhatsApp interdit le message libre. Pour reprendre contact, envoie un ', '24-hour window closed: WhatsApp does not allow free-form messages. To reach out again, send an ')}<b>{t('template approuvé', 'approved template')}</b>.
          </p>
          <button
            onClick={() => setShowTemplate(true)}
            className="w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-600"
          >
            {t('Envoyer un template', 'Send a template')}
          </button>
        </div>
      )}

      {showTemplate && (
        <TemplateSendPanel
          session={session}
          conversationId={conversation.id}
          onClose={() => setShowTemplate(false)}
          onSent={async () => { setShowTemplate(false); await load(); onSent(); }}
        />
      )}
    </div>
  );
}

const inputCls =
  'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

function varCountOf(body: string | undefined): number {
  return body ? new Set(body.match(/\{\{\s*\d+\s*\}\}/g) ?? []).size : 0;
}

function TemplateSendPanel({
  session,
  conversationId,
  onClose,
  onSent,
}: {
  session: Session;
  conversationId: string;
  onClose: () => void;
  onSent: () => void | Promise<void>;
}) {
  const t = useT();
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [sel, setSel] = useState<TemplateSummary | null>(null);
  const [vars, setVars] = useState<string[]>([]);
  const [imageUrl, setImageUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await listTemplates(session.tenantId);
        // Carousels INCLUS : l'API relit leurs cartes chez Meta et re-téléverse les visuels avant d'envoyer
        // (même chemin que la campagne). Un carousel non envoyable ressort en 422 avec sa raison.
        if (alive) setTemplates(res.templates.filter((x) => x.status === 'APPROVED'));
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : t('Templates indisponibles', 'Templates unavailable'));
      }
    })();
    return () => { alive = false; };
  }, [session.tenantId, t]);

  const varCount = varCountOf(sel?.body);
  const needsMedia = sel?.headerFormat === 'IMAGE' || sel?.headerFormat === 'VIDEO' || sel?.headerFormat === 'DOCUMENT';
  const previewExamples = Array.from({ length: varCount }, (_, i) => vars[i] || `{{${i + 1}}}`);
  const varsFilled = Array.from({ length: varCount }).every((_, i) => (vars[i] ?? '').trim() !== '');
  const canSend = !!sel && !busy && varsFilled && (!needsMedia || imageUrl.trim() !== '');

  function pick(value: string) {
    const found = templates.find((x) => `${x.name}::${x.language}` === value) ?? null;
    setSel(found);
    setVars([]);
    setImageUrl('');
    setError(null);
  }

  async function send() {
    if (!sel) return;
    setBusy(true);
    setError(null);
    try {
      await sendTemplateToConversation(session.tenantId, conversationId, {
        templateName: sel.name,
        language: sel.language,
        bodyParams: Array.from({ length: varCount }, (_, i) => vars[i] ?? ''),
        ...(sel.category ? { templateCategory: sel.category } : {}),
        ...(needsMedia && imageUrl.trim()
          ? { headerMediaUrl: imageUrl.trim(), headerFormat: sel.headerFormat as 'IMAGE' | 'VIDEO' | 'DOCUMENT' }
          : {}),
      });
      await onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Envoi impossible', 'Failed to send'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold tracking-tight text-ink-900">{t('Envoyer un template', 'Send a template')}</h3>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">×</button>
        </div>
        <p className="mt-1 text-xs text-ink-500">{t('Le seul moyen de ré-engager un contact hors fenêtre de 24 h.', 'The only way to re-engage a contact outside the 24h window.')}</p>

        <div className="mt-3">
          <label className="mb-1 block text-sm font-medium text-ink-700">{t('Template approuvé', 'Approved template')}</label>
          {templates.length === 0 ? (
            <p className="text-xs text-amber-700">{t('Aucun template approuvé. Crée-en un dans Campagnes → Templates.', 'No approved template. Create one in Campaigns → Templates.')}</p>
          ) : (
            <select value={sel ? `${sel.name}::${sel.language}` : ''} onChange={(e) => pick(e.target.value)} className={inputCls}>
              <option value="" disabled>{t('Choisir…', 'Choose…')}</option>
              {templates.map((tpl) => (
                <option key={`${tpl.name}::${tpl.language}`} value={`${tpl.name}::${tpl.language}`}>
                  {tpl.name} ({tpl.language}){tpl.isCarousel ? ` · ${t('carousel', 'carousel')}` : ''}
                </option>
              ))}
            </select>
          )}
        </div>

        {sel && (
          <>
            {varCount > 0 && (
              <div className="mt-3">
                <label className="mb-1 block text-sm font-medium text-ink-700">{t('Variables', 'Variables')}</label>
                <div className="space-y-2">
                  {Array.from({ length: varCount }).map((_, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="w-8 text-xs text-ink-400">{`{{${i + 1}}}`}</span>
                      <input
                        value={vars[i] ?? ''}
                        onChange={(e) => setVars((x) => { const c = [...x]; c[i] = e.target.value; return c; })}
                        className={`${inputCls} flex-1`}
                        placeholder={t('valeur', 'value')}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {needsMedia && (
              <div className="mt-3">
                <label className="mb-1 block text-sm font-medium text-ink-700">
                  {t(
                    `URL de l'${sel.headerFormat === 'IMAGE' ? 'image' : sel.headerFormat === 'VIDEO' ? 'vidéo' : 'document'} (header du template)`,
                    `${sel.headerFormat === 'IMAGE' ? 'Image' : sel.headerFormat === 'VIDEO' ? 'Video' : 'Document'} URL (template header)`,
                  )}
                </label>
                <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://..." className={inputCls} />
                <p className="mt-1 text-[11px] text-ink-400">{t("Lien public (https). L'upload de fichier direct arrive bientôt.", 'Public link (https). Direct file upload is coming soon.')}</p>
              </div>
            )}

            <div className="mt-3">
              {/* Un carousel se montre comme un carousel : le corps seul ne dit rien de ce que le contact reçoit. */}
              <TemplatePreview template={{ body: sel.body, buttons: [], ...(sel.carousel ? { carousel: sel.carousel } : {}) }} examples={previewExamples} />
            </div>
          </>
        )}

        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="mt-4 flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-50">{t('Annuler', 'Cancel')}</button>
          <button
            onClick={send}
            disabled={!canSend}
            className="flex-1 rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? t('Envoi...', 'Sending...') : t('Envoyer le template', 'Send the template')}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Qui répond au client en ce moment. Trois états mutuellement exclusifs.
 *
 * L'enjeu n'est pas décoratif : quand un opérateur détient le fil, le scénario se tait volontairement.
 * Sans ce badge, ce silence ressemblerait à une panne.
 */
function ControlBadge({ owner }: { owner: ControlOwner }) {
  const t = useT();
  const LOOK: Record<ControlOwner, { label: string; cls: string; title: string }> = {
    app_workflow: {
      label: t('scénario', 'scenario'),
      cls: 'bg-ink-100 text-ink-600',
      title: t('Le scénario automatique répond.', 'The automated scenario is responding.'),
    },
    app_human: {
      label: t('vous avez la main', 'you have the hand'),
      cls: 'bg-brand-50 text-brand-700',
      title: t(
        'Un opérateur s’occupe de cette conversation : le scénario est en pause et les campagnes ne l’enverront pas.',
        'An operator is handling this conversation: the scenario is paused and campaigns will skip it.',
      ),
    },
    mba: {
      label: t('agent Meta', 'Meta agent'),
      cls: 'bg-violet-50 text-violet-700',
      title: t("L'agent de Meta répond directement au client.", 'Meta’s agent is answering the customer directly.'),
    },
  };
  const look = LOOK[owner];
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${look.cls}`} title={look.title}>
      {look.label}
    </span>
  );
}
