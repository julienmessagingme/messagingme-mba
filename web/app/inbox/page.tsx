'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { WhatsAppPreview } from '@/components/WhatsAppPreview';
import type { Session } from '@/lib/session';
import {
  listConversations,
  getConversationMessages,
  replyConversation,
  listTemplates,
  sendTemplateToConversation,
  type Conversation,
  type InboxMessage,
  type TemplateSummary,
} from '@/lib/api';

export default function InboxPage() {
  return <AppShell active="inbox">{(session) => <InboxInner session={session} />}</AppShell>;
}

function InboxInner({ session }: { session: Session }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setConversations((await listConversations(session.tenantId)).conversations);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [session.tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight text-ink-900">Conversations ({conversations.length})</h2>
          <button onClick={reload} className="text-xs text-brand-600 hover:underline">Rafraîchir</button>
        </div>
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {loading ? (
          <p className="text-sm text-ink-500">Chargement...</p>
        ) : conversations.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-ink-300 bg-white px-4 py-10 text-center text-sm text-ink-500">
            Aucune conversation. Elles apparaissent quand un client répond à une campagne.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {conversations.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => setSelected(c)}
                  className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
                    selected?.id === c.id ? 'border-brand-500 bg-brand-50' : 'border-ink-200 bg-white hover:bg-ink-50'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">{c.profileName ?? `+${c.waId}`}</span>
                    <span className="shrink-0 text-[11px] text-ink-400">{new Date(c.lastMessageAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <p className="truncate text-xs text-ink-500">{c.lastPreview ?? ''}</p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        {selected ? (
          <Thread key={selected.id} session={session} conversation={selected} onSent={reload} />
        ) : (
          <div className="flex h-full min-h-[300px] items-center justify-center rounded-2xl border border-dashed border-ink-300 bg-white text-sm text-ink-400">
            Sélectionne une conversation
          </div>
        )}
      </section>
    </div>
  );
}

function Thread({ session, conversation, onSent }: { session: Session; conversation: Conversation; onSent: () => void }) {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [windowOpen, setWindowOpen] = useState(true);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const t = await getConversationMessages(session.tenantId, conversation.id);
      setMessages(t.messages);
      setWindowOpen(t.windowOpen);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chargement impossible');
    }
  }, [session.tenantId, conversation.id]);

  useEffect(() => {
    void load();
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
      setError(err instanceof Error ? err.message : 'Envoi impossible');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-[540px] flex-col rounded-2xl border border-ink-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-ink-100 px-4 py-2.5">
        <div>
          <span className="text-sm font-semibold">{conversation.profileName ?? `+${conversation.waId}`}</span>
          <span className="ml-2 font-mono text-xs text-ink-400">+{conversation.waId}</span>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${windowOpen ? 'bg-mint-50 text-mint-700' : 'bg-amber-50 text-amber-700'}`}>
          {windowOpen ? 'fenêtre 24 h ouverte' : 'fenêtre 24 h fermée'}
        </span>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[75%] rounded-2xl px-3 py-1.5 text-sm ${
                m.direction === 'out' ? 'bg-brand-500 text-white' : 'bg-ink-100 text-ink-800'
              }`}
            >
              {m.type === 'template' ? (
                <span className="italic opacity-90">📋 {m.body}</span>
              ) : m.buttonPayload && m.direction === 'in' ? (
                <span>👆 {m.body ?? m.buttonPayload}</span>
              ) : (
                m.body ?? <span className="italic opacity-70">[{m.type}]</span>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {error && <p className="mx-4 mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {windowOpen ? (
        <div className="flex items-center gap-2 border-t border-ink-100 p-3">
          <button
            onClick={() => setShowTemplate(true)}
            title="Envoyer un template"
            className="shrink-0 rounded-lg border border-ink-300 px-2.5 py-2 text-sm text-ink-600 hover:bg-ink-50"
          >
            📋
          </button>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void send(); }}
            placeholder="Répondre (fenêtre de service 24 h)..."
            className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          />
          <button
            onClick={send}
            disabled={busy || text.trim() === ''}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? '...' : 'Envoyer'}
          </button>
        </div>
      ) : (
        <div className="border-t border-ink-100 p-3">
          <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Fenêtre de 24 h fermée : WhatsApp interdit le message libre. Pour reprendre contact, envoie un <b>template approuvé</b>.
          </p>
          <button
            onClick={() => setShowTemplate(true)}
            className="w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-600"
          >
            Envoyer un template
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
        const t = await listTemplates(session.tenantId);
        if (alive) setTemplates(t.templates.filter((x) => x.status === 'APPROVED'));
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Templates indisponibles');
      }
    })();
    return () => { alive = false; };
  }, [session.tenantId]);

  const varCount = varCountOf(sel?.body);
  const needsMedia = sel?.headerFormat === 'IMAGE' || sel?.headerFormat === 'VIDEO' || sel?.headerFormat === 'DOCUMENT';
  const previewExamples = Array.from({ length: varCount }, (_, i) => vars[i] || `{{${i + 1}}}`);
  const varsFilled = Array.from({ length: varCount }).every((_, i) => (vars[i] ?? '').trim() !== '');
  const canSend = !!sel && !busy && varsFilled && (!needsMedia || imageUrl.trim() !== '');

  function pick(value: string) {
    const t = templates.find((x) => `${x.name}::${x.language}` === value) ?? null;
    setSel(t);
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
        ...(needsMedia && imageUrl.trim()
          ? { headerMediaUrl: imageUrl.trim(), headerFormat: sel.headerFormat as 'IMAGE' | 'VIDEO' | 'DOCUMENT' }
          : {}),
      });
      await onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Envoi impossible');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold tracking-tight text-ink-900">Envoyer un template</h3>
          <button onClick={onClose} className="text-ink-400 hover:text-ink-700">×</button>
        </div>
        <p className="mt-1 text-xs text-ink-500">Le seul moyen de ré-engager un contact hors fenêtre de 24 h.</p>

        <div className="mt-3">
          <label className="mb-1 block text-sm font-medium text-ink-700">Template approuvé</label>
          {templates.length === 0 ? (
            <p className="text-xs text-amber-700">Aucun template approuvé. Crée-en un dans Campagnes → Templates.</p>
          ) : (
            <select value={sel ? `${sel.name}::${sel.language}` : ''} onChange={(e) => pick(e.target.value)} className={inputCls}>
              <option value="" disabled>Choisir…</option>
              {templates.map((t) => (
                <option key={`${t.name}::${t.language}`} value={`${t.name}::${t.language}`}>{t.name} ({t.language})</option>
              ))}
            </select>
          )}
        </div>

        {sel && (
          <>
            {varCount > 0 && (
              <div className="mt-3">
                <label className="mb-1 block text-sm font-medium text-ink-700">Variables</label>
                <div className="space-y-2">
                  {Array.from({ length: varCount }).map((_, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="w-8 text-xs text-ink-400">{`{{${i + 1}}}`}</span>
                      <input
                        value={vars[i] ?? ''}
                        onChange={(e) => setVars((x) => { const c = [...x]; c[i] = e.target.value; return c; })}
                        className={`${inputCls} flex-1`}
                        placeholder="valeur"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {needsMedia && (
              <div className="mt-3">
                <label className="mb-1 block text-sm font-medium text-ink-700">
                  URL de l&apos;{sel.headerFormat === 'IMAGE' ? 'image' : sel.headerFormat === 'VIDEO' ? 'vidéo' : 'document'} (header du template)
                </label>
                <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://..." className={inputCls} />
                <p className="mt-1 text-[11px] text-ink-400">Lien public (https). L&apos;upload de fichier direct arrive bientôt.</p>
              </div>
            )}

            <div className="mt-3">
              <WhatsAppPreview body={sel.body ?? ''} examples={previewExamples} buttons={[]} hideNote />
            </div>
          </>
        )}

        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="mt-4 flex gap-2">
          <button onClick={onClose} className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm text-ink-700 hover:bg-ink-50">Annuler</button>
          <button
            onClick={send}
            disabled={!canSend}
            className="flex-1 rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? 'Envoi...' : 'Envoyer le template'}
          </button>
        </div>
      </div>
    </div>
  );
}
