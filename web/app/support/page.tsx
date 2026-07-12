'use client';

import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { sendSupportMessage } from '@/lib/api';

export default function SupportPage() {
  return <AppShell active="support">{(session) => <SupportInner session={session} />}</AppShell>;
}

function SupportInner({ session }: { session: Session }) {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sendSupportMessage(session.tenantId, { subject: subject.trim(), message: message.trim(), email: session.email });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Envoi impossible pour le moment.");
    } finally {
      setBusy(false);
    }
  }

  const inputCls = 'w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-ink-900">Support</h2>
        <p className="mt-1 text-sm text-ink-500">Une question, un souci ? Écris-nous, on te répond par email ({session.email}).</p>
      </div>

      {sent ? (
        <div className="rounded-2xl border border-mint-200 bg-mint-50 p-5 text-sm text-mint-700">
          Message envoyé. Nous te répondrons à {session.email}.
          <button onClick={() => { setSent(false); setSubject(''); setMessage(''); }} className="ml-2 font-medium underline">Envoyer un autre message</button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-600">Sujet</label>
            <input required value={subject} onChange={(e) => setSubject(e.target.value)} className={inputCls} placeholder="Ex. Problème d'envoi de campagne" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-600">Message</label>
            <textarea required rows={6} value={message} onChange={(e) => setMessage(e.target.value)} className={inputCls} placeholder="Décris ta demande…" />
          </div>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <button
            type="submit"
            disabled={busy || subject.trim() === '' || message.trim() === ''}
            className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-60"
          >
            {busy ? 'Envoi…' : 'Envoyer'}
          </button>
        </form>
      )}
    </div>
  );
}
