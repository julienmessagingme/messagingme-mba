'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import Link from 'next/link';
import type { Session } from '@/lib/session';
import { listNodes, type NodeListItem, type WorkflowNodeType } from '@/lib/api';
import { filterNodes } from '@/lib/node-search';
import { NODE_META, NODE_ORDER, nodeMetaOf } from '@/lib/nodeMeta';
import { useT } from '@/lib/i18n';

export default function NodesPage() {
  return <AppShell active="nodes">{(session) => <NodesInner session={session} />}</AppShell>;
}

function NodesInner({ session }: { session: Session }) {
  const t = useT();
  const [nodes, setNodes] = useState<NodeListItem[]>([]);
  const [filter, setFilter] = useState<WorkflowNodeType | 'all'>('all');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // On charge TOUS les blocs une fois ; le filtrage (type + texte, cumulatifs) est instantané côté client
  // (dataset borné, déjà entièrement renvoyé par le serveur). Plus de rechargement par type.
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listNodes(session.tenantId);
      setNodes(res.nodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Failed to load'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Filtres cumulables : typologie (chips) ET recherche texte (contenu / scénario / code / type).
  const visible = useMemo(() => filterNodes(nodes, filter, query), [nodes, filter, query]);

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

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('Rechercher un bloc (contenu, scénario, code…)', 'Search a block (content, scenario, code…)')}
        className="w-full rounded-lg border border-ink-300 px-3 py-2 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100"
        data-testid="nodes-search"
      />

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
          <span className="ml-2 text-xs font-normal text-ink-400">({visible.length})</span>
        </div>
        {loading ? (
          <p className="px-5 py-6 text-sm text-ink-500">{t('Chargement…', 'Loading…')}</p>
        ) : visible.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">{nodes.length === 0 ? t(
            'Aucun bloc pour l’instant. Les blocs sont créés dans l’éditeur de scénario.',
            'No block yet. Blocks are created in the scenario editor.',
          ) : t('Aucun bloc ne correspond à ta recherche.', 'No block matches your search.')}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-left text-xs uppercase tracking-wide text-ink-400">
                <th className="px-5 py-2 font-medium">{t('Type', 'Type')}</th>
                <th className="px-5 py-2 font-medium">{t('Nom', 'Name')}</th>
                <th className="px-5 py-2 font-medium">{t('Scénario', 'Scenario')}</th>
                <th className="px-5 py-2 font-medium">{t('Code', 'Code')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((n, i) => {
                const meta = nodeMetaOf(n.type); // tolérant : un node d'un type pas encore connu du front -> repli neutre
                return (
                  <tr key={`${n.workflowId}-${n.code ?? i}`} className="border-b border-ink-50 last:border-0">
                    <td className="whitespace-nowrap px-5 py-3 text-ink-800"><span className="mr-1.5">{meta.emoji}</span>{t(meta.label[0], meta.label[1])}</td>
                    {/* Repli le temps que les blocs soient renommés : nom libre, sinon le résumé auto, sinon (sans nom). */}
                    <td className="px-5 py-3 text-ink-600">{n.name || n.summary || <span className="text-ink-300">{t('(sans nom)', '(unnamed)')}</span>}</td>
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
