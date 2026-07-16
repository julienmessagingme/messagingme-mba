'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { FlowBuilder } from '@/components/FlowBuilder';
import { FlowScreen, fromFlowElements } from '@/components/FlowScreen';
import type { Session } from '@/lib/session';
import { listFlows, publishFlow, duplicateFlow, deleteFlow, type FlowSummary } from '@/lib/api';
import { useT } from '@/lib/i18n';

export default function FlowsPage() {
  return <AppShell active="flows">{(session) => <FlowsInner session={session} />}</AppShell>;
}

function FlowsInner({ session }: { session: Session }) {
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<FlowSummary | null>(null);
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<FlowSummary | null>(null);
  const t = useT();

  const load = useCallback(async (): Promise<FlowSummary[]> => {
    setError(null);
    try {
      const { flows } = await listFlows(session.tenantId);
      setFlows(flows);
      return flows;
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
      return [];
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function publish(f: FlowSummary) {
    if (!window.confirm(
      t('Publier le formulaire « ', 'Publish the form « ') + f.name +
      t(" » ?\nUn formulaire publié ne peut plus être modifié (irréversible côté Meta). Pour changer les champs, il faudra « Dupliquer pour modifier ».",
        " » ?\nA published form can no longer be edited (irreversible on the Meta side). To change the fields, you will need to « Duplicate to edit ».")
    )) return;
    setError(null);
    const prev = flows;
    setFlows((list) => list.map((x) => (x.id === f.id ? { ...x, status: 'PUBLISHED' } : x))); // optimiste
    try {
      await publishFlow(session.tenantId, f.id);
    } catch (err) {
      setFlows(prev);
      setError(err instanceof Error ? err.message : t('Publication impossible', 'Publishing failed'));
    }
  }

  async function duplicate(f: FlowSummary) {
    setError(null);
    try {
      const res = await duplicateFlow(session.tenantId, f.id);
      const list = await load();
      const created = list.find((x) => x.id === res.id);
      if (created) setEditing(created); // ouvre le nouveau DRAFT pour modification immédiate
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Duplication impossible', 'Duplication failed'));
    }
  }

  async function remove(f: FlowSummary) {
    const msg = f.status === 'PUBLISHED'
      ? t('Supprimer le formulaire publié « ', 'Delete the published form « ') + f.name +
        t(" » ?\nUn formulaire publié ne se supprime pas chez Meta : il est DÉPRÉCIÉ (retiré de l'usage). S'il est encore rattaché à un template, Meta peut refuser.",
          " » ?\nA published form cannot be deleted on Meta: it is DEPRECATED (removed from use). If it is still attached to a template, Meta may refuse.")
      : t('Supprimer le brouillon « ', 'Delete the draft « ') + f.name + ' » ?';
    if (!window.confirm(msg)) return;
    setError(null);
    const prev = flows;
    setFlows((list) => list.filter((x) => x.id !== f.id)); // optimiste
    if (preview?.id === f.id) setPreview(null);
    if (editing?.id === f.id) setEditing(null);
    try {
      await deleteFlow(session.tenantId, f.id);
    } catch (err) {
      setFlows(prev);
      setError(err instanceof Error ? err.message : t('Suppression impossible', 'Deletion failed'));
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Formulaires', 'Forms')}</h2>
        <p className="mt-1 text-sm text-ink-500">{t("Formulaires WhatsApp riches (titres, images, tous types de champs : saisie, choix, date, consentement) avec bouton final personnalisable : le client remplit dans WhatsApp, chaque champ se range dans une fiche contact, la réponse arrive dans l'inbox. Attache un formulaire publié à un template via un bouton « Flow ».", 'Rich WhatsApp forms (titles, images, all field types: text input, choice, date, consent) with a customizable final button: the customer fills it in inside WhatsApp, each field is saved to a contact record, and the response lands in the inbox. Attach a published form to a template through a « Flow » button.')}</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {editing ? (
        <div className="rounded-2xl border border-brand-200 bg-brand-50/40 p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-ink-900">{t('Modifier « ', 'Edit « ')}{editing.name} » <span className="ml-2 text-xs font-normal text-ink-400">({t('brouillon', 'draft')})</span></div>
            <button onClick={() => setEditing(null)} className="text-xs text-ink-400 hover:text-ink-700">{t('Fermer', 'Close')}</button>
          </div>
          <FlowBuilder
            key={editing.id}
            tenantId={session.tenantId}
            mode="edit"
            flowId={editing.id}
            initialName={editing.name}
            initialElements={editing.elements}
            initialMapping={editing.mapping}
            initialCta={editing.cta}
            onCreated={() => { void load(); setEditing(null); }}
          />
        </div>
      ) : creating ? (
        <div className="rounded-2xl border border-brand-200 bg-brand-50/40 p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-ink-900">{t('Nouveau formulaire', 'New form')}</div>
            <button onClick={() => setCreating(false)} className="text-xs text-ink-400 hover:text-ink-700">{t('Fermer', 'Close')}</button>
          </div>
          <FlowBuilder tenantId={session.tenantId} onCreated={() => { void load(); setCreating(false); }} />
        </div>
      ) : null}

      <div>
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold text-ink-900">{t('Formulaires', 'Forms')} ({flows.length})</span>
          {!creating && !editing && (
            <button onClick={() => setCreating(true)} className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600">{t('+ Créer un formulaire', '+ Create a form')}</button>
          )}
        </div>
        {loading ? (
          <p className="text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
        ) : flows.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-ink-300 bg-white px-4 py-10 text-center text-sm text-ink-500">{t("Aucun formulaire pour l'instant.", 'No forms yet.')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {flows.map((f) => <FlowCard key={f.id} flow={f} onPreview={() => setPreview(f)} onEdit={() => setEditing(f)} onPublish={() => publish(f)} onDuplicate={() => duplicate(f)} onDelete={() => remove(f)} />)}
          </div>
        )}
      </div>
      {preview && <FlowPreviewModal flow={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

/** Carte de la galerie : miniature du vrai écran WhatsApp (peek du haut), nom dessous, statut + actions. */
function FlowCard({ flow: f, onPreview, onEdit, onPublish, onDuplicate, onDelete }: {
  flow: FlowSummary;
  onPreview: () => void; onEdit: () => void; onPublish: () => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const t = useT();
  const hasElements = !!f.elements && f.elements.length > 0;
  return (
    <div className="flex flex-col rounded-2xl border border-ink-200 bg-white p-3 shadow-sm transition hover:border-brand-300">
      <button onClick={onPreview} title={t("Voir l'aperçu", 'View preview')} className="mb-2 block overflow-hidden rounded-xl border border-ink-100 bg-ink-50">
        <div className="pointer-events-none h-44 overflow-hidden">
          {hasElements
            ? <FlowScreen elements={fromFlowElements(f.elements!)} cta={f.cta} title={f.name} />
            : <div className="flex h-full items-center justify-center px-3 text-center text-[11px] text-ink-400">{t('Aperçu indisponible (formulaire ancien)', 'Preview unavailable (legacy form)')}</div>}
        </div>
      </button>
      <div className="flex items-center gap-2">
        <button onClick={onPreview} className="min-w-0 flex-1 truncate text-left text-sm font-medium text-ink-900 hover:text-brand-600" title={f.name}>{f.name}</button>
        {f.status === 'PUBLISHED'
          ? <span className="shrink-0 rounded-full bg-mint-50 px-2 py-0.5 text-[11px] font-medium text-mint-700">{t('Publié', 'Published')}</span>
          : <span className="shrink-0 rounded-full bg-gold/10 px-2 py-0.5 text-[11px] font-medium text-gold">{t('Brouillon', 'Draft')}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {f.status === 'DRAFT' ? (
          <>
            {hasElements
              ? <button onClick={onEdit} className="font-medium text-brand-600 hover:text-brand-700">{t('Éditer', 'Edit')}</button>
              : <span className="text-ink-300" title={t('Formulaire antérieur au modèle riche : à recréer', 'Form predates the rich model: must be recreated')}>{t('Éditer', 'Edit')}</span>}
            <button onClick={onPublish} className="font-medium text-brand-600 hover:text-brand-700">{t('Publier', 'Publish')}</button>
          </>
        ) : (
          <button onClick={onDuplicate} className="font-medium text-brand-600 hover:text-brand-700" title={t('Un formulaire publié est immuable : on en crée une copie modifiable', 'A published form is immutable: an editable copy is created')}>{t('Dupliquer', 'Duplicate')}</button>
        )}
        <button onClick={onDelete} className="font-medium text-coral hover:text-red-700">{t('Supprimer', 'Delete')}</button>
      </div>
    </div>
  );
}

/** Aperçu d'un formulaire au clic sur son nom : le VRAI écran WhatsApp Flow (rendu partagé avec le builder). */
function FlowPreviewModal({ flow, onClose }: { flow: FlowSummary; onClose: () => void }) {
  const t = useT();
  const els = flow.elements ?? null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-sm overflow-y-auto rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">{flow.name}</h3>
            <p className="text-xs text-ink-400">{flow.status === 'PUBLISHED' ? t('Publié', 'Published') : t('Brouillon', 'Draft')} · {flow.fields.length} {t('champ', 'field')}{flow.fields.length > 1 ? 's' : ''}</p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-ink-400 hover:text-ink-700">×</button>
        </div>
        {!els || els.length === 0 ? (
          <p className="text-sm text-ink-500">{flow.fields.length > 0 ? flow.fields.map((f) => f.label).join(', ') : t('Formulaire antérieur au modèle riche (aperçu détaillé indisponible).', 'Form predates the rich model (detailed preview unavailable).')}</p>
        ) : (
          <FlowScreen elements={fromFlowElements(els)} cta={flow.cta} title={flow.name} />
        )}
      </div>
    </div>
  );
}
