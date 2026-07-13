'use client';

import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, Handle, Position, MarkerType,
  BaseEdge, EdgeLabelRenderer, getBezierPath,
  useNodesState, useEdgesState, addEdge,
  type Node, type Edge, type Connection, type NodeProps, type EdgeProps, type NodeTypes, type EdgeTypes,
} from '@xyflow/react';
import {
  updateWorkflow, listTemplates, listFlows, listTags, listUserFields,
  type WorkflowGraph, type WorkflowNodeType, type TemplateSummary, type FlowSummary, type TagCount, type UserFieldDef,
} from '@/lib/api';

type RFNode = Node<Record<string, unknown>>;
type RFEdge = Edge;

const NODE_META: Record<WorkflowNodeType, { emoji: string; label: string }> = {
  template: { emoji: '📩', label: 'Envoi template' },
  inbox: { emoji: '💬', label: 'Inbox' },
  flow: { emoji: '📋', label: 'Formulaire' },
  tag: { emoji: '🏷️', label: 'Ajout de tag' },
  field: { emoji: '✏️', label: 'Ajout de champ' },
};
const NODE_ORDER: WorkflowNodeType[] = ['template', 'flow', 'tag', 'field', 'inbox'];

function uid(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}-${Date.now()}`);
}

function summaryOf(data: Record<string, unknown>): string {
  const t = data.wfType as WorkflowNodeType;
  if (t === 'template') return (data.templateName as string) || 'choisir un template…';
  if (t === 'flow') return (data.flowName as string) || 'choisir un formulaire…';
  if (t === 'tag') return (data.tag as string) ? `+ ${data.tag as string}` : 'choisir un tag…';
  if (t === 'field') return (data.fieldLabel as string) ? `${data.fieldLabel as string} = ${(data.value as string) || '…'}` : 'choisir un champ…';
  return 'la conversation arrive en inbox';
}

/** Bloc du workflow : carré gris clair, handle cible (haut). Un bloc `template` expose UNE SORTIE PAR BOUTON
 *  quick-reply (handle à droite de la ligne, reliable) ; les boutons URL/formulaire sont montrés grisés, non
 *  reliables (ils sortent de WhatsApp). Les autres types de bloc ont une seule sortie (bas). */
function WFNode({ data, selected }: NodeProps) {
  const wfType = (data.wfType as WorkflowNodeType) ?? 'template';
  const meta = NODE_META[wfType];
  const buttons = wfType === 'template' && Array.isArray(data.templateButtons)
    ? (data.templateButtons as Array<{ type?: string; text?: string }>)
    : [];
  const hasQR = buttons.some((b) => b.type === 'QUICK_REPLY');
  return (
    <div className={`w-44 rounded-xl border bg-ink-50 shadow-sm transition ${selected ? 'border-brand-500 ring-2 ring-brand-100' : 'border-ink-300'}`}>
      <Handle type="target" position={Position.Top} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-brand-400" />
      <div className="flex items-center gap-1.5 rounded-t-xl border-b border-ink-200 bg-white px-2 py-1">
        <span className="text-xs">{meta.emoji}</span>
        <span className="truncate text-[11px] font-semibold text-ink-800">{meta.label}</span>
      </div>
      <div className="truncate px-2 py-1.5 text-[11px] text-ink-500">{summaryOf(data)}</div>
      {hasQR ? (
        // Au moins un bouton quick-reply -> une SORTIE par bouton (QR = handle reliable à droite ; URL/flow grisé).
        <div className="border-t border-ink-200">
          {buttons.map((b, i) => {
            const isQR = b.type === 'QUICK_REPLY';
            const icon = b.type === 'URL' ? '🔗' : b.type === 'FLOW' ? '📋' : '↩︎';
            const fallback = b.type === 'URL' ? 'Lien' : b.type === 'FLOW' ? 'Formulaire' : 'Réponse';
            return (
              <div key={i} className={`relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] first:border-t-0 ${isQR ? 'text-ink-700' : 'text-ink-400'}`}>
                <span className="shrink-0">{icon}</span>
                <span className="truncate">{b.text || fallback}</span>
                {isQR ? (
                  <Handle type="source" id={`btn:${i}`} position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-brand-500" title={`Relier « ${b.text || fallback} »`} />
                ) : (
                  <span className="absolute right-[-5px] top-1/2 h-2 w-2 -translate-y-1/2 rounded-full border border-white bg-ink-300" title="Bouton URL / formulaire : sort de WhatsApp, non reliable" />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        // Aucun quick-reply (0 bouton, ou seulement URL/formulaire) -> une seule sortie bas (le bloc peut
        // quand même mener au suivant après réponse). Les boutons URL/flow sont montrés grisés pour contexte.
        <>
          {buttons.length > 0 && (
            <div className="border-t border-ink-200">
              {buttons.map((b, i) => (
                <div key={i} className="flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] text-ink-400 first:border-t-0">
                  <span className="shrink-0">{b.type === 'URL' ? '🔗' : '📋'}</span>
                  <span className="truncate">{b.text || (b.type === 'URL' ? 'Lien' : 'Formulaire')}</span>
                </div>
              ))}
            </div>
          )}
          <Handle type="source" position={Position.Bottom} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-brand-500" title="Tirer une flèche" />
        </>
      )}
    </div>
  );
}

/** Arête courbée avec, au milieu, une poubelle (supprimer) et un + (insérer un bloc entre les deux). */
function WFEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd }: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ stroke: '#94a3b8', strokeWidth: 2 }} />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute flex gap-1"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          <button onClick={() => window.dispatchEvent(new CustomEvent('wf-edge-insert', { detail: id }))} title="Insérer un bloc" className="flex h-5 w-5 items-center justify-center rounded-full border border-ink-300 bg-white text-xs text-brand-600 shadow hover:bg-brand-50">+</button>
          <button onClick={() => window.dispatchEvent(new CustomEvent('wf-edge-delete', { detail: id }))} title="Supprimer la flèche" className="flex h-5 w-5 items-center justify-center rounded-full border border-ink-300 bg-white text-[11px] text-coral shadow hover:bg-red-50">✕</button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes: NodeTypes = { wf: WFNode };
const edgeTypes: EdgeTypes = { wf: WFEdge };
const EDGE_OPTS = { type: 'wf', markerEnd: { type: MarkerType.ArrowClosed, color: '#94a3b8' } };

function toRF(graph: WorkflowGraph): { nodes: RFNode[]; edges: RFEdge[] } {
  return {
    nodes: graph.nodes.map((n) => ({ id: n.id, type: 'wf', position: n.position, data: { wfType: n.type, ...n.data } })),
    edges: graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, ...EDGE_OPTS, ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}) })),
  };
}
function fromRF(nodes: RFNode[], edges: RFEdge[]): WorkflowGraph {
  return {
    nodes: nodes.map((n) => {
      const { wfType, ...rest } = n.data as { wfType?: WorkflowNodeType };
      return { id: n.id, type: (wfType ?? 'template') as WorkflowNodeType, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: rest };
    }),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}) })),
  };
}

/**
 * Éditeur visuel d'un workflow (bot builder). Blocs reliés par des flèches drag-and-drop (tirer depuis le
 * point bas d'un bloc vers un autre). +/poubelle sur chaque flèche. Panneau de config par bloc. PB1 : édition
 * + sauvegarde du graphe (pas d'exécution). Le graphe est validé/sanitisé côté serveur au save.
 */
export function WorkflowBuilder({ tenantId, workflowId, initialGraph }: { tenantId: string; workflowId: string; initialGraph: WorkflowGraph }) {
  const seed = useMemo(() => toRF(initialGraph), [initialGraph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>(seed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>(seed.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Données de config des blocs.
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [tags, setTags] = useState<TagCount[]>([]);
  const [fields, setFields] = useState<UserFieldDef[]>([]);
  useEffect(() => {
    listTemplates(tenantId).then((r) => setTemplates(r.templates.filter((t) => t.status === 'APPROVED'))).catch(() => {});
    listFlows(tenantId).then((r) => setFlows(r.flows.filter((f) => f.status === 'PUBLISHED'))).catch(() => {});
    listTags(tenantId).then((r) => setTags(r.tags)).catch(() => {});
    listUserFields(tenantId).then((r) => setFields(r.fields)).catch(() => {});
  }, [tenantId]);

  // Une seule cible par SORTIE : relier depuis un handle déjà relié remplace l'arête existante de ce
  // (source, sourceHandle) — un bouton mène à un seul bloc suivant.
  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge(
    { ...c, id: uid(), ...EDGE_OPTS },
    eds.filter((e) => !(e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null))),
  )), [setEdges]);

  const addNode = useCallback((wfType: WorkflowNodeType) => {
    const id = uid();
    setNodes((ns) => [...ns, { id, type: 'wf', position: { x: 60 + (ns.length % 4) * 60, y: 60 + ns.length * 30 }, data: { wfType } }]);
    setSelectedId(id);
  }, [setNodes]);

  // `nodes` lu via une ref pour enregistrer les listeners UNE seule fois (pas de ré-abonnement à chaque drag).
  const nodesRef = useRef(nodes);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

  // Insertion d'un bloc SUR une flèche (+) : on remplace l'arête par source->nouveau->target.
  useEffect(() => {
    const onInsert = (ev: Event) => {
      const edgeId = (ev as CustomEvent).detail as string;
      setEdges((eds) => {
        const edge = eds.find((e) => e.id === edgeId);
        if (!edge) return eds;
        const src = nodesRef.current.find((n) => n.id === edge.source);
        const tgt = nodesRef.current.find((n) => n.id === edge.target);
        const nid = uid();
        const x = src && tgt ? (src.position.x + tgt.position.x) / 2 : 120;
        const y = src && tgt ? (src.position.y + tgt.position.y) / 2 : 120;
        setNodes((ns) => [...ns, { id: nid, type: 'wf', position: { x, y }, data: { wfType: 'tag' as WorkflowNodeType } }]);
        setSelectedId(nid);
        return [
          ...eds.filter((e) => e.id !== edgeId),
          { id: uid(), source: edge.source, target: nid, ...EDGE_OPTS },
          { id: uid(), source: nid, target: edge.target, ...EDGE_OPTS },
        ];
      });
    };
    const onDelete = (ev: Event) => {
      const edgeId = (ev as CustomEvent).detail as string;
      setEdges((eds) => eds.filter((e) => e.id !== edgeId));
    };
    window.addEventListener('wf-edge-insert', onInsert);
    window.addEventListener('wf-edge-delete', onDelete);
    return () => { window.removeEventListener('wf-edge-insert', onInsert); window.removeEventListener('wf-edge-delete', onDelete); };
  }, [setEdges, setNodes]);

  const patchSelected = useCallback((p: Record<string, unknown>) => {
    setNodes((ns) => ns.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, ...p } } : n)));
  }, [selectedId, setNodes]);

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    setNodes((ns) => ns.filter((n) => n.id !== selectedId));
    setEdges((eds) => eds.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
  }, [selectedId, setNodes, setEdges]);

  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      await updateWorkflow(tenantId, workflowId, { graph: fromRF(nodes, edges) });
      setMsg('Workflow enregistré.');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Enregistrement impossible');
    } finally {
      setSaving(false);
    }
  }

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-3 lg:h-full">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-500">+ Créer un bloc :</span>
        {NODE_ORDER.map((t) => (
          <button key={t} onClick={() => addNode(t)} className="rounded-md border border-ink-200 px-2 py-1 text-xs text-brand-600 hover:bg-brand-50">
            {NODE_META[t].emoji} {NODE_META[t].label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3">
          {msg && <span className="text-xs text-ink-500">{msg}</span>}
          <button onClick={save} disabled={saving} className="rounded-lg bg-brand-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-600 disabled:opacity-60">{saving ? 'Enregistrement…' : 'Enregistrer'}</button>
        </div>
      </div>

      <div className="flex flex-col gap-3 lg:min-h-0 lg:flex-1 lg:flex-row">
        <div className="h-[70vh] overflow-hidden rounded-2xl border border-ink-200 bg-[#f3f4f6] lg:h-auto lg:min-h-0 lg:flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)}
            onPaneClick={() => setSelectedId(null)}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            defaultEdgeOptions={EDGE_OPTS}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#cbd5e1" gap={18} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <div className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm lg:w-[280px] lg:shrink-0 lg:overflow-y-auto">
          {!selected ? (
            <p className="text-sm text-ink-400">Clique un bloc pour le configurer, ou tire une flèche depuis le point bas d&apos;un bloc vers un autre.</p>
          ) : (
            <ConfigPanel node={selected} onPatch={patchSelected} onDelete={deleteSelected} templates={templates} flows={flows} tags={tags} fields={fields} />
          )}
        </div>
      </div>
    </div>
  );
}

const cls = 'w-full rounded-lg border border-ink-300 px-2.5 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

function ConfigPanel({
  node, onPatch, onDelete, templates, flows, tags, fields,
}: {
  node: RFNode; onPatch: (p: Record<string, unknown>) => void; onDelete: () => void;
  templates: TemplateSummary[]; flows: FlowSummary[]; tags: TagCount[]; fields: UserFieldDef[];
}) {
  const d = node.data as Record<string, unknown>;
  const wfType = (d.wfType as WorkflowNodeType) ?? 'template';
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-ink-900">{NODE_META[wfType].emoji} {NODE_META[wfType].label}</span>
        <button onClick={onDelete} className="text-xs text-coral hover:underline">Supprimer</button>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600">Type de bloc</label>
        <select value={wfType} onChange={(e) => onPatch({ wfType: e.target.value })} className={`${cls} bg-white`}>
          {NODE_ORDER.map((t) => <option key={t} value={t}>{NODE_META[t].label}</option>)}
        </select>
      </div>

      {wfType === 'template' && (
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">Template à envoyer</label>
          <select value={(d.templateName as string) ?? ''} onChange={(e) => { const t = templates.find((x) => x.name === e.target.value); onPatch({ templateName: e.target.value, language: t?.language ?? 'fr', templateButtons: t?.buttons ?? [] }); }} className={`${cls} bg-white`}>
            <option value="">Choisir…</option>
            {templates.map((t) => <option key={t.id || t.name} value={t.name}>{t.name}</option>)}
          </select>
          {Array.isArray(d.templateButtons) && (d.templateButtons as unknown[]).length > 0 && (
            <p className="mt-1 text-[11px] text-ink-400">Chaque bouton de réponse rapide devient une <b>sortie</b> à relier (point à droite du bloc). Les boutons lien/formulaire ne se relient pas.</p>
          )}
        </div>
      )}
      {wfType === 'flow' && (
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">Formulaire (publié)</label>
          <select value={(d.flowId as string) ?? ''} onChange={(e) => { const f = flows.find((x) => x.id === e.target.value); onPatch({ flowId: e.target.value, flowName: f?.name ?? '' }); }} className={`${cls} bg-white`}>
            <option value="">Choisir…</option>
            {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          {flows.length === 0 && <p className="mt-1 text-[11px] text-ink-400">Aucun formulaire publié. Crée-en un dans Contenu &gt; Formulaires.</p>}
        </div>
      )}
      {wfType === 'tag' && (
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">Tag à ajouter</label>
          <input list="wf-tags" value={(d.tag as string) ?? ''} onChange={(e) => onPatch({ tag: e.target.value })} className={cls} placeholder="vip, prospect…" />
          <datalist id="wf-tags">{tags.map((t) => <option key={t.tag} value={t.tag} />)}</datalist>
        </div>
      )}
      {wfType === 'field' && (
        <div className="space-y-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-600">Champ</label>
            <select value={(d.fieldKey as string) ?? ''} onChange={(e) => { const f = fields.find((x) => x.key === e.target.value); onPatch({ fieldKey: e.target.value, fieldLabel: f?.label ?? '' }); }} className={`${cls} bg-white`}>
              <option value="">Choisir…</option>
              {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-600">Valeur</label>
            <input value={(d.value as string) ?? ''} onChange={(e) => onPatch({ value: e.target.value })} className={cls} placeholder="valeur à poser" />
          </div>
        </div>
      )}
      {wfType === 'inbox' && (
        <p className="text-xs text-ink-500">Quand le contact répond (quick-reply), la conversation remonte dans l&apos;inbox pour un humain.</p>
      )}
    </div>
  );
}
