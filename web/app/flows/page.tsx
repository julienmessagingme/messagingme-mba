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
      ) : (
        <div className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
          <div className="mb-3 text-sm font-semibold text-ink-900">Créer un formulaire</div>
          <FlowBuilder tenantId={session.tenantId} onCreated={() => void load()} />
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-semibold text-ink-900">Formulaires ({flows.length})</div>
        {loading ? (
          <p className="px-5 py-6 text-sm text-ink-500">Chargement…</p>
        ) : flows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">Aucun formulaire pour l&apos;instant.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-2 font-medium">Nom</th>
                <th className="px-5 py-2 font-medium">Champs</th>
                <th className="px-5 py-2 font-medium">Statut</th>
                <th className="px-5 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {flows.map((f) => (
                <tr key={f.id} className="border-b border-ink-50 last:border-0">
                  <td className="px-5 py-3 text-ink-800">{f.name}</td>
                  <td className="px-5 py-3 text-ink-500">{f.fields.map((x) => x.label).join(', ') || '—'}</td>
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
    </div>
  );
}
