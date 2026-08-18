'use client';

import { useState } from 'react';
import { useT } from '@/lib/i18n';
import { cardCls, inputCls } from '@/lib/ui';
import { MbaNotice } from './MbaNotice';
import { testMbaAgent } from '@/lib/api-mba';

/**
 * Bac à sable : parler à l'agent comme un client, sans destinataire réel et sans l'allumer. Meta ne facture pas
 * les jetons consommés ici, c'est donc le seul moyen honnête de vérifier une configuration avant de l'exposer.
 *
 * Le `conversation_id` rendu par Meta est CONSERVÉ et renvoyé au message suivant : sans lui, chaque message
 * repartirait de zéro et on ne testerait jamais ce qui compte vraiment, le suivi d'un fil.
 */

interface Tour {
  role: 'client' | 'agent';
  texte: string;
  note?: string;
}

export function MbaTestPanel({ tenantId, phoneNumberId }: { tenantId: string; phoneNumberId: string }) {
  const t = useT();
  const [tours, setTours] = useState<Tour[]>([]);
  const [message, setMessage] = useState('');
  const [conversationId, setConversationId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function envoyer(): Promise<void> {
    const texte = message.trim();
    if (texte === '') return;
    setMessage('');
    setErr('');
    setBusy(true);
    setTours((t0) => [...t0, { role: 'client', texte }]);
    try {
      const rep = await testMbaAgent(tenantId, phoneNumberId, texte, conversationId);
      if (rep.conversation_id) setConversationId(rep.conversation_id);
      const notes = [
        rep.handoff_reason ? t(`Passage à un humain : ${rep.handoff_reason}`, `Handoff to a human: ${rep.handoff_reason}`) : '',
        rep.no_response_reason ? t(`Pas de réponse : ${rep.no_response_reason}`, `No response: ${rep.no_response_reason}`) : '',
      ].filter((n) => n !== '').join(' · ');
      setTours((t0) => [...t0, {
        role: 'agent',
        texte: rep.agent_response ?? t('(aucune réponse)', '(no response)'),
        ...(notes !== '' ? { note: notes } : {}),
      }]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      {err !== '' && <MbaNotice kind="error" testid="mba-test-error">{err}</MbaNotice>}

      <section className={cardCls}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">{t('Tester l’agent', 'Test the agent')}</h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-600">
              {t(
                'Aucun message réel n’est envoyé, et l’agent n’a pas besoin d’être allumé. Vérifiez surtout qu’il refuse d’inventer ce qu’il ne sait pas.',
                'No real message is sent, and the agent does not need to be on. Above all, check that it refuses to make up what it does not know.',
              )}
            </p>
          </div>
          {tours.length > 0 && (
            <button
              className="shrink-0 text-xs font-medium text-ink-500 hover:text-ink-800"
              data-testid="mba-test-reset"
              onClick={() => { setTours([]); setConversationId(undefined); }}
            >
              {t('Nouvelle conversation', 'New conversation')}
            </button>
          )}
        </div>

        <div className="mt-4 space-y-2 rounded-xl bg-ink-50 p-3" data-testid="mba-test-thread">
          {tours.length === 0 && (
            <p className="py-6 text-center text-sm text-ink-400">{t('Écrivez un message pour commencer.', 'Type a message to start.')}</p>
          )}
          {tours.map((tour, i) => (
            <div key={`${i}-${tour.texte.slice(0, 16)}`} className={`flex ${tour.role === 'client' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${tour.role === 'client' ? 'bg-brand-500 text-white' : 'bg-white text-ink-800 shadow-sm'}`}>
                <p className="whitespace-pre-wrap">{tour.texte}</p>
                {tour.note !== undefined && <p className="mt-1 text-xs opacity-70" data-testid="mba-test-note">{tour.note}</p>}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-3 flex gap-2">
          <input
            className={inputCls}
            data-testid="mba-test-input"
            placeholder={t('Écris un message de test…', 'Type a test message…')}
            value={message}
            disabled={busy}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void envoyer(); }}
          />
          <button
            className="shrink-0 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            data-testid="mba-test-send"
            disabled={busy || message.trim() === ''}
            onClick={() => void envoyer()}
          >
            {busy ? t('…', '…') : t('Envoyer', 'Send')}
          </button>
        </div>
      </section>
    </div>
  );
}
