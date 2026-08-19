'use client';

import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';
import { ReactFlow, Background, Controls, Handle, Position, MarkerType, type Node, type Edge, type NodeProps, type NodeTypes } from '@xyflow/react';
import { useT } from '@/lib/i18n';
import { nodeMetaOf } from '@/lib/nodeMeta';
import type { WorkflowNodeType } from '@/lib/api';
import type { BlocMesurable } from '@/lib/mesures-scenario';

/**
 * Le scénario tel qu'il est DESSINÉ dans l'onglet Scénario, en lecture seule.
 *
 * Mêmes positions, mêmes flèches, mêmes libellés que l'éditeur : on retrouve son scénario au lieu d'en lire
 * une transcription. Ce qui n'est PAS repris est délibéré : la palette, le déplacement, la suppression et les
 * poignées de liaison n'ont rien à faire dans un écran de mesure, et les afficher inviterait à modifier un
 * scénario depuis Analytics.
 *
 * ⚠️ Composant SÉPARÉ de `WorkflowBuilder`, et pas un mode « lecture seule » de celui-ci. Le builder porte
 * l'auto-save : lui ajouter un mode où il ne doit surtout pas écrire aurait mis un enregistrement automatique
 * à un clic d'un écran de consultation. Le risque est asymétrique, la duplication ici se limite à une carte.
 */
export interface ScenarioCanvasProps {
  /** Positions et arêtes, telles que l'éditeur les a enregistrées. */
  graph: { nodes: Array<{ id: string; type?: string; position?: { x: number; y: number }; data?: Record<string, unknown> }>; edges: Array<{ id?: string; source: string; target: string; sourceHandle?: string }> };
  /** Les blocs déjà analysés : titre, et surtout s'ils sont mesurables. */
  blocs: BlocMesurable[];
  selectionne: string | null;
  onSelect: (nodeId: string) => void;
  /** Nombre de mesures retenues par bloc, pour montrer d'un coup d'œil ce qui compose le tableau. */
  retenuesParBloc?: Record<string, number>;
}

interface DonneesCarte extends Record<string, unknown> {
  titre: string;
  wfType: string;
  mesurable: boolean;
  actif: boolean;
  retenues: number;
}

/**
 * Carte d'un bloc. Volontairement plus sobre que celle de l'éditeur : pas d'aperçu de carousel ni de sortie
 * par bouton. Ici on choisit un bloc, on ne le configure pas, et un aperçu riche ferait du bruit.
 */
function CarteBloc({ data }: NodeProps) {
  const t = useT();
  const d = data as DonneesCarte;
  const meta = nodeMetaOf(d.wfType as WorkflowNodeType);

  // Grisé PROPREMENT : bordure et fond éteints, texte affaibli, curseur qui dit que rien ne se passera. Un
  // simple `opacity` aurait aussi délavé la sélection des blocs voisins et rendu le tout terne.
  const styleBloc = d.mesurable
    ? d.actif
      ? 'border-brand-500 bg-white ring-2 ring-brand-200 shadow-md'
      : 'border-ink-300 bg-white shadow-sm hover:border-brand-300'
    : 'border-dashed border-ink-200 bg-ink-50 shadow-none';

  return (
    <div
      data-testid={d.mesurable ? 'bloc-mesurable' : 'bloc-grise'}
      className={`w-44 rounded-xl border transition ${styleBloc} ${d.mesurable ? 'cursor-pointer' : 'cursor-not-allowed'}`}
      title={d.mesurable ? undefined : t('Ce bloc n’envoie pas de message : il n’y a rien à y mesurer.', 'This block sends no message: there is nothing to measure.')}
    >
      {/* Poignées présentes mais INERTES : sans elles React Flow ne saurait pas où accrocher les flèches, et
          le dessin perdrait la forme qu'il a dans l'éditeur. */}
      <Handle type="target" position={Position.Top} isConnectable={false} className="!h-2 !w-2 !border-0 !bg-ink-300" />
      <div className={`flex items-center gap-1.5 rounded-t-xl border-b px-2 py-1 ${d.mesurable ? 'border-ink-200 bg-white' : 'border-ink-100 bg-ink-50'}`}>
        <span className="text-xs">{meta.emoji}</span>
        <span className={`truncate text-[11px] font-semibold ${d.mesurable ? 'text-ink-800' : 'text-ink-400'}`}>{t(...meta.label)}</span>
        {d.retenues > 0 && (
          <span className="ml-auto shrink-0 rounded-full bg-brand-500 px-1.5 text-[10px] font-semibold text-white">{d.retenues}</span>
        )}
      </div>
      {/* Le resume n'est affiche que s'il APPORTE quelque chose : sur un bloc grise, `titre` vaut souvent le
          nom du type, deja lu juste au-dessus, et le repeter alourdit la carte pour rien. */}
      {d.titre !== t(...meta.label) && (
        <div className={`truncate px-2 py-1.5 text-[11px] ${d.mesurable ? 'text-ink-600' : 'text-ink-400'}`}>{d.titre}</div>
      )}
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="!h-2 !w-2 !border-0 !bg-ink-300" />
    </div>
  );
}

const nodeTypes: NodeTypes = { lecture: CarteBloc };

export function ScenarioCanvas({ graph, blocs, selectionne, onSelect, retenuesParBloc = {} }: ScenarioCanvasProps) {
  const t = useT();
  const parId = useMemo(() => new Map(blocs.map((b) => [b.id, b])), [blocs]);

  const nodes = useMemo<Node[]>(
    () => graph.nodes.map((n) => {
      const b = parId.get(n.id);
      return {
        id: n.id,
        type: 'lecture',
        position: n.position ?? { x: 0, y: 0 },
        // Le déplacement et la sélection native sont coupés : c'est notre clic qui pilote, et un bloc
        // deplaçable donnerait l'illusion qu'on modifie le scénario depuis Analytics.
        draggable: false,
        selectable: false,
        connectable: false,
        data: {
          titre: b?.titre ?? n.type ?? '',
          wfType: n.type ?? 'template',
          mesurable: b?.mesurable ?? false,
          actif: selectionne === n.id,
          retenues: retenuesParBloc[n.id] ?? 0,
        } satisfies DonneesCarte,
      };
    }),
    [graph.nodes, parId, selectionne, retenuesParBloc],
  );

  /**
   * Libellé d'une flèche. Les handles bruts (`btn:1`, `true`) sont de la plomberie : les afficher tels quels
   * oblige l'opérateur à traduire mentalement ce que le scénario dit déjà en clair.
   */
  const libelleArete = (source: string, handle: string): string => {
    const typees: Record<string, string> = {
      true: t('si réunie', 'if met'), false: t('sinon', 'otherwise'),
      sent: t('envoyé', 'sent'), unreachable: t('non joignable', 'unreachable'),
    };
    if (typees[handle]) return typees[handle];
    return parId.get(source)?.choix.find((c) => c.handle === handle)?.label ?? handle;
  };

  const edges = useMemo<Edge[]>(
    () => graph.edges.map((e, i) => ({
      id: e.id ?? `e${i}`,
      source: e.source,
      target: e.target,
      ...(e.sourceHandle ? { label: libelleArete(e.source, e.sourceHandle) } : {}),
      style: { stroke: '#c7ccd6' },
      labelStyle: { fill: '#8a93a5', fontSize: 10 },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#c7ccd6' },
    })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `libelleArete` ne depend que de `parId` et `t`
    [graph.edges, parId, t],
  );

  if (graph.nodes.length === 0) {
    return <p className="text-sm text-ink-500">{t('Ce scénario ne contient aucun bloc.', 'This scenario has no block.')}</p>;
  }

  return (
    <div className="h-[30rem] w-full overflow-hidden rounded-xl border border-ink-200 bg-ink-50/40" data-testid="scenario-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_e, node) => { if ((node.data as DonneesCarte).mesurable) onSelect(node.id); }}
        fitView
        // Tout ce qui MODIFIE est coupé. On garde le zoom et le déplacement du canevas : un grand scénario
        // doit rester explorable, sinon on ne voit que son coin supérieur gauche.
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} color="#e6e9ef" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
