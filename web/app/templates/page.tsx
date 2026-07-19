'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { WhatsAppPreview } from '@/components/WhatsAppPreview';
import { CarouselForm } from '@/components/CarouselForm';
import { TemplateForm } from '@/components/TemplateForm';
import type { Session } from '@/lib/session';
import { listTemplates, deleteTemplate, type TemplateSummary } from '@/lib/api';
import { useT } from '@/lib/i18n';

export default function TemplatesPage() {
  return <AppShell active="templates">{(session) => <TemplatesInner session={session} />}</AppShell>;
}

const STATUS: Record<string, string> = {
  APPROVED: 'bg-emerald-50 text-emerald-700',
  PENDING: 'bg-amber-50 text-amber-700',
  REJECTED: 'bg-red-50 text-red-700',
};


function TemplatesInner({ session }: { session: Session }) {
  const t = useT();
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'simple' | 'carousel'>('simple');
  const [editing, setEditing] = useState<TemplateSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<TemplateSummary | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      setTemplates((await listTemplates(session.tenantId)).templates);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function remove(tpl: TemplateSummary) {
    if (!window.confirm(`${t('Supprimer le template', 'Delete template')} « ${tpl.name} » ?\n${t("Suppression définitive chez Meta (toutes les langues). Bloquée si une campagne active l'utilise.", 'Permanent deletion at Meta (all languages). Blocked if an active campaign uses it.')}`)) return;
    setError(null);
    try {
      await deleteTemplate(session.tenantId, tpl.name);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Suppression impossible', 'Unable to delete'));
    }
  }

  return (
    <div className="space-y-6">
      {editing ? (
        <section className="rounded-2xl border border-brand-200 bg-brand-50/40 p-6 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Modifier', 'Edit')} « {editing.name} »</h2>
            <button onClick={() => setEditing(null)} className="text-xs text-ink-400 hover:text-ink-700">{t('Fermer', 'Close')}</button>
          </div>
          <p className="mb-4 rounded-lg bg-gold/10 px-3 py-2 text-xs text-gold">{t('Modifier un template le renvoie en validation Meta (statut PENDING) : il est inenvoyable le temps de la re-validation. Le nom et la langue ne sont pas modifiables.', 'Editing a template sends it back to Meta for review (PENDING status): it stays unsendable until re-approval. Name and language cannot be changed.')}</p>
          <TemplateForm key={editing.name} tenantId={session.tenantId} onCreated={() => { void reload(); setEditing(null); }} initial={editing} />
        </section>
      ) : creating ? (
        <section className="rounded-2xl border border-brand-200 bg-brand-50/40 p-6 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Nouveau template', 'New template')}</h2>
            <button onClick={() => setCreating(false)} className="text-xs text-ink-400 hover:text-ink-700">{t('Fermer', 'Close')}</button>
          </div>
          <div className="mb-4 inline-flex gap-1 rounded-lg bg-ink-100 p-1 text-xs">
            {(['simple', 'carousel'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded-md px-3 py-1 ${mode === m ? 'bg-white font-medium text-brand-700 shadow-sm' : 'text-ink-500 hover:text-ink-800'}`}
              >
                {m === 'simple' ? t('Template simple', 'Simple template') : 'Carousel'}
              </button>
            ))}
          </div>
          {mode === 'simple' ? (
            <TemplateForm tenantId={session.tenantId} onCreated={() => { void reload(); setCreating(false); }} />
          ) : (
            <CarouselForm tenantId={session.tenantId} onCreated={() => { void reload(); setCreating(false); }} />
          )}
        </section>
      ) : null}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Templates', 'Templates')} ({templates.length})</h2>
          <div className="flex items-center gap-3">
            <button onClick={reload} className="text-xs text-brand-600 hover:underline">{t('Rafraîchir', 'Refresh')}</button>
            {!creating && !editing && (
              <button onClick={() => setCreating(true)} className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600">{t('+ Créer un template', '+ Create a template')}</button>
            )}
          </div>
        </div>
        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {loading ? (
          <p className="text-sm text-ink-500">{t('Chargement...', 'Loading...')}</p>
        ) : templates.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-ink-300 bg-white px-4 py-10 text-center text-sm text-ink-500">
            {t("Aucun template. Clique « + Créer un template » (il passe en revue Meta avant d'être utilisable).", 'No templates yet. Click « + Create a template » (it goes through Meta review before it can be used).')}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-ink-200 bg-white shadow-sm">
            <table className="w-full min-w-[520px] text-sm">
              <thead className="bg-ink-50 text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{t('Nom', 'Name')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('Catégorie', 'Category')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('Langue', 'Language')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('Statut', 'Status')}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{t('Actions', 'Actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {templates.map((tpl) => (
                  <tr key={`${tpl.name}-${tpl.language}`} className="hover:bg-ink-50">
                    <td className="px-4 py-2.5">
                      <button onClick={() => setPreview(tpl)} className="font-mono text-xs font-medium text-brand-600 hover:underline" title={t("Voir l'aperçu", 'View preview')}>{tpl.name}</button>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-ink-500">{tpl.category?.toLowerCase()}</td>
                    <td className="px-4 py-2.5 text-xs">{tpl.language}</td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS[tpl.status] ?? 'bg-ink-100 text-ink-600'}`}>
                        {tpl.status?.toLowerCase()}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-3 text-xs">
                        {tpl.editable === false ? (
                          <span className="text-ink-300" title={tpl.isCarousel ? t("Édition d'un carousel non supportée", 'Editing a carousel is not supported') : t("Édition non supportée : en-tête ou pied de page (il serait supprimé)", 'Editing not supported: header or footer (it would be removed)')}>{t('Éditer', 'Edit')}</span>
                        ) : (
                          <button onClick={() => setEditing(tpl)} className="font-medium text-brand-600 hover:text-brand-700">{t('Éditer', 'Edit')}</button>
                        )}
                        <button onClick={() => remove(tpl)} className="font-medium text-coral hover:text-red-700">{t('Supprimer', 'Delete')}</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {preview && <TemplatePreviewModal template={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** Aperçu WhatsApp d'un template au clic sur son nom (corps + boutons ; carousel/média = note). */
function TemplatePreviewModal({ template, onClose }: { template: TemplateSummary; onClose: () => void }) {
  const t = useT();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h3 className="font-mono text-sm font-semibold text-ink-900">{template.name}</h3>
            <p className="text-xs text-ink-400">{template.category?.toLowerCase()} · {template.language} · {template.status?.toLowerCase()}</p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-ink-400 hover:text-ink-700">×</button>
        </div>
        {template.isCarousel ? (
          <div className="rounded-lg bg-ink-50 px-3 py-4 text-sm text-ink-600">
            <p className="font-medium">{t('Template carousel', 'Carousel template')}</p>
            <p className="mt-1 text-ink-500">{template.body || t('Message d’introduction non chargé.', 'Introduction message not loaded.')}</p>
          </div>
        ) : (
          <WhatsAppPreview
            body={template.body ?? ''}
            examples={template.example ?? []}
            buttons={template.buttons ?? []}
            header={template.headerFormat ? { format: template.headerFormat, text: template.headerText } : null}
            footer={template.footer}
            hideNote
          />
        )}
        {template.headerFormat && template.headerFormat !== 'TEXT' && !template.isCarousel && (
          <p className="mt-2 text-[11px] text-ink-400">{t('En-tête', 'Header')} {template.headerFormat.toLowerCase()} {t("(le média réel s'affiche à l'envoi).", '(the actual media is shown when sending).')}</p>
        )}
      </div>
    </div>
  );
}
