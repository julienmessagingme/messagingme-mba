'use client';

import '@xyflow/react/dist/style.css';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, Controls, Handle, Position, MarkerType,
  BaseEdge, EdgeLabelRenderer, getBezierPath,
  useNodesState, useEdgesState, addEdge, useUpdateNodeInternals,
  type Node, type Edge, type Connection, type NodeProps, type EdgeProps, type NodeTypes, type EdgeTypes,
  type ReactFlowInstance, type OnConnectEnd,
} from '@xyflow/react';
import {
  updateWorkflow, listTemplates, listFlows, listTags, listUserFields, createTag,
  type WorkflowGraph, type WorkflowNodeType, type TemplateSummary, type FlowSummary, type TagCount, type UserFieldDef,
} from '@/lib/api';
import { useT } from '@/lib/i18n';
import { NODE_META, NODE_ORDER, MBA_NODE_ORDER, RCS_NODE_ORDER, nodeMetaOf } from '@/lib/nodeMeta';
import { isCampaignEligible, waitBeforeSessionMessage, entryNodeOf } from '@/lib/campaign-eligibility';
import { carouselOutputs } from '@/lib/carousel-outputs';
import { carouselButtonHandle } from '@/lib/carousel-handle';
import { autoLayoutHorizontal } from '@/lib/workflow-layout';
import { ConditionBuilder, type ConditionGroup } from './ConditionBuilder';

type RFNode = Node<Record<string, unknown>>;
type RFEdge = Edge;

function uid(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}-${Date.now()}`);
}

/**
 * Config de départ d'un bloc qu'on vient de créer. Partagée par les TROIS chemins de création (palette, lâcher
 * dans le vide, insertion sur une flèche) : sans ça, un bloc « Action » né d'un chemin démarrait sans
 * `actionKind` et restait un no-op silencieux tant qu'on ne l'ouvrait pas.
 */
function initialDataFor(wfType: WorkflowNodeType): Record<string, unknown> {
  if (wfType === 'action') return { wfType, actionKind: 'add_tag' };
  if (wfType === 'wait') return { wfType, delay: 1, unit: 'hours' };
  return { wfType };
}

function summaryOf(data: Record<string, unknown>, t: (fr: string, en?: string) => string): string {
  const wfType = data.wfType as WorkflowNodeType;
  if (wfType === 'template') return (data.templateName as string) || t('choisir un template…', 'choose a template…');
  if (wfType === 'quick_message') return (data.body as string)?.trim() || t('message + réponses rapides…', 'message + quick replies…');
  if (wfType === 'rcs_message') return (data.text as string)?.trim() || t('écrire le message RCS…', 'write the RCS message…');
  if (wfType === 'flow') return (data.flowName as string) || t('choisir un formulaire…', 'choose a form…');
  if (wfType === 'tag') return (data.tag as string) ? `+ ${data.tag as string}` : t('choisir un tag…', 'choose a tag…');
  if (wfType === 'field') {
    const label = data.fieldLabel as string;
    if (!label) return t('choisir un champ…', 'choose a field…');
    return data.valueKind === 'now' ? `${label} = ${t('maintenant', 'now')}` : `${label} = ${(data.value as string) || '…'}`;
  }
  if (wfType === 'action') {
    const kind = data.actionKind as string;
    const tag = (data.tag as string) ?? '';
    const label = (data.fieldLabel as string) ?? '';
    if (kind === 'add_tag') return tag ? `+ ${tag}` : t('ajouter un tag…', 'add a tag…');
    if (kind === 'remove_tag') return tag ? `− ${tag}` : t('retirer un tag…', 'remove a tag…');
    if (kind === 'set_field') return !label ? t('mettre à jour un champ…', 'update a field…') : data.valueKind === 'now' ? `${label} = ${t('maintenant', 'now')}` : `${label} = ${(data.value as string) || '…'}`;
    if (kind === 'clear_field') return label ? `${label} ${t('(vidé)', '(cleared)')}` : t('vider un champ…', 'clear a field…');
    return t('choisir une action…', 'choose an action…');
  }
  if (wfType === 'wait') {
    const n = Number(data.delay ?? 0);
    const u = String(data.unit ?? 'hours');
    if (!Number.isFinite(n) || n <= 0) return t('durée à choisir…', 'set a duration…');
    const lib = u === 'minutes' ? t('min', 'min') : u === 'days' ? t('j', 'd') : t('h', 'h');
    return `${t('attendre', 'wait')} ${n} ${lib}`;
  }
  if (wfType === 'condition') {
    const n = Array.isArray(data.clauses) ? data.clauses.length : 0;
    if (n === 0) return t('définir une condition…', 'set a condition…');
    const m = data.match === 'any' ? t('au moins une', 'at least one') : t('toutes', 'all');
    return n === 1 ? t(`${m} de 1 condition`, `${m} of 1 condition`) : t(`${m} de ${n} conditions`, `${m} of ${n} conditions`);
  }
  // MBA : pré-câblage inerte, le sous-titre le rappelle (le bloc ne fait rien tant que MBA n'est pas actif).
  if (wfType === 'mba_handoff') return t('passe la main à MBA (inerte)', 'hands off to MBA (inert)');
  if (wfType === 'mba_disable') return t('désactive MBA (inerte)', 'disables MBA (inert)');
  return t('la conversation arrive en inbox', 'the conversation lands in the inbox');
}

/**
 * Templates À JOUR, servis aux blocs pour dessiner l'aperçu du message.
 *
 * Pourquoi un contexte et pas les données du bloc : l'aperçu a besoin des IMAGES des cartes, et leurs URL
 * Meta EXPIRENT. Les écrire dans le graphe (que `fromRF` sérialise tel quel) donnerait des vignettes mortes
 * au bout de quelques heures. Le graphe ne garde donc que ce qui est stable (nom des sorties, libellés), et
 * le visuel est relu à chaque affichage.
 */
const TemplatesCtx = createContext<TemplateSummary[]>([]);

/** Bloc du workflow : carré gris clair, handle cible (haut). Un bloc `template` montre l'APERÇU du message et
 *  expose UNE SORTIE PAR BOUTON quick-reply (handle à droite de la ligne, reliable) ; les boutons URL/formulaire
 *  sont montrés grisés, non reliables (ils sortent de WhatsApp). Les autres blocs ont une seule sortie (bas). */
function WFNode({ id, data, selected }: NodeProps) {
  const t = useT();
  const templates = useContext(TemplatesCtx);
  const updateNodeInternals = useUpdateNodeInternals();
  const wfType = (data.wfType as WorkflowNodeType) ?? 'template';
  const meta = nodeMetaOf(wfType); // tolérant : un type pas encore connu du front (ex. condition) -> repli neutre
  // Un template CAROUSEL n'a aucun bouton de premier niveau : ses boutons vivent dans les cartes, et chacun
  // vaut une sortie (10 cartes x 2 boutons = 20 destinations). `templateCards` sert UNIQUEMENT à dessiner ces
  // sorties : le moteur d'envoi ne lit que `templateButtons`, qui reste vide pour un carousel (sinon on
  // émettrait des boutons de premier niveau que ce template n'a pas, et Meta refuserait l'envoi).
  type NodeButton = { type?: string; text?: string; handle?: string; cardIndex?: number };
  // Aperçu du message : lu sur le template VIVANT (les URL d'image expirent, cf. TemplatesCtx).
  const live = wfType === 'template' && data.templateName ? templates.find((x) => x.name === data.templateName) : undefined;
  const liveCards = live?.carousel?.cards ?? [];
  const showCarousel = liveCards.length > 0;
  // Sorties : celles enregistrées dans le bloc, sinon DÉDUITES du template vivant. Ce repli évite d'avoir à
  // re-sélectionner son template dans chaque scénario déjà construit pour voir apparaître les sorties.
  const stored: NodeButton[] = wfType === 'template' && Array.isArray(data.templateCards) ? (data.templateCards as NodeButton[]) : [];
  const cards: NodeButton[] = stored.length > 0 ? stored : showCarousel ? carouselOutputs(live) : [];
  const buttons: NodeButton[] = cards.length > 0
    ? cards
    : wfType === 'template' && Array.isArray(data.templateButtons)
      ? (data.templateButtons as NodeButton[])
      : wfType === 'quick_message' && Array.isArray(data.quickReplies)
        ? (data.quickReplies as unknown[]).map((q): NodeButton => ({ type: 'QUICK_REPLY', text: String(q ?? '') }))
        : [];
  const hasQR = buttons.some((b) => b.type === 'QUICK_REPLY');
  const isCondition = wfType === 'condition';
  const isRcs = wfType === 'rcs_message';
  // Sous un aperçu de carousel, on ne liste QUE ce qui se relie : les boutons lien sont déjà visibles dans
  // l'aperçu, les répéter ici doublerait la hauteur du bloc pour des lignes sur lesquelles on ne peut rien
  // tirer. Hors carousel il n'y a pas d'aperçu, donc on les garde pour le contexte.
  const outputRows = showCarousel ? buttons.filter((b) => b.type === 'QUICK_REPLY') : buttons;

  // Faire défiler l'aperçu ne bouge AUCUNE poignée (elles sont hors de la zone), mais le nombre de sorties
  // change quand on choisit un autre template : React Flow doit alors re-mesurer, sinon les flèches gardent
  // les anciennes positions.
  const handleSig = buttons.map((b, i) => b.handle ?? `btn:${i}`).join(',');
  useEffect(() => { updateNodeInternals(id); }, [handleSig, id, updateNodeInternals]);

  return (
    <div className={`relative ${showCarousel ? 'w-52' : 'w-44'} rounded-xl border bg-ink-50 shadow-sm transition ${selected ? 'border-brand-500 ring-2 ring-brand-100' : 'border-ink-300'}`}>
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
        <span className="truncate text-[11px] font-semibold text-ink-800">{String(data.name ?? '').trim() || t(...meta.label)}</span>
      </div>
      <div className="truncate px-2 py-1.5 text-[11px] text-ink-500">{summaryOf(data, t)}</div>
      {showCarousel ? (
        // Aperçu CAROUSEL : bulle d'introduction puis les cartes, EMPILÉES et défilables. Les afficher côte à
        // côte rendrait le bloc large comme 10 cartes ; ici il garde sa taille et on fait défiler.
        <div className="border-t border-ink-200 p-1.5" style={{ backgroundColor: '#efeae2' }}>
          {String(live?.body ?? '').trim() && (
            <div className="mb-1 rounded rounded-tl-none bg-white px-1.5 py-1 text-[9px] leading-snug text-ink-700 shadow-sm">
              <span className="line-clamp-2">{live?.body}</span>
            </div>
          )}
          {/* `nowheel` : la molette fait défiler les cartes au lieu de zoomer le canevas (classe React Flow). */}
          <div className="nowheel max-h-32 space-y-1.5 overflow-y-auto pr-0.5">
            {liveCards.map((card, ci) => (
              <div key={ci} className="overflow-hidden rounded bg-white shadow-sm">
                <div className="flex h-14 w-full items-center justify-center bg-ink-100 text-[9px] text-ink-400">
                  {card.mediaUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={card.mediaUrl} alt={`${t('Carte', 'Card')} ${ci + 1}`} referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                  ) : (
                    t('image', 'image')
                  )}
                </div>
                {String(card.body ?? '').trim() && (
                  <div className="px-1.5 py-1 text-[9px] leading-snug text-ink-700"><span className="line-clamp-2">{card.body}</span></div>
                )}
                {/* Les boutons sont montrés ICI pour l'aperçu, mais les POINTS DE LIAISON sont plus bas, hors
                    de la zone qui défile : une poignée sortie du cadre est mesurée à sa position de mise en
                    page (jusqu'à ~600 px sous le bloc, mesuré), et la flèche partirait dans le vide. */}
                {(card.buttons ?? []).map((b, bi) => (
                  <div key={bi} className={`flex items-center gap-1 border-t border-ink-100 px-1.5 py-1 text-[9px] ${b.type === 'QUICK_REPLY' ? 'font-medium text-[#00a5f4]' : 'text-ink-400'}`}>
                    <span className="shrink-0">{b.type === 'QUICK_REPLY' ? '↩︎' : '🔗'}</span>
                    <span className="truncate">{b.text?.trim() || (b.type === 'QUICK_REPLY' ? t('Réponse', 'Reply') : t('Lien', 'Link'))}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {hasQR ? (
        // Au moins un bouton quick-reply -> une SORTIE par bouton (QR = handle reliable à droite ; URL/flow grisé).
        <div className="border-t border-ink-200">
          {outputRows.map((b, i) => {
            const isQR = b.type === 'QUICK_REPLY';
            const icon = b.type === 'URL' ? '🔗' : b.type === 'FLOW' ? '📋' : '↩︎';
            const fallback = b.type === 'URL' ? t('Lien', 'Link') : b.type === 'FLOW' ? t('Formulaire', 'Form') : t('Réponse', 'Reply');
            return (
              <div key={i} className={`relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] first:border-t-0 ${isQR ? 'text-ink-700' : 'text-ink-400'}`}>
                <span className="shrink-0">{icon}</span>
                {b.cardIndex !== undefined && <span className="shrink-0 rounded bg-ink-200 px-1 text-[9px] font-medium text-ink-600">C{b.cardIndex + 1}</span>}
                <span className="truncate">{b.text || fallback}</span>
                {isQR ? (
                  // Le nom de la sortie DOIT être celui que l'envoi pose en payload, sinon le tap ne retrouve
                  // pas sa branche : `handle` vient du template (carousel), sinon l'index du bouton.
                  <Handle type="source" id={b.handle ?? `btn:${i}`} position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-brand-500" title={`${t('Relier', 'Connect')} « ${b.text || fallback} »`} />
                ) : (
                  <span className="absolute right-[-5px] top-1/2 h-2 w-2 -translate-y-1/2 rounded-full border border-white bg-ink-300" title={t('Bouton URL / formulaire : sort de WhatsApp, non reliable', 'URL / form button: leaves WhatsApp, not connectable')} />
                )}
              </div>
            );
          })}
        </div>
      ) : isRcs ? (
        // Bloc RCS : DEUX sorties fixes, à droite. Les id 'sent'/'unreachable' sont ceux que l'exécuteur
        // route (walkResolved). « Non joignable » est la sortie qui permet de brancher un repli WhatsApp :
        // c'est elle qui fait la cascade RCS -> WhatsApp, visible dans le graphe au lieu d'être cachée.
        <div className="border-t border-ink-200">
          <div className="relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] font-medium text-emerald-700 first:border-t-0">
            <span className="shrink-0">✓</span>
            <span className="truncate">{t('Envoyé', 'Sent')}</span>
            <Handle type="source" id="sent" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-emerald-500" title={t('Le message RCS est parti', 'The RCS message was sent')} />
          </div>
          <div className="relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] font-medium text-coral first:border-t-0">
            <span className="shrink-0">✕</span>
            <span className="truncate">{t('Non joignable en RCS', 'Not reachable on RCS')}</span>
            <Handle type="source" id="unreachable" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-coral" title={t('Le contact n’est pas joignable en RCS : brancher un repli', 'Contact not reachable on RCS: connect a fallback')} />
          </div>
        </div>
      ) : isCondition ? (
        // Node condition : DEUX sorties fixes, à droite. Les id 'true'/'false' sont ceux que le moteur route
        // (engine.walk). Chaque sortie se relie à un bloc différent.
        <div className="border-t border-ink-200">
          <div className="relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] font-medium text-emerald-700 first:border-t-0">
            <span className="shrink-0">✓</span>
            <span className="truncate">{t('Si réunie', 'If met')}</span>
            <Handle type="source" id="true" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-emerald-500" title={t('Si la condition est réunie', 'If the condition is met')} />
          </div>
          <div className="relative flex items-center gap-1 border-t border-ink-100 px-2 py-1 text-[10px] font-medium text-coral first:border-t-0">
            <span className="shrink-0">✕</span>
            <span className="truncate">{t('Sinon', 'Otherwise')}</span>
            <Handle type="source" id="false" position={Position.Right} className="!h-2.5 !w-2.5 !border-2 !border-white !bg-coral" title={t('Sinon (condition non réunie)', 'Otherwise (condition not met)')} />
          </div>
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
          <button onClick={(ev) => window.dispatchEvent(new CustomEvent('wf-edge-insert', { detail: { edgeId: id, screenX: ev.clientX, screenY: ev.clientY } }))} title={t('Insérer un bloc', 'Insert a block')} className="flex h-5 w-5 items-center justify-center rounded-full border border-ink-300 bg-white text-xs text-brand-600 shadow hover:bg-brand-50">+</button>
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
export function WorkflowBuilder({ tenantId, workflowId, initialGraph, mbaEnabled = false, rcsEnabled = false }: { tenantId: string; workflowId: string; initialGraph: WorkflowGraph; mbaEnabled?: boolean; rcsEnabled?: boolean }) {
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
    setNodes((ns) => [...ns, { id, type: 'wf', position: { x: 60 + (ns.length % 4) * 60, y: 60 + ns.length * 30 }, data: initialDataFor(wfType) }]);
    setSelectedId(id);
  }, [setNodes]);

  // Instance React Flow capturée à l'init (pas de ReactFlowProvider parent -> useReactFlow() indisponible) :
  // sert à screenToFlowPosition pour placer le bloc créé au lâcher de flèche.
  const rfRef = useRef<ReactFlowInstance<RFNode, RFEdge> | null>(null);

  // Crée un bloc connecté, du type DÉJÀ choisi par l'utilisateur (le panneau de droite ne type plus).
  // Réplique l'invariant « une seule arête par (source, sourceHandle) » de onConnect.
  const createConnectedNode = useCallback((wfType: WorkflowNodeType, position: { x: number; y: number }, sourceId: string, sourceHandle?: string) => {
    const nid = uid();
    setNodes((ns) => [...ns, { id: nid, type: 'wf', position, data: initialDataFor(wfType) }]);
    setEdges((eds) => addEdge(
      { id: uid(), source: sourceId, target: nid, ...(sourceHandle ? { sourceHandle } : {}), ...EDGE_OPTS },
      eds.filter((e) => !(e.source === sourceId && (e.sourceHandle ?? null) === (sourceHandle ?? null))),
    ));
    setSelectedId(nid);
  }, [setNodes, setEdges]);

  /** Choix de la NATURE d'un bloc en cours de création (lâcher dans le vide, ou + sur une flèche). */
  type Chooser =
    | { kind: 'connect'; x: number; y: number; screenX: number; screenY: number; sourceId: string; sourceHandle?: string }
    | { kind: 'insert'; edgeId: string; screenX: number; screenY: number };
  const [chooser, setChooser] = useState<Chooser | null>(null);

  /** Insère un bloc du type choisi AU MILIEU d'une flèche : source -> nouveau -> cible. */
  const insertOnEdge = useCallback((edgeId: string, wfType: WorkflowNodeType) => {
    setEdges((eds) => {
      const edge = eds.find((e) => e.id === edgeId);
      if (!edge) return eds;
      const src = nodesRef.current.find((n) => n.id === edge.source);
      const tgt = nodesRef.current.find((n) => n.id === edge.target);
      const nid = uid();
      const x = src && tgt ? (src.position.x + tgt.position.x) / 2 : 120;
      const y = src && tgt ? (src.position.y + tgt.position.y) / 2 : 120;
      setNodes((ns) => [...ns, { id: nid, type: 'wf', position: { x, y }, data: initialDataFor(wfType) }]);
      setSelectedId(nid);
      return [
        ...eds.filter((e) => e.id !== edgeId),
        // La moitié AMONT hérite du sourceHandle d'origine ('true'/'false' d'une condition, 'card:i:btn:j' d'un
        // bouton) : sans ça, insérer un bloc sur la branche « Si réunie » la déconnecterait silencieusement.
        { id: uid(), source: edge.source, target: nid, ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}), ...EDGE_OPTS },
        { id: uid(), source: nid, target: edge.target, ...EDGE_OPTS },
      ];
    });
  }, [setEdges, setNodes]);

  /** Applique le type choisi au bloc en attente de création, puis referme la liste. */
  const pickType = useCallback((wfType: WorkflowNodeType) => {
    setChooser((c) => {
      if (!c) return null;
      if (c.kind === 'connect') createConnectedNode(wfType, { x: c.x, y: c.y }, c.sourceId, c.sourceHandle);
      else insertOnEdge(c.edgeId, wfType);
      return null;
    });
  }, [createConnectedNode, insertOnEdge]);

  // Lâcher une flèche dans le VIDE ouvre la liste des natures de bloc à cet endroit ; le bloc n'est créé
  // qu'une fois la nature choisie. Un lâcher sur un handle valide est déjà géré par onConnect (state.isValid)
  // -> on ne double pas. On n'étend que depuis une SORTIE (fromHandle.type source).
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
    // On NE DEVINE PLUS le type : on propose la liste. Le panneau de droite ne sert plus qu'à configurer,
    // donc si on choisissait à la place de l'utilisateur, il n'aurait plus aucun moyen de corriger.
    setChooser({ kind: 'connect', x: p.x - 88, y: p.y - 20, screenX: pt.clientX, screenY: pt.clientY, sourceId: from.id, ...(handle.id ? { sourceHandle: handle.id } : {}) });
  }, []);

  // `nodes` lu via une ref pour enregistrer les listeners UNE seule fois (pas de ré-abonnement à chaque drag).
  const nodesRef = useRef(nodes);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

  // Insertion d'un bloc SUR une flèche (+) : on remplace l'arête par source->nouveau->target.
  useEffect(() => {
    // Insérer sur une flèche demande AUSSI la nature du bloc (même raison que le lâcher dans le vide).
    const onInsert = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { edgeId: string; screenX: number; screenY: number };
      setChooser({ kind: 'insert', edgeId: detail.edgeId, screenX: detail.screenX, screenY: detail.screenY });
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
    let echoue = false;
    try {
      await updateWorkflow(tenantId, workflowId, { graph: fromRF(graphRef.current.nodes, graphRef.current.edges) }, keepalive ? { keepalive: true } : undefined);
      setSavedAt(new Date());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : t('Enregistrement impossible', 'Could not save'));
      dirtyRef.current = true; // laisse une chance au prochain debounce / au bouton « réessayer »
      echoue = true;
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
    // Des modifs arrivées PENDANT le save -> re-sauver UNE fois avec le graphe le plus récent.
    //
    // ⚠️ JAMAIS après un ÉCHEC. Le drapeau « sale » est alors posé par l'échec lui-même, donc relancer ici
    // bouclait à l'infini, sans aucun délai, sur toute erreur persistante (session expirée en tête), et même
    // après démontage du composant. C'est le bouton « réessayer » et le prochain debounce qui reprennent.
    if (dirtyRef.current && !echoue) void doSave(keepalive);
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

  // Bloc RACINE (sans arête entrante) + éligibilité CAMPAGNE, calculée avec le MÊME helper que le sélecteur de
  // campagne (source unique : `isCampaignEligible`). Depuis le 2026-08-15, la règle porte sur ce qui OUVRE et
  // non sur la racine : « tag -> template » est éligible. L'avertissement reste posé sur la racine, faute d'un
  // bloc fautif unique (l'inéligibilité peut venir d'une branche, d'une attente ou d'une ambiguïté).
  // Mémoïsé : ces calculs ne dépendent QUE du graphe, alors que le composant re-rend aussi sur la
  // sélection, l'ouverture du chooser, le statut de sauvegarde ou l'arrivée des templates.
  const graphe = useMemo(() => fromRF(nodes, edges), [nodes, edges]);
  // `entryNodeOf` porte déjà cette règle (« bloc sans arête entrante, sinon le premier »), elle est testée, et
  // elle sert juste en dessous à juger l'éligibilité : la réécrire ici en ferait une seconde version.
  const rootNodeId = entryNodeOf(graphe)?.id ?? null;
  const campaignEligible = nodes.length === 0 || isCampaignEligible(graphe);
  // Montage qui ne partira JAMAIS : attente >= 24 h puis message hors template. Nommé au constructeur plutôt
  // que découvert par le silence en production. N'empêche PAS l'enregistrement (le builder sauve en continu).
  const montageImpossible = useMemo(() => waitBeforeSessionMessage(graphe), [graphe]);
  const nomDuBloc = (id: string): string => {
    const n = nodes.find((x) => x.id === id);
    const propre = String(n?.data?.name ?? '').trim();
    return propre || t(...nodeMetaOf(((n?.data?.wfType as WorkflowNodeType) ?? 'template')).label);
  };

  // Auto-arranger : recalcule les positions (couches horizontales) et recadre. Le changement de position est
  // capté par l'auto-save existant (effet sur [nodes, edges]) -> persistance automatique, aucun appel API dédié.
  function autoArrange() {
    const layout = autoLayoutHorizontal(
      nodes.map((n) => ({ id: n.id })),
      edges.map((e) => ({ source: e.source, target: e.target })),
    );
    setNodes((ns) => ns.map((n) => { const p = layout.get(n.id); return p ? { ...n, position: p } : n; }));
    requestAnimationFrame(() => rfRef.current?.fitView({ padding: 0.2, duration: 300 }));
  }

  return (
    <div className="flex flex-col gap-3 lg:h-full">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-500">{t('+ Créer un bloc :', '+ Create a block:')}</span>
        {NODE_ORDER.map((nt) => (
          <button key={nt} data-testid={`add-node-${nt}`} onClick={() => addNode(nt)} className="rounded-md border border-ink-200 px-2 py-1 text-xs text-brand-600 hover:bg-brand-50">
            {NODE_META[nt].emoji} {t(...NODE_META[nt].label)}
          </button>
        ))}
        {/* Bloc RCS : GRISÉ + non cliquable tant qu'aucun agent RCS n'est rattaché au tenant. Le canal est
            complet côté outil, mais rien ne peut partir avant qu'un agent soit déposé et approuvé par Google
            et les opérateurs. Le bloc reste visible pour préparer ses scénarios. */}
        {RCS_NODE_ORDER.map((nt) => (
          <button
            key={nt}
            data-testid={`add-node-${nt}`}
            onClick={() => { if (rcsEnabled) addNode(nt); }}
            disabled={!rcsEnabled}
            title={rcsEnabled ? undefined : t('Disponible quand votre agent RCS sera déposé et validé', 'Available once your RCS agent is filed and approved')}
            className="rounded-md border border-dashed border-ink-200 px-2 py-1 text-xs text-ink-400 disabled:cursor-not-allowed disabled:opacity-60 enabled:text-brand-600 enabled:hover:bg-brand-50"
          >
            {NODE_META[nt].emoji} {t(...NODE_META[nt].label)}
          </button>
        ))}
        {/* Blocs MBA : pré-câblage inerte. GRISÉS + non cliquables tant que MBA n'est pas actif chez le tenant
            (agent_eligibility 403 / ToS non signées). Visibles pour préparer, non exploitables. */}
        {MBA_NODE_ORDER.map((nt) => (
          <button
            key={nt}
            data-testid={`add-node-${nt}`}
            onClick={() => { if (mbaEnabled) addNode(nt); }}
            disabled={!mbaEnabled}
            title={mbaEnabled ? undefined : t('Disponible quand MBA sera actif sur votre numéro', 'Available once MBA is active on your number')}
            className="rounded-md border border-dashed border-ink-200 px-2 py-1 text-xs text-ink-400 disabled:cursor-not-allowed disabled:opacity-60 enabled:text-brand-600 enabled:hover:bg-brand-50"
          >
            {NODE_META[nt].emoji} {t(...NODE_META[nt].label)}
          </button>
        ))}
        <button
          onClick={autoArrange}
          disabled={nodes.length === 0}
          className="rounded-md border border-ink-200 px-2 py-1 text-xs text-ink-600 hover:bg-ink-50 disabled:opacity-40"
          title={t('Aligner les blocs automatiquement (disposition horizontale)', 'Auto-arrange blocks (horizontal layout)')}
          data-testid="workflow-autoarrange"
        >
          ⇥ {t('Auto-arranger', 'Auto-arrange')}
        </button>
        {/* Indicateur d'enregistrement. Il existait déjà, mais placé en FIN de cette rangée, après une douzaine
            de boutons : sur un écran étroit il passait à la ligne et sortait du champ de vision, d'où le doute
            « est-ce que mon scénario est enregistré ». Il est désormais toujours VISIBLE (fond, bordure) et son
            état au repos DIT qu'il n'y a rien à cliquer, au lieu d'un simple « Enregistrement automatique »
            qu'on pouvait lire comme une option à activer. */}
        <div className="ml-auto flex shrink-0 items-center gap-2 rounded-lg border border-ink-200 bg-white px-2.5 py-1 text-xs" data-testid="workflow-autosave">
          {saveError ? (
            <>
              <span className="font-medium text-coral">⚠ {t('Échec de l’enregistrement', 'Save failed')}</span>
              <button onClick={() => void doSave()} className="font-medium text-brand-600 hover:underline">{t('réessayer', 'retry')}</button>
            </>
          ) : saving ? (
            <span className="text-ink-500">{t('Enregistrement…', 'Saving…')}</span>
          ) : savedAt ? (
            <span className="text-mint-700">✓ {t('Enregistré à', 'Saved at')} {savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          ) : (
            <span className="text-ink-500">✓ {t('Enregistrement automatique, aucun bouton à cliquer', 'Saved automatically, no button to click')}</span>
          )}
        </div>
      </div>

      {montageImpossible && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <b>{t('Ce montage ne partira pas.', 'This setup will not be sent.')}</b>{' '}
          {t(
            `Le bloc « ${nomDuBloc(montageImpossible.waitNodeId)} » attend 24 h ou plus, puis « ${nomDuBloc(montageImpossible.messageNodeId)} » envoie un message hors template. Passé 24 h sans nouveau message du contact, WhatsApp n'accepte plus qu'un template. Remplace ce bloc par un envoi de template, ou raccourcis l'attente.`,
            `Block “${nomDuBloc(montageImpossible.waitNodeId)}” waits 24h or more, then “${nomDuBloc(montageImpossible.messageNodeId)}” sends a non-template message. After 24h without a new message from the contact, WhatsApp only accepts templates. Replace that block with a template, or shorten the wait.`,
          )}
        </div>
      )}

      <div className="flex flex-col gap-3 lg:min-h-0 lg:flex-1 lg:flex-row">
        <div className="h-[70vh] overflow-hidden rounded-2xl border border-ink-200 bg-[#f3f4f6] lg:h-auto lg:min-h-0 lg:flex-1">
          <TemplatesCtx.Provider value={templates}>
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
          </TemplatesCtx.Provider>
          {/* Choix de la NATURE du bloc qu'on vient de créer. Même liste que la palette (NODE_ORDER, source
              unique) : c'est le SEUL endroit où l'on choisit un type, le panneau de droite ne fait que configurer. */}
          {chooser && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setChooser(null)} />
              <div
                data-testid="node-type-chooser"
                className="fixed z-50 w-52 rounded-xl border border-ink-200 bg-white p-1.5 shadow-lg"
                // Bornée à la fenêtre : lâcher une flèche en bas ou à droite du canevas sortait la liste de
                // l'écran, donc rendait le bloc impossible à choisir.
                style={{
                  left: Math.max(8, Math.min(chooser.screenX, (typeof window !== 'undefined' ? window.innerWidth : 1280) - 220)),
                  top: Math.max(8, Math.min(chooser.screenY, (typeof window !== 'undefined' ? window.innerHeight : 800) - 300)),
                }}
              >
                <p className="px-2 py-1 text-[11px] font-medium text-ink-500">{t('Quel bloc ?', 'Which block?')}</p>
                {NODE_ORDER.map((nt) => (
                  <button
                    key={nt}
                    data-testid={`node-type-${nt}`}
                    onClick={() => pickType(nt)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-ink-700 transition hover:bg-brand-50"
                  >
                    <span>{NODE_META[nt].emoji}</span>
                    <span>{t(...NODE_META[nt].label)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="rounded-2xl border border-ink-200 bg-white p-4 shadow-sm lg:w-[280px] lg:shrink-0 lg:overflow-y-auto">
          {!selected ? (
            <p className="text-sm text-ink-400">{t("Clique un bloc pour le configurer. Tire une flèche depuis le point d'un bloc : lâche sur un autre bloc pour relier, ou dans le vide pour créer un nouveau bloc. Le ✕ en coin d'un bloc le supprime.", "Click a block to configure it. Drag an arrow from a block's dot: drop it on another block to connect, or in empty space to create a new block. The ✕ in a block's corner deletes it.")}</p>
          ) : (
            <ConfigPanel node={selected} isRoot={selected.id === rootNodeId} campaignEligible={campaignEligible} onPatch={patchSelected} onDelete={deleteSelected} templates={templates} flows={flows} tags={tags} fields={fields} onCommitTag={commitTag} />
          )}
        </div>
      </div>
    </div>
  );
}

const cls = 'w-full rounded-lg border border-ink-300 px-2.5 py-1.5 text-sm outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

/**
 * Choix d'un tag, avec suggestions. Partagé par le bloc Action et par le bloc `tag` LEGACY (retiré de la
 * palette mais rendu à vie pour les anciens graphes) : les deux en portaient une copie, et elles avaient déjà
 * commencé à diverger.
 *
 * `onCommit` n'est fourni que pour un AJOUT : quitter le champ crée alors le tag dans Contenu > Tags. Sur un
 * retrait, il n'y a rien à créer.
 */
function TagPicker({ label, value, tags, onChange, onCommit }: {
  label: string;
  value: string;
  tags: TagCount[];
  onChange: (v: string) => void;
  onCommit?: (v: string) => void;
}) {
  const t = useT();
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-ink-600">{label}</label>
      <input
        list="wf-tags"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => onCommit?.(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onCommit?.((e.target as HTMLInputElement).value); } }}
        className={cls}
        placeholder={t('vip, prospect…', 'vip, prospect…')}
      />
      <datalist id="wf-tags">{tags.map((tg) => <option key={tg.tag} value={tg.tag} />)}</datalist>
      {onCommit && <p className="mt-1 text-[11px] text-ink-400">{t('Le tag est ajouté à Contenus > Tags dès que tu quittes le champ.', 'The tag is added to Content > Tags as soon as you leave the field.')}</p>}
    </div>
  );
}

/**
 * Choix d'un champ de contact, et (si `avecValeur`) de la valeur à y poser : fixe, ou l'instant du passage.
 * Partagé par le bloc Action (`set_field` / `clear_field`) et par le bloc `field` LEGACY.
 */
function FieldValueEditor({ d, fields, onPatch, avecValeur }: {
  d: Record<string, unknown>;
  fields: UserFieldDef[];
  onPatch: (p: Record<string, unknown>) => void;
  avecValeur: boolean;
}) {
  const t = useT();
  return (
    <div className="space-y-2">
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600">{t('Champ', 'Field')}</label>
        <select
          value={(d.fieldKey as string) ?? ''}
          onChange={(e) => { const f = fields.find((x) => x.key === e.target.value); onPatch({ fieldKey: e.target.value, fieldLabel: f?.label ?? '' }); }}
          className={`${cls} bg-white`}
        >
          <option value="">{t('Choisir…', 'Choose…')}</option>
          {fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </select>
      </div>
      {avecValeur && (
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">{t('Valeur', 'Value')}</label>
          <select value={d.valueKind === 'now' ? 'now' : 'fixed'} onChange={(e) => onPatch({ valueKind: e.target.value === 'now' ? 'now' : 'fixed' })} className={`${cls} bg-white`}>
            <option value="fixed">{t('valeur fixe', 'fixed value')}</option>
            <option value="now">{t('maintenant (date + heure)', 'now (date + time)')}</option>
          </select>
          {d.valueKind === 'now' ? (
            <p className="mt-1.5 text-[11px] text-ink-400">{t('Pose la date et l’heure du moment où le contact atteint ce bloc — utile pour une condition « avant / après ».', 'Sets the date and time when the contact reaches this block — useful for a “before / after” condition.')}</p>
          ) : (
            <input value={(d.value as string) ?? ''} onChange={(e) => onPatch({ value: e.target.value })} className={`${cls} mt-1.5`} placeholder={t('valeur à poser', 'value to set')} />
          )}
        </div>
      )}
    </div>
  );
}

function ConfigPanel({
  node, isRoot, campaignEligible, onPatch, onDelete, templates, flows, tags, fields, onCommitTag,
}: {
  node: RFNode;
  /** Ce bloc est-il la RACINE du scénario (sans arête entrante) ? C'est lui que la règle campagne regarde. */
  isRoot: boolean;
  /** Le scénario est-il lançable en campagne broadcast (ce qui OUVRE doit être un template configuré) ? */
  campaignEligible: boolean;
  onPatch: (p: Record<string, unknown>) => void; onDelete: () => void;
  templates: TemplateSummary[]; flows: FlowSummary[]; tags: TagCount[]; fields: UserFieldDef[];
  onCommitTag: (tag: string) => void;
}) {
  const t = useT();
  const d = node.data as Record<string, unknown>;
  const wfType = (d.wfType as WorkflowNodeType) ?? 'template';
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-ink-900">{nodeMetaOf(wfType).emoji} {t(...nodeMetaOf(wfType).label)}</span>
        <button onClick={onDelete} className="text-xs text-coral hover:underline">{t('Supprimer', 'Delete')}</button>
      </div>

      {/* Lot D : ouvrir sur autre chose qu'un template est désormais AUTORISÉ (l'enregistrement passe). Ce n'est
          plus une erreur mais une CONSÉQUENCE à connaître : le scénario sort du champ des campagnes broadcast.
          L'avertissement se pose sur la RACINE et suit la MÊME règle que le sélecteur de campagne
          (`isCampaignEligible`), donc il couvre aussi « tag -> template » et un template sans nom choisi. */}
      {isRoot && !campaignEligible && (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-800">
          {wfType === 'template'
            ? t('Choisis le template de ce bloc : tant qu’il est vide, ce scénario ne pourra pas être lancé en campagne.',
                'Pick this block’s template: while it is empty, this scenario cannot be launched as a campaign.')
            : t('Ce scénario ne pourra pas être lancé en campagne : une campagne part sur une audience froide, donc le PREMIER message envoyé doit être un template. Un tag, une action ou une condition avant lui ne posent aucun problème. Il reste utilisable quand le contact vient d’écrire.',
                'This scenario cannot be launched as a campaign: a campaign targets a cold audience, so the FIRST message sent must be a template. A tag, an action or a condition before it is fine. It stays usable when the contact has just written.')}
        </p>
      )}

      <div>
        <label className="mb-1 block text-xs font-medium text-ink-600">{t('Nom du bloc', 'Block name')}</label>
        <input value={(d.name as string) ?? ''} maxLength={64} onChange={(e) => onPatch({ name: e.target.value })} className={cls} placeholder={t('optionnel (ex. « Relance J+3 »)', 'optional (e.g. “Follow-up D+3”)')} />
      </div>

      {/* La NATURE d'un bloc se choisit à sa CRÉATION (palette, ou liste proposée quand on tire une flèche) et
          ne se change plus ici : ce panneau ne sert qu'à configurer. Changer le type d'un bloc déjà relié
          laissait derrière lui de la config d'un autre type et des sorties devenues fausses. */}
      <div className="flex items-center gap-2">
        <span className="text-xs">{nodeMetaOf(wfType).emoji}</span>
        <span className="text-xs font-medium text-ink-600">{t(...nodeMetaOf(wfType).label)}</span>
        {typeof d.code === 'string' && d.code !== '' && (
          <span className="ml-auto font-mono text-[10px] text-ink-300" title={t('Code public (API) du bloc, posé au 1er enregistrement', 'Public code (API) of the block, set on first save')}>{d.code}</span>
        )}
      </div>

      {wfType === 'wait' && (
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">{t('Attendre avant le bloc suivant', 'Wait before the next block')}</label>
          <div className="flex gap-2">
            <input
              type="number"
              min={1}
              value={Number(d.delay ?? 1)}
              onChange={(e) => onPatch({ delay: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
              className={`${cls} w-24`}
            />
            <select value={String(d.unit ?? 'hours')} onChange={(e) => onPatch({ unit: e.target.value })} className={`${cls} bg-white`}>
              <option value="minutes">{t('minutes', 'minutes')}</option>
              <option value="hours">{t('heures', 'hours')}</option>
              <option value="days">{t('jours', 'days')}</option>
            </select>
          </div>
          <p className="mt-1 text-[11px] text-ink-400">
            {t("Le délai est tenu à la minute près environ (le réveil des parcours se fait par balayage). Maximum 30 jours.", 'The delay is accurate to about a minute (parcours are woken by a sweep). Maximum 30 days.')}
          </p>
          <p className="mt-1 text-[11px] text-amber-700">
            {t("Après une attente, seul un envoi de TEMPLATE peut encore partir : la fenêtre de 24 h aura le plus souvent expiré. Un message rapide ou un formulaire placé après ne partira pas.", 'After a wait, only a TEMPLATE can still be sent: the 24h window will usually have expired. A quick message or a form placed after will not be sent.')}
          </p>
        </div>
      )}

      {wfType === 'rcs_message' && (
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">{t('Message RCS', 'RCS message')}</label>
          <textarea
            value={(d.text as string) ?? ''}
            onChange={(e) => onPatch({ text: e.target.value })}
            rows={4}
            maxLength={3072}
            placeholder={t('Votre message…', 'Your message…')}
            className={`${cls} bg-white`}
          />
          <p className="mt-1 text-[11px] text-ink-400">
            {t("Le RCS n'a pas de fenêtre de 24 h ni de template à faire approuver : le message part tel quel, sous votre agent de marque.", 'RCS has no 24h window and no template to get approved: the message goes out as written, under your brand agent.')}
          </p>
          <p className="mt-1 text-[11px] text-amber-700">
            {t("Ce bloc a deux sorties. Reliez « Non joignable en RCS » à un envoi de template WhatsApp pour rattraper les contacts que le RCS n'atteint pas : sans ce branchement, leur parcours s'arrête là.", 'This block has two outputs. Connect “Not reachable on RCS” to a WhatsApp template to catch contacts RCS cannot reach: without it, their journey stops there.')}
          </p>
        </div>
      )}

      {wfType === 'template' && (
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-600">{t('Template à envoyer', 'Template to send')}</label>
          <select value={(d.templateName as string) ?? ''} onChange={(e) => { const tpl = templates.find((x) => x.name === e.target.value); onPatch({ templateName: e.target.value, language: tpl?.language ?? 'fr', templateButtons: tpl?.buttons ?? [], templateCards: carouselOutputs(tpl) }); }} className={`${cls} bg-white`}>
            <option value="">{t('Choisir…', 'Choose…')}</option>
            {templates.map((tpl) => <option key={tpl.id || tpl.name} value={tpl.name}>{tpl.name}</option>)}
          </select>
          {Array.isArray(d.templateCards) && (d.templateCards as unknown[]).length > 0 ? (
            <p className="mt-1 text-[11px] text-ink-400">{t('Carousel : chaque réponse rapide de chaque carte devient une ', 'Carousel: each quick reply on each card becomes an ')}<b>{t('sortie', 'output')}</b>{t(' à relier (point à droite du bloc, « C1 » = carte 1). Les boutons lien ne se relient pas : ils ouvrent le navigateur et ne renvoient rien.', ' to connect (dot on the right of the block, “C1” = card 1). Link buttons cannot be connected: they open the browser and send nothing back.')}</p>
          ) : Array.isArray(d.templateButtons) && (d.templateButtons as unknown[]).length > 0 ? (
            <p className="mt-1 text-[11px] text-ink-400">{t('Chaque bouton de réponse rapide devient une ', 'Each quick-reply button becomes an ')}<b>{t('sortie', 'output')}</b>{t(' à relier (point à droite du bloc). Les boutons lien/formulaire ne se relient pas.', ' to connect (dot on the right of the block). Link/form buttons cannot be connected.')}</p>
          ) : null}
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
        <div className="space-y-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-600">{t('Formulaire (publié)', 'Form (published)')}</label>
            {/* La sélection pré-remplit le libellé du bouton avec le cta du formulaire (modifiable ensuite). */}
            <select value={(d.flowId as string) ?? ''} onChange={(e) => { const f = flows.find((x) => x.id === e.target.value); onPatch({ flowId: e.target.value, flowName: f?.name ?? '', cta: (f?.cta ?? '') || 'Envoyer' }); }} className={`${cls} bg-white`}>
              <option value="">{t('Choisir…', 'Choose…')}</option>
              {flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            {flows.length === 0 && <p className="mt-1 text-[11px] text-ink-400">{t('Aucun formulaire publié. Crée-en un dans Contenu > Formulaires.', 'No published form. Create one in Content > Forms.')}</p>}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-600">{t('Texte d’accroche', 'Message text')}</label>
            <textarea value={(d.body as string) ?? ''} onChange={(e) => onPatch({ body: e.target.value })} rows={2} className={cls} placeholder={t('Défaut : « Formulaire : <nom> »', 'Default: “Form: <name>”')} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-ink-600">{t('Libellé du bouton', 'Button label')}</label>
            <input value={(d.cta as string) ?? ''} maxLength={30} onChange={(e) => onPatch({ cta: e.target.value })} className={cls} placeholder={t('Envoyer', 'Send')} />
          </div>
        </div>
      )}
      {/* Blocs `tag` et `field` : LEGACY (hors palette depuis le bloc Action), mais rendus à vie pour les
          graphes déjà enregistrés. Ils réutilisent les sous-formulaires du bloc Action, sans quoi toute
          correction devrait être faite deux fois. */}
      {wfType === 'tag' && (
        <TagPicker
          label={t('Tag à ajouter', 'Tag to add')}
          value={(d.tag as string) ?? ''}
          tags={tags}
          onChange={(v) => onPatch({ tag: v })}
          onCommit={onCommitTag}
        />
      )}
      {wfType === 'field' && <FieldValueEditor d={d} fields={fields} onPatch={onPatch} avecValeur />}
      {wfType === 'action' && (() => {
        const kind = (d.actionKind as string) ?? 'add_tag';
        const isTag = kind === 'add_tag' || kind === 'remove_tag';
        return (
          <div className="space-y-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-600">{t('Action', 'Action')}</label>
              <select value={kind} onChange={(e) => onPatch({ actionKind: e.target.value })} className={`${cls} bg-white`}>
                <option value="add_tag">{t('Ajouter un tag', 'Add a tag')}</option>
                <option value="remove_tag">{t('Retirer un tag', 'Remove a tag')}</option>
                <option value="set_field">{t('Mettre à jour un champ', 'Update a field')}</option>
                <option value="clear_field">{t('Vider un champ', 'Clear a field')}</option>
              </select>
            </div>
            {isTag ? (
              <TagPicker
                label={kind === 'add_tag' ? t('Tag à ajouter', 'Tag to add') : t('Tag à retirer', 'Tag to remove')}
                value={(d.tag as string) ?? ''}
                tags={tags}
                onChange={(v) => onPatch({ tag: v })}
                {...(kind === 'add_tag' ? { onCommit: onCommitTag } : {})}
              />
            ) : (
              <FieldValueEditor d={d} fields={fields} onPatch={onPatch} avecValeur={kind === 'set_field'} />
            )}
          </div>
        );
      })()}
      {wfType === 'condition' && (
        <div className="space-y-2">
          <p className="text-[11px] leading-snug text-ink-400">{t('Le contact tire le fil « Si réunie » (vert) quand la condition est vraie, sinon « Sinon » (rouge). Relie chaque sortie à un bloc.', 'The contact follows “If met” (green) when the condition is true, otherwise “Otherwise” (red). Connect each output to a block.')}</p>
          <ConditionBuilder
            group={{ match: (d.match as 'all' | 'any') ?? 'all', clauses: Array.isArray(d.clauses) ? (d.clauses as ConditionGroup['clauses']) : [] }}
            onChange={(g) => onPatch({ match: g.match, clauses: g.clauses })}
            fields={fields}
            tags={tags.map((tg) => tg.tag)}
          />
        </div>
      )}
      {wfType === 'inbox' && (
        <p className="text-xs text-ink-500">{t("Quand le contact répond (quick-reply), la conversation remonte dans l'inbox pour un humain.", 'When the contact replies (quick-reply), the conversation moves to the inbox for a human.')}</p>
      )}
      {(wfType === 'mba_handoff' || wfType === 'mba_disable') && (
        <div className="rounded-lg border border-dashed border-ink-200 bg-ink-50 px-3 py-2 text-xs text-ink-500">
          <p className="font-medium text-ink-600">
            {wfType === 'mba_handoff'
              ? t("Passe la main à l'agent MBA de Meta.", "Hands the thread off to Meta's MBA agent.")
              : t('Désactive MBA sur ce fil.', 'Disables MBA on this thread.')}
          </p>
          <p className="mt-1">
            {t("Bloc préparé mais INERTE : il ne fait rien tant que MBA n'est pas actif sur votre numéro (accord Meta requis). Aucune configuration pour l'instant.", "Prepared but INERT: it does nothing until MBA is active on your number (Meta agreement required). No configuration for now.")}
          </p>
        </div>
      )}
    </div>
  );
}
