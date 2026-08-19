'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import {
  listEmailTemplates, createEmailTemplate, updateEmailTemplate, deleteEmailTemplate, listUserFields,
  type EmailTemplate, type EmailTemplateInput, type UserFieldDef,
} from '@/lib/api';
import { emailResolvableFields } from '@/lib/fields';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';

/**
 * Contenu > Modèles d'email : les modèles utilisés par le node « Envoi de mail » des scénarios. Deux formats
 * (texte simple / HTML brut), sujet et corps acceptant des variables `{{champ}}` substituées à l'envoi
 * (`src/crm/render.ts`). Les chips « insérer une variable » écrivent au curseur du dernier champ actif (sujet
 * ou corps) : pas de composant chip dédié comme `VariableBodyEditor` (qui porte les variables POSITIONNELLES
 * `{{n}}` des templates Meta, un contrat différent des variables NOMMÉES `{{champ}}` de l'email).
 */
export default function EmailTemplatesPage() {
  return <AppShell active="email-templates">{(session) => <EmailTemplatesInner session={session} />}</AppShell>;
}

const EMPTY: EmailTemplateInput = { name: '', format: 'basic', subject: '', body: '' };

function EmailTemplatesInner({ session }: { session: Session }) {
  const t = useT();
  const [items, setItems] = useState<EmailTemplate[]>([]);
  const [fields, setFields] = useState<UserFieldDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<EmailTemplateInput>(EMPTY);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [busy, setBusy] = useState(false);
  const subjectRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // Dernier champ ayant reçu le focus : c'est là qu'une variable cliquée s'insère.
  const lastFocused = useRef<'subject' | 'body'>('body');

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems((await listEmailTemplates(session.tenantId)).templates);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { listUserFields(session.tenantId).then((r) => setFields(r.fields)).catch(() => {}); }, [session.tenantId]);

  const variables = emailResolvableFields(fields);

  function startCreate() { setEditing('new'); setForm(EMPTY); }
  function startEdit(m: EmailTemplate) { setEditing(m.id); setForm({ name: m.name, format: m.format, subject: m.subject, body: m.body }); }
  function cancelEdit() { setEditing(null); setForm(EMPTY); }

  async function save() {
    if (!form.name.trim() || !form.subject.trim() || !form.body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (editing && editing !== 'new') await updateEmailTemplate(session.tenantId, editing, form);
      else await createEmailTemplate(session.tenantId, form);
      cancelEdit();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Enregistrement impossible', 'Unable to save'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(m: EmailTemplate) {
    if (!window.confirm(t(`Supprimer le modèle « ${m.name} » ?`, `Delete template "${m.name}"?`))) return;
    setError(null);
    try {
      await deleteEmailTemplate(session.tenantId, m.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Suppression impossible', 'Unable to delete'));
    }
  }

  /** Insère `{{clé}}` à la position du curseur du dernier champ actif (sujet ou corps), garde le focus. */
  function insertVar(key: string) {
    const token = `{{${key}}}`;
    const target = lastFocused.current === 'subject' ? subjectRef.current : bodyRef.current;
    if (!target) return;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    const next = target.value.slice(0, start) + token + target.value.slice(end);
    if (lastFocused.current === 'subject') setForm((f) => ({ ...f, subject: next }));
    else setForm((f) => ({ ...f, body: next }));
    const caret = start + token.length;
    requestAnimationFrame(() => { target.focus(); target.setSelectionRange(caret, caret); });
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Modèles d’email', 'Email templates')}</h2>
        <p className="mt-1 text-sm text-ink-500">
          {t(
            'Le node « Envoi de mail » d’un scénario choisit un de ces modèles. Sujet et corps acceptent des variables {{champ}}, remplacées par la fiche du contact à l’envoi.',
            'The "Send email" scenario block picks one of these templates. Subject and body accept {{field}} variables, filled in from the contact at send time.',
          )}
        </p>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {editing ? (
        <div className="space-y-3 rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-600">{t('Nom', 'Name')}</label>
            <input data-testid="email-template-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={inputCls} placeholder={t('Confirmation de commande', 'Order confirmation')} />
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-ink-600">{t('Format', 'Format')}</span>
            <div className="inline-flex overflow-hidden rounded-lg border border-ink-200 text-xs">
              <button type="button" data-testid="email-template-format-basic" onClick={() => setForm((f) => ({ ...f, format: 'basic' }))} className={`px-3 py-1.5 font-medium transition ${form.format === 'basic' ? 'bg-brand-500 text-white' : 'text-ink-600 hover:bg-ink-50'}`}>
                {t('Texte simple', 'Plain text')}
              </button>
              <button type="button" data-testid="email-template-format-html" onClick={() => setForm((f) => ({ ...f, format: 'html' }))} className={`px-3 py-1.5 font-medium transition ${form.format === 'html' ? 'bg-brand-500 text-white' : 'text-ink-600 hover:bg-ink-50'}`}>
                {t('HTML', 'HTML')}
              </button>
            </div>
          </div>
          {variables.length > 0 && (
            <div>
              <span className="mb-1 block text-xs font-medium text-ink-600">{t('Insérer une variable (dans le champ actif)', 'Insert a variable (into the active field)')}</span>
              <div className="flex flex-wrap gap-1.5">
                {variables.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    data-testid={`email-template-var-${f.key}`}
                    onClick={() => insertVar(f.key)}
                    title={f.label}
                    className="rounded-full border border-ink-200 bg-ink-50 px-2 py-0.5 text-[11px] font-medium text-ink-700 hover:bg-brand-50 hover:text-brand-700"
                  >
                    {`{{${f.key}}}`}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-600">{t('Sujet', 'Subject')}</label>
            <input
              data-testid="email-template-subject"
              ref={subjectRef}
              value={form.subject}
              onFocus={() => { lastFocused.current = 'subject'; }}
              onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
              className={inputCls}
              placeholder={t('Bonjour {{prenom}}…', 'Hello {{prenom}}…')}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-600">{form.format === 'html' ? t('Corps (HTML brut)', 'Body (raw HTML)') : t('Corps', 'Body')}</label>
            <textarea
              data-testid="email-template-body"
              ref={bodyRef}
              value={form.body}
              onFocus={() => { lastFocused.current = 'body'; }}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              rows={form.format === 'html' ? 10 : 6}
              className={`${inputCls} ${form.format === 'html' ? 'font-mono text-xs' : ''}`}
              placeholder={form.format === 'html' ? '<p>Bonjour {{prenom}},</p>' : t('Le corps du message…', 'The message body…')}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={cancelEdit} className="rounded-lg px-3 py-2 text-sm text-ink-500 hover:text-ink-800">{t('Annuler', 'Cancel')}</button>
            <button
              data-testid="email-template-save"
              onClick={() => void save()}
              disabled={busy || !form.name.trim() || !form.subject.trim() || !form.body.trim()}
              className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {busy ? t('Enregistrement…', 'Saving…') : t('Enregistrer', 'Save')}
            </button>
          </div>
        </div>
      ) : (
        <button onClick={startCreate} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600">{t('+ Nouveau modèle', '+ New template')}</button>
      )}

      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-semibold text-ink-900">{t('Modèles', 'Templates')} ({items.length})</div>
        {loading ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
        ) : items.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Aucun modèle. Crée-en un ci-dessus.', 'No template yet. Create one above.')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-2 font-medium">{t('Nom', 'Name')}</th>
                <th className="px-5 py-2 font-medium">{t('Format', 'Format')}</th>
                <th className="px-5 py-2 font-medium">{t('Sujet', 'Subject')}</th>
                <th className="px-5 py-2 text-right font-medium">{t('Actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id} className="border-b border-ink-50 last:border-0">
                  <td className="px-5 py-3 font-medium text-ink-800">{m.name}</td>
                  <td className="px-5 py-3 text-ink-500">{m.format === 'html' ? 'HTML' : t('Texte', 'Text')}</td>
                  <td className="max-w-xs truncate px-5 py-3 text-ink-600">{m.subject}</td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button onClick={() => startEdit(m)} className="text-ink-600 hover:text-ink-900">{t('Modifier', 'Edit')}</button>
                      <button onClick={() => void remove(m)} className="text-coral hover:text-coral/80">{t('Supprimer', 'Delete')}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
