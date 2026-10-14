/**
 * Parcours pur de l'ouverture d'un scénario, commun au moteur et à la console.
 * Les deux appelants fournissent leur lecture d'un bloc configuré et des sorties de condition :
 * ces règles appartiennent au moteur et à l'éditeur, pas à ce parcours.
 */
export interface NoeudOuverture {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export interface GrapheOuverture<N extends NoeudOuverture> {
  nodes: N[];
  edges: { source: string; target: string; sourceHandle?: string | null }[];
}

export interface AnalyseOuverture<N extends NoeudOuverture> {
  /** Un message WhatsApp de session part-il avant un template ? */
  sessionOpen: boolean;
  /** Un RCS configuré peut ouvrir à froid, indépendamment de la fenêtre WhatsApp. */
  rcsOpen: boolean;
  /** Le template atteignable le plus proche de l'entrée (parcours en largeur). */
  firstTemplate: N | null;
  /** Plusieurs noms de template ouvrent des branches différentes. */
  ambiguousTemplate: boolean;
  /** Rien ne part au lancement si une attente précède l'ouverture. */
  waitBeforeTemplate: boolean;
  /** Un template atteint sans nom ne peut pas être envoyé. */
  unnamedOpeningTemplate: boolean;
  /** Cibles « Aller à » hors de ce graphe : leur ouverture ne peut pas être jugée ici. */
  sautsHorsScenario: string[];
}

export function cibleDuSaut(node: NoeudOuverture): string {
  return typeof node.data.cible === 'string' ? node.data.cible.trim() : '';
}

export function blocDuCode<N extends NoeudOuverture>(graph: GrapheOuverture<N>, code: string): N | null {
  return code === '' ? null : graph.nodes.find((n) => n.data.code === code) ?? null;
}

export function entreeDuGraphe<N extends NoeudOuverture>(graph: GrapheOuverture<N>): N | null {
  if (graph.nodes.length === 0) return null;
  const hasIncoming = new Set(graph.edges.map((e) => e.target));
  for (const node of graph.nodes) {
    if (node.type !== 'aller_a') continue;
    const vise = blocDuCode(graph, cibleDuSaut(node));
    if (vise) hasIncoming.add(vise.id);
  }
  return graph.nodes.find((n) => !hasIncoming.has(n.id)) ?? graph.nodes[0] ?? null;
}

/** Explore tous les chemins avant le premier envoi ; un bloc terminal arrête sa branche. */
export function scannerOuverture<N extends NoeudOuverture>(
  graph: GrapheOuverture<N>,
  regles: {
    depuis?: string;
    envoieSession(node: N): boolean;
    sortiesDeCondition(node: N): readonly string[];
    sortieSinon: string;
  },
): AnalyseOuverture<N> {
  const out: AnalyseOuverture<N> = {
    sessionOpen: false, rcsOpen: false, firstTemplate: null, ambiguousTemplate: false,
    waitBeforeTemplate: false, unnamedOpeningTemplate: false, sautsHorsScenario: [],
  };
  const entree = regles.depuis ?? entreeDuGraphe(graph)?.id;
  if (!entree) return out;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const queue: string[] = [entree];
  const noms = new Set<string>();
  const cible = (id: string, handle?: string): string | null =>
    graph.edges.find((e) => e.source === id && (handle === undefined || e.sourceHandle === handle))?.target ?? null;

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (node.type === 'inbox' || node.type === 'vers_mba') continue;
    if (node.type === 'template') {
      const nom = String(node.data.templateName ?? '').trim();
      if (nom !== '') noms.add(nom);
      else out.unnamedOpeningTemplate = true;
      if (!out.firstTemplate) out.firstTemplate = node;
      out.ambiguousTemplate = noms.size > 1;
      continue;
    }
    if (node.type === 'flow' || node.type === 'quick_message') {
      if (regles.envoieSession(node)) out.sessionOpen = true;
      continue;
    }
    if (node.type === 'question' || node.type === 'agent') {
      if (regles.envoieSession(node)) { out.sessionOpen = true; continue; }
      const suite = cible(id);
      if (suite) queue.push(suite);
      continue;
    }
    if (node.type === 'rcs_message') {
      if (String(node.data.text ?? '').trim() !== '' && !out.waitBeforeTemplate) out.rcsOpen = true;
      for (const handle of ['sent', 'unreachable']) {
        const suite = cible(id, handle);
        if (suite) queue.push(suite);
      }
      continue;
    }
    if (node.type === 'wait') out.waitBeforeTemplate = true;
    if (node.type === 'condition') {
      for (const handle of regles.sortiesDeCondition(node)) {
        const suite = cible(id, handle) ?? (handle === regles.sortieSinon ? cible(id) : null);
        if (suite) queue.push(suite);
      }
      continue;
    }
    if (node.type === 'aller_a') {
      const code = cibleDuSaut(node);
      const ici = blocDuCode(graph, code);
      if (ici) queue.push(ici.id);
      else out.sautsHorsScenario.push(code);
      continue;
    }
    const suite = cible(id);
    if (suite) queue.push(suite);
  }
  return out;
}
