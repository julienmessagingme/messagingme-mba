'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { listConversations, getConversationMessages, replyConversation, type Conversation, type InboxMessage } from '@/lib/api';

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
          <h2 className="text-base font-semibold text-slate-900">Conversations ({conversations.length})</h2>
          <button onClick={reload} className="text-xs text-brand-600 hover:underline">Rafraîchir</button>
        </div>
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {loading ? (
          <p className="text-sm text-slate-500">Chargement...</p>
        ) : conversations.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
            Aucune conversation. Elles apparaissent quand un client répond à une campagne.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {conversations.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => setSelected(c)}
                  className={`w-full rounded-xl border px-3 py-2.5 text-left transition ${
                    selected?.id === c.id ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-white hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-medium">{c.profileName ?? `+${c.waId}`}</span>
                    <span className="shrink-0 text-[11px] text-slate-400">{new Date(c.lastMessageAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  <p className="truncate text-xs text-slate-500">{c.lastPreview ?? ''}</p>
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
          <div className="flex h-full min-h-[300px] items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white text-sm text-slate-400">
            Sélectionne une conversation
          </div>
        )}
      </section>
    </div>
  );
}

function Thread({ session, conversation, onSent }: { session: Session; conversation: Conversation; onSent: () => void }) {
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setMessages((await getConversationMessages(session.tenantId, conversation.id)).messages);
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
    <div className="flex h-[540px] flex-col rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 px-4 py-2.5">
        <span className="text-sm font-semibold">{conversation.profileName ?? `+${conversation.waId}`}</span>
        <span className="ml-2 font-mono text-xs text-slate-400">+{conversation.waId}</span>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.direction === 'out' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[75%] rounded-2xl px-3 py-1.5 text-sm ${
                m.direction === 'out' ? 'bg-brand-500 text-white' : 'bg-slate-100 text-slate-800'
              }`}
            >
              {m.buttonPayload && m.direction === 'in' ? (
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

      <div className="flex items-center gap-2 border-t border-slate-100 p-3">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void send(); }}
          placeholder="Répondre (fenêtre de service 24 h)..."
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <button
          onClick={send}
          disabled={busy || text.trim() === ''}
          className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
        >
          {busy ? '...' : 'Envoyer'}
        </button>
      </div>
    </div>
  );
}
