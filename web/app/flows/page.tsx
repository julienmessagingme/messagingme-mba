'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { FlowBuilder } from '@/components/FlowBuilder';
import type { Session } from '@/lib/session';
import { listFlows, publishFlow, duplicateFlow, type FlowSummary } from '@/lib/api';

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

  const load = useCallback(async (): Promise<FlowSummary[]> => {
    setError(null);
    try {
      const { flows } = await listFlows(session.tenantId);
      setFlows(flows);
      return flows;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chargement impossible');
      return [];
    } finally {
      setLoading(false);
    }
  }, [session.tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function publish(f: FlowSummary) {
    if (!window.confirm(`Publier le formulaire « ${f.name} » ?\nUn formulaire publié ne peut plus être modifié (irréversible côté Meta). Pour changer les champs, il faudra « Dupliquer pour modifier ».`)) return;
    setError(null);
    const prev = flows;
    setFlows((list) => list.map((x) => (x.id === f.id ? { ...x, status: 'PUBLISHED' } : x))); // optimiste
    try {
      await publishFlow(session.tenantId, f.id);
    } catch (err) {
      setFlows(prev);
      setError(err instanceof Error ? err.message : 'Publication impossible');
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
      setError(err instanceof Error ? err.message : 'Duplication impossible');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-ink-900">Flows</h2>
        <p className="mt-1 text-sm text-ink-500">Formulaires de collecte riches (titres, images, champs) : le client remplit dans WhatsApp, chaque champ se range dans une fiche contact, la réponse arrive dans l&apos;inbox. Attache un formulaire publié à un template via un bouton « Flow ».</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {editing ? (
        <div className="rounded-2xl border border-brand-200 bg-brand-50/40 p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-ink-900">Modifier « {editing.name} » <span className="ml-2 text-xs font-normal text-ink-400">(brouillon)</span></div>
            <button onClick={() => setEditing(null)} className="text-xs text-ink-400 hover:text-ink-700">Fermer</button>
          </div>
          <FlowBuilder
            key={editing.id}
            tenantId={session.tenantId}
            mode="edit"
            flowId={editing.id}
            initialName={editing.name}
            initialElements={editing.elements}
            initialMapping={editing.mapping}
            onCreated={() => { void load(); setEditing(null); }}
          />
        </div>
      ) : creating ? (
        <div className="rounded-2xl border border-brand-200 bg-brand-50/40 p-5 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-ink-900">Nouveau formulaire</div>
            <button onClick={() => setCreating(false)} className="text-xs text-ink-400 hover:text-ink-700">Fermer</button>
          </div>
          <FlowBuilder tenantId={session.tenantId} onCreated={() => { void load(); setCreating(false); }} />
        </div>
      ) : null}

      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-ink-100 px-5 py-3">
          <span className="text-sm font-semibold text-ink-900">Formulaires ({flows.length})</span>
          {!creating && !editing && (
            <button onClick={() => setCreating(true)} className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-600">+ Créer un formulaire</button>
          )}
        </div>
        {loading ? (
          <p className="px-5 py-6 text-sm text-ink-500">Chargement…</p>
        ) : flows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">Aucun formulaire pour l&apos;instant.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-2 font-medium">Nom</th>
                <th className="px-5 py-2 font-medium">Aperçu</th>
                <th className="px-5 py-2 font-medium">Statut</th>
                <th className="px-5 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {flows.map((f) => (
                <tr key={f.id} className="border-b border-ink-50 last:border-0">
                  <td className="px-5 py-3">
                    <button onClick={() => setPreview(f)} className="font-medium text-brand-600 hover:underline" title="Voir l'aperçu">{f.name}</button>
                  </td>
                  <td className="px-5 py-3"><button onClick={() => setPreview(f)} title="Voir l'aperçu"><FlowThumbnail flow={f} /></button></td>
                  <td className="px-5 py-3">
                    {f.status === 'PUBLISHED' ? (
                      <span className="inline-flex items-center rounded-full bg-mint-50 px-2 py-0.5 text-xs font-medium text-mint-700">Publié</span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-gold/10 px-2 py-0.5 text-xs font-medium text-gold">Brouillon</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {f.status === 'DRAFT' ? (
                      <div className="flex items-center justify-end gap-3">
                        {f.elements && f.elements.length > 0 ? (
                          <button onClick={() => setEditing(f)} className="font-medium text-brand-600 hover:text-brand-700">Éditer</button>
                        ) : (
                          <span className="text-ink-300" title="Formulaire antérieur au modèle riche : à recréer">Éditer</span>
                        )}
                        <button onClick={() => publish(f)} className="font-medium text-brand-600 hover:text-brand-700">Publier</button>
                      </div>
                    ) : (
                      <button onClick={() => duplicate(f)} className="font-medium text-brand-600 hover:text-brand-700" title="Un formulaire publié est immuable : on en crée une copie modifiable">Dupliquer pour modifier</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {preview && <FlowPreviewModal flow={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}

const TEXT_KINDS: Record<string, string> = { heading: 'Titre', subheading: 'Sous-titre', body: 'Paragraphe', caption: 'Légende' };

/** Miniature visuelle d'un formulaire (mini écran WhatsApp Flow) rendue depuis ses éléments. */
function FlowThumbnail({ flow }: { flow: FlowSummary }) {
  const els = flow.elements ?? [];
  if (els.length === 0) {
    return <span className="text-xs text-ink-400">{flow.fields.map((x) => x.label).join(', ') || 'aperçu indisponible'}</span>;
  }
  const hasImage = els.some((e) => e.kind === 'image');
  const heading = els.find((e) => e.kind === 'heading');
  const text = els.find((e) => e.kind === 'subheading' || e.kind === 'body' || e.kind === 'caption');
  const fields = els.filter((e) => e.kind === 'field');
  return (
    <div className="w-40 overflow-hidden rounded-lg border border-ink-200 bg-white text-left shadow-sm transition hover:border-brand-300 hover:shadow">
      {hasImage && <div className="flex h-9 items-center justify-center bg-ink-100 text-base">🖼️</div>}
      <div className="space-y-1 px-2 py-1.5">
        {heading && 'text' in heading && <div className="truncate text-[11px] font-semibold text-ink-800">{heading.text}</div>}
        {text && 'text' in text && <div className="truncate text-[10px] text-ink-500">{text.text}</div>}
        {fields.slice(0, 3).map((f, i) => (
          <div key={i} className="truncate rounded border border-ink-200 bg-ink-50 px-1.5 py-0.5 text-[10px] text-ink-600">
            {'label' in f ? f.label : ''}
          </div>
        ))}
        {fields.length > 3 && <div className="text-[10px] text-ink-400">+{fields.length - 3} champ(s)</div>}
        {fields.length === 0 && !heading && !text && <div className="text-[10px] text-ink-400">écran sans champ</div>}
      </div>
      <div className="border-t border-ink-100 bg-brand-50 py-1 text-center text-[10px] font-medium text-brand-600">Envoyer</div>
    </div>
  );
}

/** Aperçu read-only d'un formulaire au clic sur son nom : les éléments dans l'ordre (texte/image/champ). */
function FlowPreviewModal({ flow, onClose }: { flow: FlowSummary; onClose: () => void }) {
  const els = flow.elements ?? null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">{flow.name}</h3>
            <p className="text-xs text-ink-400">{flow.status === 'PUBLISHED' ? 'Publié' : 'Brouillon'} · {flow.fields.length} champ{flow.fields.length > 1 ? 's' : ''}</p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-ink-400 hover:text-ink-700">×</button>
        </div>
        {!els || els.length === 0 ? (
          <p className="text-sm text-ink-500">{flow.fields.length > 0 ? flow.fields.map((f) => f.label).join(', ') : 'Formulaire antérieur au modèle riche (aperçu détaillé indisponible).'}</p>
        ) : (
          <div className="space-y-2 rounded-xl border border-ink-200 bg-ink-50/50 p-3">
            {els.map((e, i) => (
              <div key={i} className="text-sm">
                {e.kind === 'image' ? (
                  <div className="flex items-center gap-2 text-ink-500"><span className="rounded bg-ink-200 px-1.5 py-0.5 text-[10px] uppercase">Image</span></div>
                ) : e.kind === 'field' ? (
                  <div className="rounded-lg border border-ink-200 bg-white px-3 py-2">
                    <span className="text-ink-800">{e.label}</span>
                    <span className="ml-2 text-[11px] text-ink-400">{e.type}{e.required ? ' · requis' : ''}</span>
                  </div>
                ) : (
                  <div><span className="mr-1 text-[10px] uppercase text-ink-400">{TEXT_KINDS[e.kind] ?? e.kind}</span><span className={e.kind === 'heading' ? 'font-semibold text-ink-900' : 'text-ink-700'}>{e.text}</span></div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
