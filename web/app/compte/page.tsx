'use client';

import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { changePassword } from '@/lib/api';
import type { Session } from '@/lib/session';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { MIN_MOT_DE_PASSE, aideMotDePasse } from '@/lib/mot-de-passe';
import { Bouton } from '@/components/Bouton';
import { TitrePage } from '@/components/TitrePage';

/**
 * MON COMPTE, DANS LA COQUILLE DE LA CONSOLE (passe 2, 2026-09-25). La page vivait seule, avec un lien
 * « ← Retour » : on quittait la console pour changer un mot de passe, et on la retrouvait en rechargeant la
 * page d'arrivée. Elle garde son contenu, et tous les rôles y ont accès (`accesAutorise`).
 */
export default function ComptePage() {
  return <AppShell active="compte">{(session) => <Compte session={session} />}</AppShell>;
}

function Compte({ session }: { session: Session }) {
  const t = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setLoading(true);
    try {
      await changePassword(current, next);
      setMsg({ kind: 'ok', text: t('Mot de passe mis à jour.', 'Password updated.') });
      setCurrent('');
      setNext('');
    } catch (err) {
      setMsg({ kind: 'err', text: err instanceof Error ? err.message : t('Changement impossible', 'Unable to change password') });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-formulaire">
      <TitrePage>{t('Mon compte', 'My account')}</TitrePage>
      <p className="mt-1 text-sm text-ink-500">{session.email}</p>

      <form onSubmit={onSubmit} className="mt-6 max-w-md space-y-4 rounded-carte border border-ink-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-ink-900">{t('Changer le mot de passe', 'Change password')}</h2>
        <div>
          <label className="mb-1 block text-sm font-medium text-ink-900">{t('Mot de passe actuel', 'Current password')}</label>
          <input type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-ink-900">{t('Nouveau mot de passe', 'New password')}</label>
          <input type="password" required minLength={MIN_MOT_DE_PASSE} value={next} onChange={(e) => setNext(e.target.value)} className={inputCls} placeholder={t(aideMotDePasse().fr, aideMotDePasse().en)} />
        </div>
        {msg && <p className={`rounded-controle px-3 py-2 text-sm ${msg.kind === 'ok' ? 'bg-succes-50 text-succes-800' : 'bg-danger-50 text-danger-700'}`}>{msg.text}</p>}
        <Bouton enCours={loading} type="submit" disabled={loading} className="w-full">
          {loading ? t('Mise à jour...', 'Updating...') : t('Mettre à jour', 'Update')}
        </Bouton>
      </form>
    </div>
  );
}
