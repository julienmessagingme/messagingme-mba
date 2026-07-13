'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { WorkflowBuilder } from '@/components/WorkflowBuilder';
import type { Session } from '@/lib/session';
import { listWorkflows, createWorkflow, getWorkflow, deleteWorkflow, type WorkflowSummary } from '@/lib/api';

export default function WorkflowsPage() {
  return <AppShell active="workflows" fullBleed>{(session) => <WorkflowsInner session={session} />}</AppShell>;
}

function WorkflowsInner({ session }: { session: Session }) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<WorkflowSummary | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setWorkflows((await listWorkflows(session.tenantId)).workflows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [session.tenantId]);

  useEffect(() => { void load(); }, [load]);

  async function create() {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    try {
      const res = await createWorkflow(session.tenantId, name);
      setNewName('');
      setEditing({ id: res.id, name: res.name, status: 'draft', graph: res.graph, createdAt: '', updatedAt: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Création impossible');
    }
  }
  async function open(w: WorkflowSummary) {
    setError(null);
    try {
      const { workflow } = await getWorkflow(session.tenantId, w.id);
      setEditing(workflow);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ouverture impossible');
    }
  }
  async function remove(w: WorkflowSummary) {
    if (!window.confirm(`Supprimer le workflow « ${w.name} » ?`)) return;
    setError(null);
    try {
      await deleteWorkflow(session.tenantId, w.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Suppression impossible');
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-3 p-3 lg:h-full">
        <div className="flex items-center justify-between">
          <button onClick={() => { setEditing(null); void load(); }} className="text-sm text-brand-600 hover:underline">← Retour aux workflows</button>
          <h2 className="text-base font-semibold tracking-tight text-ink-900">{editing.name}</h2>
        </div>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="min-h-0 flex-1">
          <WorkflowBuilder key={editing.id} tenantId={session.tenantId} workflowId={editing.id} initialGraph={editing.graph} />
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6 lg:h-full lg:overflow-y-auto">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-ink-900">Flow</h2>
        <p className="mt-1 text-sm text-ink-500">Construis des automatisations en blocs : ajout de tag, envoi d&apos;un template, formulaire, arrivée en inbox. Un workflow s&apos;attache à une campagne (bientôt) et s&apos;exécute pour chaque contact.</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          placeholder="Nom du workflow…"
          className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <button onClick={create} disabled={newName.trim() === ''} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">Créer un workflow</button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-semibold text-ink-900">Workflows ({workflows.length})</div>
        {loading ? (
          <p className="px-5 py-6 text-sm text-ink-500">Chargement…</p>
        ) : workflows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">Aucun workflow. Crée-en un ci-dessus.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-2 font-medium">Nom</th>
                <th className="px-5 py-2 font-medium">Blocs</th>
                <th className="px-5 py-2 font-medium">Statut</th>
                <th className="px-5 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((w) => (
                <tr key={w.id} className="border-b border-ink-50 last:border-0">
                  <td className="px-5 py-3">
                    <button onClick={() => open(w)} className="font-medium text-brand-600 hover:underline">{w.name}</button>
                  </td>
                  <td className="px-5 py-3 text-ink-500">{w.graph.nodes.length}</td>
                  <td className="px-5 py-3">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${w.status === 'active' ? 'bg-mint-50 text-mint-700' : 'bg-gold/10 text-gold'}`}>
                      {w.status === 'active' ? 'Actif' : 'Brouillon'}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button onClick={() => open(w)} className="font-medium text-brand-600 hover:text-brand-700">Ouvrir</button>
                      <button onClick={() => remove(w)} className="text-coral hover:text-coral/80">Supprimer</button>
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
