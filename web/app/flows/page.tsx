'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { FlowBuilder } from '@/components/FlowBuilder';
import { FlowScreen, fromFlowElements } from '@/components/FlowScreen';
import type { Session } from '@/lib/session';
import { listFlows, publishFlow, duplicateFlow, deleteFlow, refreshFlows, type FlowSummary } from '@/lib/api';
import { messageRafraichissement } from '@/lib/flows-refresh';
import { useT } from '@/lib/i18n';
import { Bouton } from '@/components/Bouton';
import { IntroPage, TitrePage } from '@/components/TitrePage';
import { Icone } from '@/components/Icone';
import { useConfirmation } from '@/components/Confirmation';
import { Modale } from '@/components/Modale';
import { Squelette } from '@/components/Squelette';
import { erreurDeChargement } from '@/lib/http';

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
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const t = useT();
  const confirmer = useConfirmation();

  const load = useCallback(async (): Promise<FlowSummary[]> => {
    setError(null);
    try {
      const { flows } = await listFlows(session.tenantId);
      setFlows(flows);
      return flows;
    } catch (err) {
      setError(erreurDeChargement(err, t));
      return [];
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Va chercher chez Meta les formulaires du compte WhatsApp Manager, puis recharge la liste locale. */
  async function refresh() {
    setError(null);
    setNote(null);
    setRefreshing(true);
    try {
      const rapport = await refreshFlows(session.tenantId);
      await load();
      setNote(messageRafraichissement(rapport, t));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Rafraîchissement impossible', 'Refresh failed'));
    } finally {
      setRefreshing(false);
    }
  }

  async function publish(f: FlowSummary) {
    // Le nom est interpolé DANS la phrase traduite : la découper en morceaux concaténés laissait les
    // guillemets français et le « ? » final dans la version anglaise.
    if (!(await confirmer({ titre: t('Publier le formulaire', 'Publish the form'), message: t(`Publier le formulaire « ${f.name} » ?\nUn formulaire publié ne peut plus être modifié (irréversible côté Meta). Pour changer les champs, il faudra « Dupliquer pour modifier ».`,
        `Publish the form “${f.name}”?\nA published form can no longer be edited (irreversible on the Meta side). To change the fields, you will need to “Duplicate to edit”.`), confirmer: t('Publier', 'Publish') }))) return;
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
      ? t(`Supprimer le formulaire publié « ${f.name} » ?\nUn formulaire publié ne se supprime pas chez Meta : il est déprécié (retiré de l’usage). S’il est encore rattaché à un template, Meta peut refuser.`,
          `Delete the published form “${f.name}”?\nA published form cannot be deleted on Meta: it is deprecated (removed from use). If it is still attached to a template, Meta may refuse.`)
      : t(`Supprimer le brouillon « ${f.name} » ?`, `Delete the draft “${f.name}”?`);
    if (!(await confirmer({ titre: t('Supprimer le formulaire', 'Delete the form'), message: msg, confirmer: t('Supprimer', 'Delete') }))) return;
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
        <TitrePage>{t('Formulaires', 'Forms')}</TitrePage>
        <IntroPage>{t('Le client remplit le formulaire dans WhatsApp et chaque réponse se range dans sa fiche ; publié, un formulaire s’attache à un template par un bouton « Flow ».', 'The customer fills in the form inside WhatsApp and each answer lands in their record; once published, a form is attached to a template through a “Flow” button.')}</IntroPage>
      </div>
      {error && <p className="rounded-controle bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}
      {note && <p data-testid="flows-note-rafraichissement" className="rounded-controle bg-brand-50 px-3 py-2 text-sm text-ink-900">{note}</p>}

      {editing ? (
        <div className="rounded-carte border border-brand-200 bg-brand-50/40 p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-ink-900">{t(`Modifier « ${editing.name} »`, `Edit “${editing.name}”`)} <span className="ml-2 text-xs font-normal text-ink-500">({t('brouillon', 'draft')})</span></div>
            <button onClick={() => setEditing(null)} className="text-xs text-ink-500 hover:text-ink-900">{t('Fermer', 'Close')}</button>
          </div>
          <FlowBuilder
            key={editing.id}
            tenantId={session.tenantId}
            mode="edit"
            flowId={editing.id}
            initialName={editing.name}
            initialScreens={editing.screens}
            initialMapping={editing.mapping}
            initialCta={editing.cta}
            onCreated={() => { void load(); setEditing(null); }}
          />
        </div>
      ) : creating ? (
        <div className="rounded-carte border border-brand-200 bg-brand-50/40 p-5">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-ink-900">{t('Nouveau formulaire', 'New form')}</div>
            <button onClick={() => setCreating(false)} className="text-xs text-ink-500 hover:text-ink-900">{t('Fermer', 'Close')}</button>
          </div>
          <FlowBuilder tenantId={session.tenantId} onCreated={() => { void load(); setCreating(false); }} />
        </div>
      ) : null}

      {/* La liste des formuaires existants n'a rien à faire SOUS le formulaire de création : elle répète ce que
          l'écran d'entrée montre déjà, et elle noie le travail en cours. On la masque donc pendant la création
          comme pendant l'édition, exactement comme le bouton « Créer un formulaire » juste en dessous. Le
          compteur disparaît avec elle : il n'a de sens qu'en face de la liste. */}
      {!creating && !editing && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-semibold text-ink-900">{t('Formulaires', 'Forms')} ({flows.length})</span>
            <div className="flex items-center gap-2">
              {/* La liste vient de NOTRE base : un formulaire créé dans WhatsApp Manager, ou publié là-bas,
                  n'arrive ici que par cette réconciliation. */}
              <Bouton variante="secondaire" enCours={refreshing}
                onClick={() => void refresh()}
                disabled={refreshing}
                title={t('Relit les formulaires du compte WhatsApp Manager et met la liste à jour', 'Fetches the forms from the WhatsApp Manager account and updates the list')}
              >
                {refreshing ? t('Rafraîchissement…', 'Refreshing…') : t('Rafraîchir', 'Refresh')}
              </Bouton>
              {/* Le compte-rendu du rafraîchissement parle de la LISTE : le laisser au-dessus du constructeur
                  en ferait un message sans objet. */}
              <Bouton onClick={() => { setNote(null); setCreating(true); }}><Icone nom="ajouter" />{t('Créer un formulaire', 'Create a form')}</Bouton>
            </div>
          </div>
          {loading ? (
            <Squelette forme="lignes" />
          ) : flows.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-ink-500">{t("Aucun formulaire pour l’instant.", 'No forms yet.')}</p>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {flows.map((f) => <FlowCard key={f.id} flow={f} onPreview={() => setPreview(f)} onEdit={() => { setNote(null); setEditing(f); }} onPublish={() => publish(f)} onDuplicate={() => duplicate(f)} onDelete={() => remove(f)} />)}
            </div>
          )}
        </div>
      )}
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
  // Miniature = écran 1 seulement (crop) ; pas de resolveLabel -> pas de badge de condition dans la miniature.
  const first = f.screens && f.screens.length > 0 ? f.screens[0] : undefined;
  return (
    <div className="flex flex-col rounded-carte border border-ink-200 bg-white p-3 transition-colors duration-150 hover:border-brand-300">
      <button onClick={onPreview} title={t("Voir l’aperçu", 'View preview')} className="mb-2 block overflow-hidden rounded-carte border border-ink-100 bg-ink-50">
        <div className="pointer-events-none h-44 overflow-hidden">
          {first
            ? <FlowScreen elements={fromFlowElements(first.elements)} cta={f.cta} title={first.title || f.name} />
            : <div className="flex h-full items-center justify-center px-3 text-center text-xs text-ink-500">{t('Structure inconnue : aperçu indisponible', 'Unknown structure: preview unavailable')}</div>}
        </div>
      </button>
      <div className="flex items-center gap-2">
        <button onClick={onPreview} className="min-w-0 flex-1 truncate text-left text-sm font-medium text-ink-900 hover:text-brand-600" title={f.name}>{f.name}</button>
        {f.status === 'PUBLISHED'
          ? <span className="shrink-0 rounded-full bg-succes-50 px-2 py-0.5 text-xs font-medium text-succes-700">{t('Publié', 'Published')}</span>
          : <span className="shrink-0 rounded-full bg-alerte-50 px-2 py-0.5 text-xs font-medium text-alerte">{t('Brouillon', 'Draft')}</span>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {f.status === 'DRAFT' ? (
          <>
            {first
              ? <button onClick={onEdit} className="font-medium text-brand-600 hover:text-brand-700">{t('Modifier', 'Edit')}</button>
              : <span className="text-ink-500" title={t("Formulaire non construit dans la console (importé de WhatsApp Manager, ou antérieur au modèle riche) : Meta n’en renvoie pas la structure. À recréer ici pour le modifier.", 'Form not built in the console (imported from WhatsApp Manager, or predating the rich model): Meta does not return its structure. Recreate it here to edit it.')}>{t('Modifier', 'Edit')}</span>}
            <button onClick={onPublish} className="font-medium text-brand-600 hover:text-brand-700">{t('Publier', 'Publish')}</button>
          </>
        ) : (
          <button onClick={onDuplicate} className="font-medium text-brand-600 hover:text-brand-700" title={t('Un formulaire publié est immuable : on en crée une copie modifiable', 'A published form is immutable: an editable copy is created')}>{t('Dupliquer', 'Duplicate')}</button>
        )}
        <button onClick={onDelete} className="font-medium text-danger hover:text-danger-700">{t('Supprimer', 'Delete')}</button>
      </div>
    </div>
  );
}

/** Aperçu d'un formulaire au clic sur son nom : le VRAI écran WhatsApp Flow (rendu partagé avec le builder),
 *  avec pagination entre les écrans, footer contextuel (Continuer vs bouton final) et badges de condition. */
function FlowPreviewModal({ flow, onClose }: { flow: FlowSummary; onClose: () => void }) {
  const t = useT();
  const [idx, setIdx] = useState(0);
  const screens = flow.screens && flow.screens.length > 0 ? flow.screens : null;
  const n = screens ? screens.length : 0;
  const cur = Math.min(idx, Math.max(0, n - 1)); // borné (filet si les données changent sous la modale)
  const scr = screens ? screens[cur] : null;
  return (
    <Modale
      titre={flow.name}
      sousTitre={<>{flow.status === 'PUBLISHED' ? t('Publié', 'Published') : t('Brouillon', 'Draft')} · {flow.fields.length} {t('champ', 'field')}{flow.fields.length > 1 ? 's' : ''}</>}
      taille="petite"
      onClose={onClose}
    >
      {!scr ? (
        <p className="text-sm text-ink-500">{flow.fields.length > 0 ? flow.fields.map((f) => f.label).join(', ') : t("Formulaire non construit dans la console : Meta n’en renvoie pas la structure, l’aperçu détaillé est donc indisponible.", 'Form not built in the console: Meta does not return its structure, so the detailed preview is unavailable.')}</p>
      ) : (
        <>
          {n > 1 && (
            <div className="mb-2 flex items-center justify-center gap-3 text-xs text-ink-500">
              <button onClick={() => setIdx(Math.max(0, cur - 1))} disabled={cur === 0} className="rounded-controle px-1.5 py-0.5 hover:bg-ink-100 disabled:opacity-30" aria-label={t('Écran précédent', 'Previous screen')}><Icone nom="precedent" taille="petite" /></button>
              <span>{t('Écran', 'Screen')} {cur + 1}/{n}</span>
              <button onClick={() => setIdx(Math.min(n - 1, cur + 1))} disabled={cur === n - 1} className="rounded-controle px-1.5 py-0.5 hover:bg-ink-100 disabled:opacity-30" aria-label={t('Écran suivant', 'Next screen')}><Icone nom="suivant" taille="petite" /></button>
            </div>
          )}
          <FlowScreen
            elements={fromFlowElements(scr.elements, (fieldKey) => {
              // Le libellé du champ source se résout DANS le même écran (contrainte du modèle).
              const src = scr.elements.find((el) => el.kind === 'field' && el.key === fieldKey);
              return src && src.kind === 'field' ? src.label : null;
            })}
            cta={cur === n - 1 ? flow.cta : (scr.cta || t('Continuer', 'Continue'))}
            title={scr.title || flow.name}
          />
        </>
      )}
    </Modale>
  );
}
