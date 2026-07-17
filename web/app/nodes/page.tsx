'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import Link from 'next/link';
import type { Session } from '@/lib/session';
import { listNodes, type NodeListItem, type WorkflowNodeType } from '@/lib/api';
import { NODE_META, NODE_ORDER } from '@/lib/nodeMeta';
import { useT } from '@/lib/i18n';

export default function NodesPage() {
  return <AppShell active="nodes">{(session) => <NodesInner session={session} />}</AppShell>;
}

function NodesInner({ session }: { session: Session }) {
  const t = useT();
  const [nodes, setNodes] = useState<NodeListItem[]>([]);
  const [filter, setFilter] = useState<WorkflowNodeType | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listNodes(session.tenantId, filter === 'all' ? undefined : filter);
      setNodes(res.nodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Failed to load'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const chip = (on: boolean) =>
    `rounded-full border px-3 py-1 text-sm transition ${on ? 'border-brand-500 bg-brand-50 font-medium text-brand-700' : 'border-ink-200 text-ink-600 hover:bg-ink-100'}`;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Blocs', 'Blocks')}</h2>
        <p className="mt-1 text-sm text-ink-500">{t(
          'Tous les blocs de tes scénarios, réunis et filtrables par type. Chaque bloc porte son code public (API) : c’est cette référence que tu passes pour cibler un bloc précis.',
          'Every block from your scenarios, gathered and filterable by type. Each block carries its public code (API): that reference is what you pass to target a specific block.',
        )}</p>
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <button onClick={() => setFilter('all')} className={chip(filter === 'all')}>{t('Tous', 'All')}</button>
        {NODE_ORDER.map((type) => {
          const meta = NODE_META[type];
          return (
            <button key={type} onClick={() => setFilter(type)} className={chip(filter === type)}>
              <span className="mr-1">{meta.emoji}</span>{t(meta.label[0], meta.label[1])}
            </button>
          );
        })}
      </div>

      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white shadow-sm">
        <div className="border-b border-ink-100 px-5 py-3 text-sm font-semibold text-ink-900">
          {filter === 'all' ? t('Tous les blocs', 'All blocks') : `${NODE_META[filter].emoji} ${t(NODE_META[filter].label[0], NODE_META[filter].label[1])}`}
          <span className="ml-2 text-xs font-normal text-ink-400">({nodes.length})</span>
        </div>
        {loading ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
        ) : nodes.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t(
            'Aucun bloc pour ce type. Les blocs sont créés dans l’éditeur de scénario.',
            'No block for this type. Blocks are created in the scenario editor.',
          )}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-2 font-medium">{t('Type', 'Type')}</th>
                <th className="px-5 py-2 font-medium">{t('Contenu', 'Content')}</th>
                <th className="px-5 py-2 font-medium">{t('Scénario', 'Scenario')}</th>
                <th className="px-5 py-2 font-medium">{t('Code', 'Code')}</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((n, i) => {
                const meta = NODE_META[n.type];
                return (
                  <tr key={`${n.workflowId}-${n.code ?? i}`} className="border-b border-ink-50 last:border-0">
                    <td className="whitespace-nowrap px-5 py-3 text-ink-800"><span className="mr-1.5">{meta.emoji}</span>{t(meta.label[0], meta.label[1])}</td>
                    <td className="px-5 py-3 text-ink-600">{n.summary || <span className="text-ink-300">{t('(vide)', '(empty)')}</span>}</td>
                    <td className="px-5 py-3">
                      <Link href={`/workflows?open=${encodeURIComponent(n.workflowId)}`} className="text-brand-600 hover:underline">{n.workflowName}</Link>
                    </td>
                    <td className="px-5 py-3">
                      {n.code
                        ? <code className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] text-ink-500">{n.code}</code>
                        : <span className="text-xs text-ink-300" title={t('Code généré au prochain enregistrement du scénario', 'Code generated on the next scenario save')}>{t('non codé', 'not coded')}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
