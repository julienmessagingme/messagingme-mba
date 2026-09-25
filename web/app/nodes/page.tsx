'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import Link from 'next/link';
import type { Session } from '@/lib/session';
import { listNodes, type NodeListItem, type WorkflowNodeType } from '@/lib/api';
import { filterNodes } from '@/lib/node-search';
import { NODE_META, NODE_ORDER, RCS_NODE_ORDER, EMAIL_NODE_ORDER, AGENT_NODE_ORDER, nodeMetaOf } from '@/lib/nodeMeta';
import { useT } from '@/lib/i18n';
import { inputCls } from '@/lib/ui';
import { IntroPage, TitrePage } from '@/components/TitrePage';

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
    `rounded-full border px-3 py-1 text-sm transition-colors duration-150 ${on ? 'border-brand-500 bg-brand-50 font-medium text-brand-700' : 'border-ink-200 text-ink-500 hover:bg-ink-100'}`;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <TitrePage>{t('Blocs', 'Blocks')}</TitrePage>
        <IntroPage>{t(
          'Tous les blocs de tes scénarios, réunis et filtrables par type. Chaque bloc porte son code public (API) : c’est cette référence que tu passes pour cibler un bloc précis.',
          'Every block from your scenarios, gathered and filterable by type. Each block carries its public code (API): that reference is what you pass to target a specific block.',
        )}</IntroPage>
      </div>
      {error && <p className="rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</p>}

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('Rechercher un bloc (contenu, scénario, code…)', 'Search a block (content, scenario, code…)')}
        className={inputCls}
        data-testid="nodes-search"
      />

      <div className="flex flex-wrap gap-2">
        <button onClick={() => setFilter('all')} className={chip(filter === 'all')}>{t('Tous', 'All')}</button>
        {/* Les TROIS listes, pas seulement NODE_ORDER : sans RCS ni email, ces blocs existaient dans les
            scénarios sans qu'aucun filtre ne permette de les isoler ici. ⚠️ Pas de grisage sur CET écran,
            contrairement à la palette : on filtre des blocs qui EXISTENT déjà. Un tenant dont l'agent RCS a
            été détaché garde ses blocs RCS, et doit pouvoir les retrouver. */}
        {[...NODE_ORDER, ...RCS_NODE_ORDER, ...EMAIL_NODE_ORDER, ...AGENT_NODE_ORDER].map((type) => {
          const meta = NODE_META[type];
          return (
            <button key={type} onClick={() => setFilter(type)} className={chip(filter === type)}>
              <span className="mr-1">{meta.emoji}</span>{t(meta.label[0], meta.label[1])}
            </button>
          );
        })}
      </div>

      <div className="overflow-hidden rounded-2xl border border-ink-200 bg-white">
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
              <tr className="border-b border-ink-100 text-left text-xs text-ink-500">
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
                    <td className="whitespace-nowrap px-5 py-3 text-ink-900"><span className="mr-1.5">{meta.emoji}</span>{t(meta.label[0], meta.label[1])}</td>
                    {/* Repli le temps que les blocs soient renommés : nom libre, sinon le résumé auto, sinon (sans nom). */}
                    <td className="px-5 py-3 text-ink-500">{n.name || n.summary || <span className="text-ink-400">{t('(sans nom)', '(unnamed)')}</span>}</td>
                    <td className="px-5 py-3">
                      <Link href={`/workflows?open=${encodeURIComponent(n.workflowId)}`} className="text-brand-600 hover:underline">{n.workflowName}</Link>
                    </td>
                    <td className="px-5 py-3">
                      {n.code
                        ? <code className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-xs text-ink-500">{n.code}</code>
                        : <span className="text-xs text-ink-400" title={t('Code généré au prochain enregistrement du scénario', 'Code generated on the next scenario save')}>{t('non codé', 'not coded')}</span>}
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
