'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { WorkflowBuilder } from '@/components/WorkflowBuilder';
import type { Session } from '@/lib/session';
import { listWorkflows, createWorkflow, getWorkflow, deleteWorkflow, type WorkflowSummary } from '@/lib/api';
import { useT } from '@/lib/i18n';

export default function WorkflowsPage() {
  return <AppShell active="workflows" fullBleed>{(session) => <WorkflowsInner session={session} />}</AppShell>;
}

function WorkflowsInner({ session }: { session: Session }) {
  const t = useT();
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
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => { void load(); }, [load]);

  async function create() {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    try {
      const res = await createWorkflow(session.tenantId, name);
      setNewName('');
      setEditing({ id: res.id, name: res.name, graph: res.graph, createdAt: '', updatedAt: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Création impossible', 'Unable to create'));
    }
  }
  async function open(w: WorkflowSummary) {
    setError(null);
    try {
      const { workflow } = await getWorkflow(session.tenantId, w.id);
      setEditing(workflow);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Ouverture impossible', 'Unable to open'));
    }
  }
  async function remove(w: WorkflowSummary) {
    if (!window.confirm(t(`Supprimer le scénario « ${w.name} » ?`, `Delete the scenario "${w.name}"?`))) return;
    setError(null);
    try {
      await deleteWorkflow(session.tenantId, w.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Suppression impossible', 'Unable to delete'));
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-3 p-3 lg:h-full">
        <div className="flex items-center justify-between">
          <button onClick={() => { setEditing(null); void load(); }} className="text-sm text-brand-600 hover:underline">← {t('Retour aux scénarios', 'Back to scenarios')}</button>
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
        <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Scénarios', 'Scenarios')}</h2>
        <p className="mt-1 text-sm text-ink-500">{t("Construis des automatisations en blocs : ajout de tag, envoi d'un template, formulaire, arrivée en inbox. Un scénario s'attache à une campagne et s'exécute pour chaque contact.", 'Build automations in blocks: add a tag, send a template, form, arrival in the inbox. A scenario attaches to a campaign and runs for each contact.')}</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
          placeholder={t('Nom du scénario…', 'Scenario name…')}
          className="flex-1 rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        />
        <button onClick={create} disabled={newName.trim() === ''} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-50">{t('Créer un scénario', 'Create a scenario')}</button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-semibold text-ink-900">{t('Scénarios', 'Scenarios')} ({workflows.length})</div>
        {loading ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
        ) : workflows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Aucun scénario. Crée-en un ci-dessus.', 'No scenarios yet. Create one above.')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-2 font-medium">{t('Nom', 'Name')}</th>
                <th className="px-5 py-2 font-medium">{t('Blocs', 'Blocks')}</th>
                <th className="px-5 py-2 text-right font-medium">{t('Actions', 'Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((w) => (
                <tr key={w.id} className="border-b border-ink-50 last:border-0">
                  <td className="px-5 py-3">
                    <button onClick={() => open(w)} className="font-medium text-brand-600 hover:underline">{w.name}</button>
                    {w.code && <div className="font-mono text-[10px] text-ink-300" title={t('Code public (API)', 'Public code (API)')}>{w.code}</div>}
                  </td>
                  <td className="px-5 py-3 text-ink-500">{w.graph.nodes.length}</td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button onClick={() => open(w)} className="font-medium text-brand-600 hover:text-brand-700">{t('Ouvrir', 'Open')}</button>
                      <button onClick={() => remove(w)} className="text-coral hover:text-coral/80">{t('Supprimer', 'Delete')}</button>
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
