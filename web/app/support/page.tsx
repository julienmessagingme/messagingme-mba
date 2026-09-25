'use client';

import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import { sendSupportMessage } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import { IntroPage, TitrePage } from '@/components/TitrePage';

export default function SupportPage() {
  return <AppShell active="support">{(session) => <SupportInner session={session} />}</AppShell>;
}

function SupportInner({ session }: { session: Session }) {
  const t = useT();
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
      await sendSupportMessage(session.tenantId, { subject: subject.trim(), message: message.trim() });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Envoi impossible pour le moment.", 'Unable to send right now.'));
    } finally {
      setBusy(false);
    }
  }

  
  return (
    <div className="max-w-formulaire space-y-6">
      <div>
        <TitrePage>{t('Support', 'Support')}</TitrePage>
        <IntroPage>{t('Une question, un souci ? Écris-nous, on te répond par email', 'A question or an issue? Write to us and we will reply by email')} ({session.email}).</IntroPage>
      </div>

      {sent ? (
        <div className="rounded-carte border border-succes-200 bg-succes-50 p-5 text-sm text-succes-700">
          {t('Message envoyé. Nous te répondrons à', 'Message sent. We will reply to')} {session.email}.
          <button onClick={() => { setSent(false); setSubject(''); setMessage(''); }} className="ml-2 font-medium underline hover:no-underline">{t('Envoyer un autre message', 'Send another message')}</button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4 rounded-carte border border-ink-200 bg-white p-5">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-500">{t('Sujet', 'Subject')}</label>
            <input required maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} className={inputCls} placeholder={t("Ex. Problème d'envoi de campagne", 'E.g. Campaign sending issue')} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-500">{t('Message', 'Message')}</label>
            <textarea required maxLength={5000} rows={6} value={message} onChange={(e) => setMessage(e.target.value)} className={inputCls} placeholder={t('Décris ta demande…', 'Describe your request…')} />
          </div>
          {error && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}
          <Bouton enCours={busy}
            type="submit"
            disabled={busy || subject.trim() === '' || message.trim() === ''}
          >
            {busy ? t('Envoi…', 'Sending…') : t('Envoyer', 'Send')}
          </Bouton>
        </form>
      )}
    </div>
  );
}
