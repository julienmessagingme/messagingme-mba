'use client';

import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, Handle, Position, MarkerType,
  BaseEdge, EdgeLabelRenderer, getBezierPath,
  useNodesState, useEdgesState, addEdge,
  type Node, type Edge, type Connection, type NodeProps, type EdgeProps, type NodeTypes, type EdgeTypes,
  type ReactFlowInstance, type OnConnectEnd,
} from '@xyflow/react';
import {
  updateWorkflow, listTemplates, listFlows, listTags, listUserFields, createTag,
  type WorkflowGraph, type WorkflowNodeType, type TemplateSummary, type FlowSummary, type TagCount, type UserFieldDef,
} from '@/lib/api';
import { useT } from '@/lib/i18n';

type RFNode = Node<Record<string, unknown>>;
type RFEdge = Edge;

// Les libellés portent les DEUX langues ([fr, en]) : NODE_META est une constante module (useT inappelable ici),
// et il est lu par 3 composants -> on résout au rendu via t(...meta.label).
const NODE_META: Record<WorkflowNodeType, { emoji: string; label: [string, string] }> = {
  template: { emoji: '📩', label: ['Envoi template', 'Send template'] },
  quick_message: { emoji: '⚡', label: ['Message rapide', 'Quick message'] },
  inbox: { emoji: '💬', label: ['Inbox', 'Inbox'] },
  flow: { emoji: '📋', label: ['Formulaire', 'Form'] },
  tag: { emoji: '🏷️', label: ['Ajout de tag', 'Add tag'] },
  field: { emoji: '✏️', label: ['Ajout de champ', 'Add field'] },
};
const NODE_ORDER: WorkflowNodeType[] = ['template', 'quick_message', 'flow', 'tag', 'field', 'inbox'];

function uid(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}-${Date.now()}`);
}

function summaryOf(data: Record<string, unknown>, t: (fr: string, en?: string) => string): string {
  const wfType = data.wfType as WorkflowNodeType;
  if (wfType === 'template') return (data.templateName as string) || t('choisir un template…', 'choose a template…');
  if (wfType === 'quick_message') return (data.body as string)?.trim() || t('message + réponses rapides…', 'message + quick replies…');
  if (wfType === 'flow') return (data.flowName as string) || t('choisir un formulaire…', 'choose a form…');
  if (wfType === 'tag') return (data.tag as string) ? `+ ${data.tag as string}` : t('choisir un tag…', 'choose a tag…');
  if (wfType === 'field') return (data.fieldLabel as string) ? `${data.fieldLabel as string} = ${(data.value as string) || '…'}` : t('choisir un champ…', 'choose a field…');
  return t('la conversation arrive en inbox', 'the conversation lands in the inbox');
}

/** Bloc du workflow : carré gris clair, handle cible (haut). Un bloc `template` expose UNE SORTIE PAR BOUTON
 *  quick-reply (handle à droite de la ligne, reliable) ; les boutons URL/formulaire sont montrés grisés, non
 *  reliables (ils sortent de WhatsApp). Les autres types de bloc ont une seule sortie (bas). */
function WFNode({ id, data, selected }: NodeProps) {
  const t = useT();
  const wfType = (data.wfType as WorkflowNodeType) ?? 'template';
  const meta = NODE_META[wfType];
  const buttons = wfType === 'template' && Array.isArray(data.templateButtons)
    ? (data.templateButtons as Array<{ type?: string; text?: string }>)
    : wfType === 'quick_message' && Array.isArray(data.quickReplies)
      ? (data.quickReplies as unknown[]).map((q) => ({ type: 'QUICK_REPLY', text: String(q ?? '') }))
      : [];
  const hasQR = buttons.some((b) => b.type === 'QUICK_REPLY');
  return (
    <div className={`relative w-44 rounded-xl border bg-ink-50 shadow-sm transition ${selected ? 'border-brand-500 ring-2 ring-brand-100' : 'border-ink-300'}`}>
      <Handle type="target" position={Position.Top} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-brand-400" />
      {/* Suppression directe du bloc (sans passer par le menu de droite). nodrag + stopPropagation : ne déclenche ni
          le drag ni la sélection du bloc. Même pattern que le ✕ des arêtes (CustomEvent -> listener parent). */}
      <button
        className="nodrag absolute -right-2 -top-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-ink-300 bg-white text-[11px] text-coral shadow hover:bg-red-50"
        title={t('Supprimer le bloc', 'Delete block')}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('wf-node-delete', { detail: id })); }}
      >✕</button>
      <div className="flex items-center gap-1.5 rounded-t-xl border-b border-ink-200 bg-white px-2 py-1">
        <span className="text-xs">{meta.emoji}</span>
        <span className="truncate text-[11px] font-semibold text-ink-800">{t(...meta.label)}</span>
      </div>
      <div className="truncate px-2 py-1.5 text-[11px] text-ink-500">{summaryOf(data, t)}</div>
      {hasQR ? (
        // Au moins un bouton quick-reply -> une SORTIE par bouton (QR = handle reliable à droite ; URL/flow grisé).
        <div className="border-t border-ink-200">
          {buttons.map((b, i) => {
            const isQR = b.type === 'QUICK_REPLY';
            const icon = b.type === 'URL' ? '🔗' : b.type === 'FLOW' ? '📋' : '↩︎';
            const fallback = b.type === 'URL' ? t('Lien', 'Link') : b.type === 'FLOW' ? t('Formulaire', 'Form') : t('Réponse', 'Reply');
            return (
              <div key={i} className={`relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] first:border-t-0 ${isQR ? 'text-ink-700' : 'text-ink-400'}`}>
                <span className="shrink-0">{icon}</span>
                <span className="truncate">{b.text || fallback}</span>
                {isQR ? (
                  <Handle type="source" id={`btn:${i}`} position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-brand-500" title={`${t('Relier', 'Connect')} « ${b.text || fallback} »`} />
                ) : (
                  <span className="absolute right-[-5px] top-1/2 h-2 w-2 -translate-y-1/2 rounded-full border border-white bg-ink-300" title={t('Bouton URL / formulaire : sort de WhatsApp, non reliable', 'URL / form button: leaves WhatsApp, not connectable')} />
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
                  <span className="truncate">{b.text || (b.type === 'URL' ? t('Lien', 'Link') : t('Formulaire', 'Form'))}</span>
                </div>
              ))}
            </div>
          )}
          <Handle type="source" position={Position.Bottom} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-brand-500" title={t('Tirer une flèche', 'Drag an arrow')} />
        </>
      )}
    </div>
  );
}

/** Arête courbée avec, au milieu, une poubelle (supprimer) et un + (insérer un bloc entre les deux). */
function WFEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd }: EdgeProps) {
  const t = useT();
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ stroke: '#94a3b8', strokeWidth: 2 }} />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute flex gap-1"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          <button onClick={() => window.dispatchEvent(new CustomEvent('wf-edge-insert', { detail: id }))} title={t('Insérer un bloc', 'Insert a block')} className="flex h-5 w-5 items-center justify-center rounded-full border border-ink-300 bg-white text-xs text-brand-600 shadow hover:bg-brand-50">+</button>
          <button onClick={() => window.dispatchEvent(new CustomEvent('wf-edge-delete', { detail: id }))} title={t('Supprimer la flèche', 'Delete arrow')} className="flex h-5 w-5 items-center justify-center rounded-full border border-ink-300 bg-white text-[11px] text-coral shadow hover:bg-red-50">✕</button>
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
  const t = useT();
  const seed = useMemo(() => toRF(initialGraph), [initialGraph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>(seed.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RFEdge>(seed.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

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

  // Persiste un tag saisi inline dans un nœud « ajout de tag » (au blur) -> il apparaît tout de suite dans Contenus >
  // Tags ET dans l'autocomplétion, sans attendre l'enregistrement du workflow (best-effort ; declareTags au save = filet).
  const commitTag = useCallback(async (raw: string) => {
    const clean = raw.trim().slice(0, 64);
    if (!clean || tags.some((t) => t.tag === clean)) return;
    try { await createTag(tenantId, clean); } catch { /* best-effort */ }
    listTags(tenantId).then((r) => setTags(r.tags)).catch(() => {});
  }, [tenantId, tags]);

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

  // Instance React Flow capturée à l'init (pas de ReactFlowProvider parent -> useReactFlow() indisponible) :
  // sert à screenToFlowPosition pour placer le bloc créé au lâcher de flèche.
  const rfRef = useRef<ReactFlowInstance<RFNode, RFEdge> | null>(null);

  // Crée un bloc connecté (à typer ensuite via le panneau de droite). Partagé par le drop de flèche.
  // Réplique l'invariant « une seule arête par (source, sourceHandle) » de onConnect.
  const createConnectedNode = useCallback((wfType: WorkflowNodeType, position: { x: number; y: number }, sourceId: string, sourceHandle?: string) => {
    const nid = uid();
    setNodes((ns) => [...ns, { id: nid, type: 'wf', position, data: { wfType } }]);
    setEdges((eds) => addEdge(
      { id: uid(), source: sourceId, target: nid, ...(sourceHandle ? { sourceHandle } : {}), ...EDGE_OPTS },
      eds.filter((e) => !(e.source === sourceId && (e.sourceHandle ?? null) === (sourceHandle ?? null))),
    ));
    setSelectedId(nid);
  }, [setNodes, setEdges]);

  // Lâcher une flèche dans le VIDE crée un bloc à cet endroit, relié, et le sélectionne -> le panneau de droite
  // s'ouvre sur « Type de bloc » (l'utilisateur choisit le type). Un lâcher sur un handle valide est déjà géré
  // par onConnect (state.isValid) -> on ne double pas. On n'étend que depuis une SORTIE (fromHandle.type source).
  const onConnectEnd = useCallback<OnConnectEnd>((event, state) => {
    if (state.isValid) return;
    const from = state.fromNode;
    const handle = state.fromHandle;
    if (!from || handle?.type !== 'source') return;
    const rf = rfRef.current;
    if (!rf) return;
    const pt = 'changedTouches' in event ? event.changedTouches[0] : event;
    if (!pt) return;
    const p = rf.screenToFlowPosition({ x: pt.clientX, y: pt.clientY });
    createConnectedNode('template', { x: p.x - 88, y: p.y - 20 }, from.id, handle.id ?? undefined);
  }, [createConnectedNode]);

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
    // Suppression d'un bloc via son ✕ : retire le node ET ses arêtes ; déselectionne si c'était lui.
    const onNodeDelete = (ev: Event) => {
      const nodeId = (ev as CustomEvent).detail as string;
      setNodes((ns) => ns.filter((n) => n.id !== nodeId));
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setSelectedId((cur) => (cur === nodeId ? null : cur));
    };
    window.addEventListener('wf-edge-insert', onInsert);
    window.addEventListener('wf-edge-delete', onDelete);
    window.addEventListener('wf-node-delete', onNodeDelete);
    return () => {
      window.removeEventListener('wf-edge-insert', onInsert);
      window.removeEventListener('wf-edge-delete', onDelete);
      window.removeEventListener('wf-node-delete', onNodeDelete);
    };
  }, [setEdges, setNodes, setSelectedId]);

  const patchSelected = useCallback((p: Record<string, unknown>) => {
    setNodes((ns) => ns.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, ...p } } : n)));
  }, [selectedId, setNodes]);

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    setNodes((ns) => ns.filter((n) => n.id !== selectedId));
    setEdges((eds) => eds.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
  }, [selectedId, setNodes, setEdges]);

  // Auto-save : plus de bouton « Enregistrer ». On sauvegarde proactivement ~1,2 s après la dernière édition du
  // graphe, et on FLUSH la sauvegarde en attente au démontage (retour aux scénarios) + sur beforeunload (fermeture
  // d'onglet), sinon les toutes dernières modifs seraient perdues (pire que le bouton manuel).
  const graphRef = useRef({ nodes, edges });
  useEffect(() => { graphRef.current = { nodes, edges }; }, [nodes, edges]);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstRender = useRef(true);

  const doSave = useCallback(async (keepalive = false): Promise<void> => {
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
    // Sérialise : un seul PATCH en vol. Si un save tourne déjà, on marque « sale » et il re-sauvera à la fin avec
    // le graphe le plus récent (évite qu'un PATCH plus ancien réponde après et écrase une version plus récente).
    if (savingRef.current) { dirtyRef.current = true; return; }
    savingRef.current = true;
    dirtyRef.current = false;
    setSaving(true);
    setSaveError(null);
    try {
      await updateWorkflow(tenantId, workflowId, { graph: fromRF(graphRef.current.nodes, graphRef.current.edges) }, keepalive ? { keepalive: true } : undefined);
      setSavedAt(new Date());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('Enregistrement impossible', 'Could not save'));
      dirtyRef.current = true; // laisse une chance au re-save / au retry
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
    // Des modifs sont arrivées PENDANT le save (ou échec) -> re-sauver UNE fois avec le graphe le plus récent.
    if (dirtyRef.current) void doSave(keepalive);
  }, [tenantId, workflowId, t]);

  // doSave via une ref : la planification du debounce ne dépend QUE de [nodes, edges] (pas de doSave), pour ne pas
  // relancer une sauvegarde au simple changement de langue (doSave dépend de `t`).
  const doSaveRef = useRef(doSave);
  useEffect(() => { doSaveRef.current = doSave; }, [doSave]);

  // Planifie une sauvegarde debounce à chaque édition. Skip le rendu INITIAL (chargement du graphe) : on ne
  // sauvegarde pas tant que l'utilisateur n'a rien touché.
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    dirtyRef.current = true;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { void doSaveRef.current(); }, 1200);
  }, [nodes, edges]);

  // Flush au démontage + fermeture d'onglet : si des modifs sont en attente, on sauvegarde tout de suite en
  // `keepalive` (la requête survit au déchargement de la page).
  useEffect(() => {
    const flush = () => { if (dirtyRef.current) void doSaveRef.current(true); };
    window.addEventListener('beforeunload', flush);
    return () => { window.removeEventListener('beforeunload', flush); flush(); };
  }, []);

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  return (
    <div className="flex flex-col gap-3 lg:h-full">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-500">{t('+ Créer un bloc :', '+ Create a block:')}</span>
        {NODE_ORDER.map((nt) => (
          <button key={nt} onClick={() => addNode(nt)} className="rounded-md border border-ink-200 px-2 py-1 text-xs text-brand-600 hover:bg-brand-50">
            {NODE_META[nt].emoji} {t(...NODE_META[nt].label)}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 text-xs">
          {saveError ? (
            <>
              <span className="text-coral">⚠ {t('Échec de l’enregistrement', 'Save failed')}</span>
              <button onClick={() => void doSave()} className="font-medium text-brand-600 hover:underline">{t('réessayer', 'retry')}</button>
            </>
          ) : saving ? (
            <span className="text-ink-400">{t('Enregistrement…', 'Saving…')}</span>
          ) : savedAt ? (
            <span className="text-ink-400">{t('Enregistré', 'Saved')} {savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          ) : (
            <span className="text-ink-400">{t('Enregistrement automatique', 'Auto-save on')}</span>
          )}
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
            onConnectEnd={onConnectEnd}
            onInit={(inst) => { rfRef.current = inst; }}
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
            <p className="text-sm text-ink-400">{t("Clique un bloc pour le configurer. Tire une flèche depuis le point d'un bloc : lâche sur un autre bloc pour relier, ou dans le vide pour créer un nouveau bloc. Le ✕ en coin d'un bloc le supprime.", "Click a block to configure it. Drag an arrow from a block's dot: drop it on another block to connect, or in empty space to create a new block. The ✕ in a block's corner deletes it.")}</p>
          ) : (
            <ConfigPanel node={selected} onPatch={patchSelected} onDelete={deleteSelected} templates={templates} flows={flows} tags={tags} fields={fields} onCommitTag={commitTag} />
          )}
        </div>
      </div>
    </div>
  );
}

const cls = 'w-full rounded-lg border border-ink-300 px-2.5 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

function ConfigPanel({
  node, onPatch, onDelete, templates, flows, tags, fields, onCommitTag,
}: {
  node: RFNode; onPatch: (p: Record<string, unknown>) => void; onDelete: () => void;
  templates: TemplateSummary[]; flows: FlowSummary[]; tags: TagCount[]; fields: UserFieldDef[];
  onCommitTag: (tag: string) => void;
}) {
  const t = useT();
  const d = node.data as Record<string, unknown>;
  const wfType = (d.wfType as WorkflowNodeType) ?? 'template';
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-ink-900">{NODE_META[wfType].emoji} {t(...NODE_META[wfType].label)}</span>
        <button onClick={onDelete} className="text-xs text-coral hover:underline">{t('Supprimer', 'Delete')}</button>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600">{t('Type de bloc', 'Block type')}</label>
        <select value={wfType} onChange={(e) => onPatch({ wfType: e.target.value })} className={`${cls} bg-white`}>
          {NODE_ORDER.map((nt) => <option key={nt} value={nt}>{t(...NODE_META[nt].label)}</option>)}
        </select>
      </div>

      {wfType === 'template' && (
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">{t('Template à envoyer', 'Template to send')}</label>
          <select value={(d.templateName as string) ?? ''} onChange={(e) => { const tpl = templates.find((x) => x.name === e.target.value); onPatch({ templateName: e.target.value, language: tpl?.language ?? 'fr', templateButtons: tpl?.buttons ?? [] }); }} className={`${cls} bg-white`}>
            <option value="">{t('Choisir…', 'Choose…')}</option>
            {templates.map((tpl) => <option key={tpl.id || tpl.name} value={tpl.name}>{tpl.name}</option>)}
          </select>
          {Array.isArray(d.templateButtons) && (d.templateButtons as unknown[]).length > 0 && (
            <p className="mt-1 text-[11px] text-ink-400">{t('Chaque bouton de réponse rapide devient une ', 'Each quick-reply button becomes an ')}<b>{t('sortie', 'output')}</b>{t(' à relier (point à droite du bloc). Les boutons lien/formulaire ne se relient pas.', ' to connect (dot on the right of the block). Link/form buttons cannot be connected.')}</p>
          )}
        </div>
      )}
      {wfType === 'quick_message' && (() => {
        const qr = Array.isArray(d.quickReplies) ? (d.quickReplies as string[]) : [];
        return (
          <div className="space-y-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Message', 'Message')}</label>
              <textarea value={(d.body as string) ?? ''} onChange={(e) => onPatch({ body: e.target.value })} rows={3} className={cls} placeholder={t('Ton message…', 'Your message…')} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Réponses rapides', 'Quick replies')}</label>
              <div className="space-y-1.5">
                {qr.map((r, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input value={r} maxLength={20} onChange={(e) => { const next = [...qr]; next[i] = e.target.value; onPatch({ quickReplies: next }); }} className={cls} placeholder={`${t('Réponse', 'Reply')} ${i + 1}`} />
                    <button type="button" onClick={() => onPatch({ quickReplies: qr.filter((_, j) => j !== i) })} className="shrink-0 text-ink-400 hover:text-coral" aria-label={t('Retirer', 'Remove')}>×</button>
                  </div>
                ))}
              </div>
              {qr.length < 3 && (
                <button type="button" onClick={() => onPatch({ quickReplies: [...qr, ''] })} className="mt-1.5 text-xs text-brand-600 hover:underline">{t('+ réponse rapide', '+ quick reply')}</button>
              )}
              <p className="mt-1 text-[11px] text-ink-400">{t('Max 3, 20 caractères. Chaque réponse devient une sortie à relier (point à droite du bloc).', 'Max 3, 20 characters. Each reply becomes an output to connect (dot on the right of the block).')}</p>
            </div>
          </div>
        );
      })()}
      {wfType === 'flow' && (
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">{t('Formulaire (publié)', 'Form (published)')}</label>
          <select value={(d.flowId as string) ?? ''} onChange={(e) => { const f = flows.find((x) => x.id === e.target.value); onPatch({ flowId: e.target.value, flowName: f?.name ?? '' }); }} className={`${cls} bg-white`}>
            <option value="">{t('Choisir…', 'Choose…')}</option>
            {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          {flows.length === 0 && <p className="mt-1 text-[11px] text-ink-400">{t('Aucun formulaire publié. Crée-en un dans Contenu > Formulaires.', 'No published form. Create one in Content > Forms.')}</p>}
        </div>
      )}
      {wfType === 'tag' && (
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">{t('Tag à ajouter', 'Tag to add')}</label>
          <input
            list="wf-tags"
            value={(d.tag as string) ?? ''}
            onChange={(e) => onPatch({ tag: e.target.value })}
            onBlur={(e) => onCommitTag(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onCommitTag((e.target as HTMLInputElement).value); } }}
            className={cls}
            placeholder={t('vip, prospect…', 'vip, prospect…')}
          />
          <datalist id="wf-tags">{tags.map((tg) => <option key={tg.tag} value={tg.tag} />)}</datalist>
          <p className="mt-1 text-[11px] text-ink-400">{t('Le tag est ajouté à Contenus > Tags dès que tu quittes le champ.', 'The tag is added to Content > Tags as soon as you leave the field.')}</p>
        </div>
      )}
      {wfType === 'field' && (
        <div className="space-y-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-600">{t('Champ', 'Field')}</label>
            <select value={(d.fieldKey as string) ?? ''} onChange={(e) => { const f = fields.find((x) => x.key === e.target.value); onPatch({ fieldKey: e.target.value, fieldLabel: f?.label ?? '' }); }} className={`${cls} bg-white`}>
              <option value="">{t('Choisir…', 'Choose…')}</option>
              {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-600">{t('Valeur', 'Value')}</label>
            <input value={(d.value as string) ?? ''} onChange={(e) => onPatch({ value: e.target.value })} className={cls} placeholder={t('valeur à poser', 'value to set')} />
          </div>
        </div>
      )}
      {wfType === 'inbox' && (
        <p className="text-xs text-ink-500">{t("Quand le contact répond (quick-reply), la conversation remonte dans l'inbox pour un humain.", 'When the contact replies (quick-reply), the conversation moves to the inbox for a human.')}</p>
      )}
    </div>
  );
}
