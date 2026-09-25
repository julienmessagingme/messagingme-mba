'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import type { Session } from '@/lib/session';
import {
  listEmailTemplates, createEmailTemplate, updateEmailTemplate, deleteEmailTemplate, listUserFields,
  type EmailTemplate, type EmailTemplateInput, type UserFieldDef,
} from '@/lib/api';
import { ChampCorpsVariables } from '@/components/ChampCorpsVariables';
import { SelecteurVariable } from '@/components/SelecteurVariable';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { Bouton } from '@/components/Bouton';
import { IntroPage, TitrePage } from '@/components/TitrePage';
import { BoutonConfirme } from '@/components/Confirmation';
import { Squelette } from '@/components/Squelette';

/**
 * Contenu > Modeles d'email : les modeles utilises par le node « Envoi de mail » des scenarios. Deux formats
 * (texte simple / HTML brut), sujet et corps acceptant des variables `{{champ}}` substituees a l'envoi
 * (`src/crm/render.ts`).
 *
 * Les variables s'inserent par LE selecteur partage (`SelecteurVariable`), jamais en faisant recopier
 * `{{prenom}}` a la main. L'en-tete de ce fichier affirmait le contraire jusqu'au 2026-08-25 (« pas de
 * composant chip dedie comme VariableBodyEditor, qui porte les variables POSITIONNELLES ») : c'etait vrai le
 * 19 aout, et faux depuis le 24, date a laquelle cet editeur a ete rendu parametrable par `varPattern` et a
 * exporte `NAMED_VAR_RE` en citant explicitement le modele d'email. La page n'avait jamais ete repassee.
 *
 * Trois surfaces, UN seul selecteur : le sujet (champ d'une ligne) et le corps HTML (zone de code) recoivent
 * le jeton au curseur ; le corps en format Texte passe par l'editeur a chips. Le HTML n'y passe PAS
 * volontairement : un `contenteditable` resérialise le DOM et abimerait un mail colle depuis un outil externe.
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
    setError(null);
    try {
      await deleteEmailTemplate(session.tenantId, m.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Suppression impossible', 'Unable to delete'));
    }
  }

  /**
   * Insere `{{cle}}` a la position du curseur d'une surface TEXTE (le sujet, ou le corps en format HTML).
   * Le corps en format Texte n'passe pas par ici : il a son propre editeur a chips.
   *
   * Chaque surface porte son PROPRE bouton, donc plus de « dernier champ actif » a deviner : ce mecanisme
   * inserait dans le sujet quand on croyait ecrire dans le corps.
   */
  function insererDans(surface: 'subject' | 'body', cle: string) {
    const token = `{{${cle}}}`;
    const cible = surface === 'subject' ? subjectRef.current : bodyRef.current;
    if (!cible) return;
    const start = cible.selectionStart ?? cible.value.length;
    const end = cible.selectionEnd ?? cible.value.length;
    const suite = cible.value.slice(0, start) + token + cible.value.slice(end);
    setForm((f) => (surface === 'subject' ? { ...f, subject: suite } : { ...f, body: suite }));
    const caret = start + token.length;
    requestAnimationFrame(() => { cible.focus(); cible.setSelectionRange(caret, caret); });
  }

  return (
    <div className="max-w-formulaire space-y-6">
      <div>
        <TitrePage>{t('Modèles d’email', 'Email templates')}</TitrePage>
        <IntroPage>
          {t(
            'Le node « Envoi de mail » d’un scénario choisit un de ces modèles. Sujet et corps acceptent des variables {{champ}}, remplacées par la fiche du contact à l’envoi.',
            'The "Send email" scenario block picks one of these templates. Subject and body accept {{field}} variables, filled in from the contact at send time.',
          )}
        </IntroPage>
      </div>
      {error && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}

      {editing ? (
        <div className="space-y-3 rounded-carte border border-ink-200 bg-white p-5">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-500">{t('Nom', 'Name')}</label>
            <input data-testid="email-template-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={inputCls} placeholder={t('Confirmation de commande', 'Order confirmation')} />
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-ink-500">{t('Format', 'Format')}</span>
            <div className="inline-flex overflow-hidden rounded-controle border border-ink-200 text-xs">
              <button type="button" data-testid="email-template-format-basic" onClick={() => setForm((f) => ({ ...f, format: 'basic' }))} className={`px-3 py-1.5 font-medium transition-colors duration-150 ${form.format === 'basic' ? 'bg-brand-600 text-white' : 'text-ink-500 hover:bg-ink-50'}`}>
                {t('Texte simple', 'Plain text')}
              </button>
              <button type="button" data-testid="email-template-format-html" onClick={() => setForm((f) => ({ ...f, format: 'html' }))} className={`px-3 py-1.5 font-medium transition-colors duration-150 ${form.format === 'html' ? 'bg-brand-600 text-white' : 'text-ink-500 hover:bg-ink-50'}`}>
                {t('HTML', 'HTML')}
              </button>
            </div>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <label className="block text-xs font-medium text-ink-500">{t('Sujet', 'Subject')}</label>
              <SelecteurVariable
                fields={fields}
                testId="email-template-subject-variable"
                ancrage="haut"
                onInsert={(cle) => insererDans('subject', cle)}
              />
            </div>
            <input
              data-testid="email-template-subject"
              ref={subjectRef}
              value={form.subject}
              onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
              className={inputCls}
              placeholder={t('Bonjour Camille…', 'Hello Camille…')}
            />
          </div>
          {form.format === 'html' ? (
            <div>
              {/* Zone de CODE, pas d'editeur a chips : un contenteditable resérialise le DOM et abimerait un
                  HTML colle depuis un outil externe. Le selecteur, lui, est le meme qu'ailleurs. */}
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="block text-xs font-medium text-ink-500">{t('Corps (HTML brut)', 'Body (raw HTML)')}</label>
                <SelecteurVariable
                  fields={fields}
                  testId="email-template-body-variable"
                  ancrage="haut"
                  onInsert={(cle) => insererDans('body', cle)}
                />
              </div>
              <textarea
                data-testid="email-template-body"
                ref={bodyRef}
                value={form.body}
                onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
                rows={10}
                className={`${inputCls} font-mono text-xs`}
                placeholder={'<p>Bonjour ,</p>'}
              />
            </div>
          ) : (
            <ChampCorpsVariables
              valeur={form.body}
              onChange={(body) => setForm((f) => ({ ...f, body }))}
              fields={fields}
              label={t('Corps', 'Body')}
              testId="email-template-body"
              placeholder={t('Le corps du message…', 'The message body…')}
            />
          )}
          <div className="flex justify-end gap-2">
            <button onClick={cancelEdit} className="rounded-controle px-3 py-2 text-sm text-ink-500 hover:text-ink-900">{t('Annuler', 'Cancel')}</button>
            <Bouton enCours={busy}
              data-testid="email-template-save"
              onClick={() => void save()}
              disabled={busy || !form.name.trim() || !form.subject.trim() || !form.body.trim()}
            >
              {busy ? t('Enregistrement…', 'Saving…') : t('Enregistrer', 'Save')}
            </Bouton>
          </div>
        </div>
      ) : (
        <Bouton onClick={startCreate}>{t('+ Nouveau modèle', '+ New template')}</Bouton>
      )}

      <div className="overflow-hidden rounded-carte border border-ink-200 bg-white">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-semibold text-ink-900">{t('Modèles', 'Templates')} ({items.length})</div>
        {loading ? (
          <Squelette forme="lignes" className="px-5 py-6" />
        ) : items.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Aucun modèle : créez-en un ci-dessus.', 'No template yet: create one above.')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs text-ink-500">
                <th className="px-5 py-2 font-medium">{t('Nom', 'Name')}</th>
                <th className="px-5 py-2 font-medium">{t('Format', 'Format')}</th>
                <th className="px-5 py-2 font-medium">{t('Sujet', 'Subject')}</th>
                <th className="px-5 py-2 text-right font-medium">{t('Actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id} className="border-b border-ink-50 last:border-0">
                  <td className="px-5 py-3 font-medium text-ink-900">{m.name}</td>
                  <td className="px-5 py-3 text-ink-500">{m.format === 'html' ? 'HTML' : t('Texte', 'Text')}</td>
                  <td className="max-w-xs truncate px-5 py-3 text-ink-500">{m.subject}</td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button onClick={() => startEdit(m)} className="text-ink-500 hover:text-ink-900">{t('Modifier', 'Edit')}</button>
                      <BoutonConfirme question={t(`Supprimer « ${m.name} » ?`, `Delete "${m.name}"?`)} onConfirme={() => void remove(m)} libelleConfirmer={t('Supprimer', 'Delete')} className="text-danger hover:text-danger-700">{t('Supprimer', 'Delete')}</BoutonConfirme>
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
