'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import {
  listEmailAccounts, createEmailAccount, updateEmailAccount, deleteEmailAccount, testEmailAccount,
  type EmailAccount, type EmailAccountInput,
} from '@/lib/api';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import { IntroPage, TitrePage } from '@/components/TitrePage';
import { useConfirmation } from '@/components/Confirmation';
import { Modale } from '@/components/Modale';
import { Squelette } from '@/components/Squelette';
import { erreurDeChargement } from '@/lib/http';
import { Icone } from '@/components/Icone';

/**
 * Écran « Boîtes email » (menu Compte, admin-only) : connecte une ou plusieurs boîtes SMTP, utilisées par le
 * node « Envoi de mail » des scénarios. Le mot de passe est chiffré côté serveur et n'est JAMAIS renvoyé : le
 * champ reste vide à l'édition, `hasPassword` sert juste d'indice « déjà défini ».
 */
export default function EmailAccountsPage() {
  return <AppShell active="email-accounts">{(session) => <EmailAccountsInner session={session} />}</AppShell>;
}

const EMPTY: EmailAccountInput = { label: '', host: '', port: 465, secure: true, username: '', password: '', fromAddress: '', fromName: '', replyTo: '' };

function EmailAccountsInner({ session }: { session: Session }) {
  const t = useT();
  const confirmer = useConfirmation();
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<EmailAccountInput>(EMPTY);
  // id du compte en édition, 'new' pour une création, null = formulaire fermé.
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const [testFor, setTestFor] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testMsg, setTestMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setAccounts((await listEmailAccounts(session.tenantId)).accounts);
    } catch (err) {
      setError(erreurDeChargement(err, t));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => { void load(); }, [load]);

  function startCreate() {
    setEditing('new');
    setForm(EMPTY);
  }
  function startEdit(a: EmailAccount) {
    setEditing(a.id);
    setForm({ label: a.label, host: a.host, port: a.port, secure: a.secure, username: a.username, password: '', fromAddress: a.fromAddress, fromName: a.fromName ?? '', replyTo: a.replyTo ?? '' });
  }
  function cancelEdit() {
    setEditing(null);
    setForm(EMPTY);
  }

  async function save() {
    const isNew = editing === 'new';
    if (!form.label.trim() || !form.host.trim() || !form.username.trim() || !form.fromAddress.trim()) return;
    if (isNew && !form.password.trim()) return; // création : mot de passe obligatoire
    setBusy(true);
    setError(null);
    try {
      const clean = { ...form, fromName: form.fromName?.trim() || null, replyTo: form.replyTo?.trim() || null };
      if (isNew) {
        await createEmailAccount(session.tenantId, clean);
      } else if (editing) {
        // Édition : mot de passe laissé vide -> on ne l'envoie pas du tout (il reste inchangé côté serveur).
        const { password, ...rest } = clean;
        await updateEmailAccount(session.tenantId, editing, password.trim() ? clean : rest);
      }
      cancelEdit();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Enregistrement impossible', 'Unable to save'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(a: EmailAccount) {
    if (!(await confirmer({ titre: t('Supprimer la boîte', 'Delete the mailbox'), message: t(
      `Supprimer la boîte « ${a.label} » ? Les scénarios qui l’utilisent resteront enregistrés mais n’enverront plus rien tant qu’une autre boîte n’est pas choisie.`,
      `Delete mailbox "${a.label}"? Scenarios using it stay saved but will stop sending until another mailbox is picked.`,
    ), confirmer: t('Supprimer', 'Delete') }))) return;
    setError(null);
    try {
      await deleteEmailAccount(session.tenantId, a.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Suppression impossible', 'Unable to delete'));
    }
  }

  function startTest(id: string) {
    setTestFor(id);
    setTestTo('');
    setTestMsg(null);
  }
  async function runTest() {
    if (!testFor || !testTo.trim()) return;
    setBusy(true);
    setTestMsg(null);
    try {
      await testEmailAccount(session.tenantId, testFor, testTo.trim());
      setTestMsg({ kind: 'ok', text: t('Email de test envoyé.', 'Test email sent.') });
      await load(); // rafraîchit la pastille « vérifiée »
    } catch (err) {
      setTestMsg({ kind: 'err', text: err instanceof Error ? err.message : t('Envoi impossible', 'Unable to send') });
    } finally {
      setBusy(false);
    }
  }

  const isNew = editing === 'new';

  return (
    <div className="max-w-formulaire space-y-6">
      <div>
        <TitrePage>{t('Boîtes email (SMTP)', 'Email accounts (SMTP)')}</TitrePage>
        <IntroPage>
          {t(
            'Elles envoient les mails du bloc « Envoi de mail » des scénarios. Le mot de passe est chiffré et ne se réaffiche plus une fois enregistré.',
            'They send the emails of the "Send email" scenario block. The password is encrypted and is never shown again once saved.',
          )}
        </IntroPage>
      </div>
      {error && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}

      {editing ? (
        <AccountForm form={form} setForm={setForm} isNew={isNew} busy={busy} onSave={() => void save()} onCancel={cancelEdit} />
      ) : (
        <Bouton onClick={startCreate}>
          <Icone nom="ajouter" />{t('Connecter une boîte', 'Connect a mailbox')}
        </Bouton>
      )}

      <div className="overflow-hidden rounded-carte border border-ink-200 bg-white">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-semibold text-ink-900">{t('Boîtes', 'Mailboxes')} ({accounts.length})</div>
        {loading ? (
          <Squelette forme="lignes" className="px-5 py-6" />
        ) : accounts.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">
            {t('Aucune boîte connectée : connectez-en une ci-dessus pour activer le bloc « Envoi de mail ».', 'No mailbox connected: connect one above to enable the “Send email” block.')}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs text-ink-500">
                <th className="px-5 py-2 font-medium">{t('Libellé', 'Label')}</th>
                <th className="px-5 py-2 font-medium">{t('Adresse d’envoi', 'Sending address')}</th>
                <th className="px-5 py-2 font-medium">{t('Statut', 'Status')}</th>
                <th className="px-5 py-2 text-right font-medium">{t('Actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="border-b border-ink-50 last:border-0">
                  <td className="px-5 py-3 font-medium text-ink-900">{a.label}</td>
                  <td className="px-5 py-3 text-ink-500">{a.fromAddress}</td>
                  <td className="px-5 py-3">
                    {a.verifiedAt ? (
                      <span className="inline-flex items-center rounded-full bg-succes-50 px-2 py-0.5 text-xs font-medium text-succes-700">{t('Vérifiée', 'Verified')}</span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-500">{t('Non testée', 'Not tested')}</span>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex items-center justify-end gap-3">
                      <button onClick={() => startTest(a.id)} className="text-brand-600 hover:underline">{t('Tester', 'Test')}</button>
                      <button onClick={() => startEdit(a)} className="text-ink-500 hover:text-ink-900">{t('Modifier', 'Edit')}</button>
                      <button onClick={() => void remove(a)} className="text-danger hover:text-danger-500">{t('Supprimer', 'Delete')}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {testFor && (
        <Modale titre={t('Envoyer un test', 'Send a test')} taille="petite" onClose={() => setTestFor(null)}>
          <label className="mb-1 mt-4 block text-xs font-medium text-ink-500">{t('Adresse de destination', 'Destination address')}</label>
          <input
            type="email"
            autoFocus
            value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            className={inputCls}
            placeholder={t('vous@exemple.fr', 'you@example.com')}
          />
          {testMsg && (
            <p className={`mt-3 rounded-controle px-3 py-2 text-sm ${testMsg.kind === 'ok' ? 'bg-succes-50 text-succes-700' : 'bg-danger-50 text-danger-700'}`}>{testMsg.text}</p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => setTestFor(null)} className="rounded-controle px-3 py-2 text-sm text-ink-500 hover:text-ink-900">{t('Fermer', 'Close')}</button>
            <Bouton enCours={busy}
              onClick={() => void runTest()}
              disabled={busy || !testTo.trim()}
            >
              {busy ? t('Envoi…', 'Sending…') : t('Envoyer', 'Send')}
            </Bouton>
          </div>
        </Modale>
      )}
    </div>
  );
}

function AccountForm({ form, setForm, isNew, busy, onSave, onCancel }: {
  form: EmailAccountInput;
  setForm: (updater: (f: EmailAccountInput) => EmailAccountInput) => void;
  isNew: boolean;
  busy: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const canSave = form.label.trim() !== '' && form.host.trim() !== '' && form.username.trim() !== '' && form.fromAddress.trim() !== '' && (!isNew || form.password.trim() !== '');

  return (
    <div className="space-y-3 rounded-carte border border-ink-200 bg-white p-5">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-500">{t('Libellé', 'Label')}</label>
          <input data-testid="email-account-label" value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} className={inputCls} placeholder={t('Support', 'Support')} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-500">{t('Adresse d’envoi', 'Sending address')}</label>
          <input data-testid="email-account-from" type="email" value={form.fromAddress} onChange={(e) => setForm((f) => ({ ...f, fromAddress: e.target.value }))} className={inputCls} placeholder="support@exemple.fr" />
        </div>
      </div>
      <div className="flex flex-wrap gap-3">
        <div className="min-w-[220px] flex-1">
          <label className="mb-1 block text-xs font-medium text-ink-500">{t('Hôte SMTP', 'SMTP host')}</label>
          <input data-testid="email-account-host" value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} className={inputCls} placeholder="ssl0.ovh.net" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-500">{t('Port', 'Port')}</label>
          <input
            data-testid="email-account-port"
            type="number"
            min={1}
            max={65535}
            value={form.port}
            onChange={(e) => setForm((f) => ({ ...f, port: Math.max(1, Math.min(65535, Math.floor(Number(e.target.value) || 1))) }))}
            className={`${inputCls} w-24`}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-500">{t('TLS', 'TLS')}</label>
          <select
            data-testid="email-account-secure"
            value={form.secure ? '1' : '0'}
            onChange={(e) => setForm((f) => ({ ...f, secure: e.target.value === '1' }))}
            className="rounded-controle border border-ink-300 bg-white px-2 py-2 text-sm text-ink-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
          >
            <option value="1">{t('Oui (465)', 'Yes (465)')}</option>
            <option value="0">{t('Non (587/25)', 'No (587/25)')}</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-500">{t('Identifiant', 'Username')}</label>
          <input data-testid="email-account-username" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} className={inputCls} placeholder="support@exemple.fr" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-500">{t('Mot de passe', 'Password')}</label>
          <input
            data-testid="email-account-password"
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            className={inputCls}
            placeholder={isNew ? '' : t('inchangé si laissé vide', 'unchanged if left blank')}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-500">{t('Nom affiché (optionnel)', 'Display name (optional)')}</label>
          <input data-testid="email-account-fromname" value={form.fromName ?? ''} onChange={(e) => setForm((f) => ({ ...f, fromName: e.target.value }))} className={inputCls} placeholder={t('Support Exemple', 'Example Support')} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-500">{t('Reply-to (optionnel)', 'Reply-to (optional)')}</label>
          <input data-testid="email-account-replyto" type="email" value={form.replyTo ?? ''} onChange={(e) => setForm((f) => ({ ...f, replyTo: e.target.value }))} className={inputCls} placeholder="contact@exemple.fr" />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="rounded-controle px-3 py-2 text-sm text-ink-500 hover:text-ink-900">{t('Annuler', 'Cancel')}</button>
        <Bouton enCours={busy} data-testid="email-account-save" onClick={onSave} disabled={busy || !canSave}>
          {busy ? t('Enregistrement…', 'Saving…') : t('Enregistrer', 'Save')}
        </Bouton>
      </div>
    </div>
  );
}
