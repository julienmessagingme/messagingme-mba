/**
 * Éligibilité d'un scénario à une CAMPAGNE broadcast. Module PUR : aucune IO, aucune dépendance
 * React/navigateur (types structuraux locaux, comme `node-search.ts`) -> testable depuis la suite racine
 * (tests/web-campaign-eligibility.test.ts). Importer `./api` ici tirerait `session.ts` (et `window`) dans la
 * compilation racine : à ne pas faire.
 *
 * Une campagne part sur une audience FROIDE : hors fenêtre de service 24 h, seul un TEMPLATE peut ouvrir
 * (Meta 131047). En revanche un tag, une action ou une condition avant ce template n'envoient rien : ils ne
 * rendent donc pas le scénario inéligible. On juge sur ce qui OUVRE réellement, pas sur le type du 1er bloc.
 *
 * Ce helper filtre le sélecteur de scénarios côté campagne pour ne proposer QUE ce qui partira réellement, et
 * désigne le template à paramétrer. Il ne remplace PAS la garde serveur (`POST /campaigns` refuse en 400) :
 * c'est de la prévention d'UI, la garde serveur reste le contrôle.
 *
 * ⚠️ Cette règle est le MIROIR de `scanOpening` (`src/workflow/engine.ts`) : les deux builds ne partagent
 * aucun module. `tests/web-campaign-eligibility.test.ts` compare les deux implémentations sur les mêmes
 * graphes et casse dès qu'elles divergent.
 */

/** Forme minimale d'un bloc, structurelle : `WorkflowNode` de `./api` la satisfait sans import. */
export interface GraphNodeLike {
  id: string;
  type: string;
  data: Record<string, unknown>;
}
/** Forme minimale d'un graphe (`WorkflowGraph` de `./api` la satisfait). `sourceHandle` compte : une condition
 *  a deux sorties nommées 'true'/'false' et les deux peuvent ouvrir le scénario. */
export interface GraphLike {
  nodes: GraphNodeLike[];
  edges: { source: string; target: string; id?: string; sourceHandle?: string | null }[];
}

/** Bloc d'entrée d'un graphe = un bloc SANS arête entrante (défaut : le 1er bloc). null si le graphe est vide.
 *  Miroir de `entryNode` côté serveur (src/workflow/engine.ts). */
export function entryNodeOf(graph: GraphLike): GraphNodeLike | null {
  if (graph.nodes.length === 0) return null;
  const hasIncoming = new Set(graph.edges.map((e) => e.target));
  return graph.nodes.find((n) => !hasIncoming.has(n.id)) ?? graph.nodes[0] ?? null;
}

const cible = (g: GraphLike, id: string): string | null => g.edges.find((e) => e.source === id)?.target ?? null;
const cibleParSortie = (g: GraphLike, id: string, handle: string): string | null =>
  g.edges.find((e) => e.source === id && e.sourceHandle === handle)?.target ?? null;

/** Un bloc « message rapide » / « formulaire » est-il CONFIGURÉ (donc réellement envoyé) ? Miroir de `actionOf`. */
function envoieVraiment(node: GraphNodeLike): boolean {
  if (node.type === 'flow') return String(node.data.flowId ?? '').trim() !== '';
  if (node.type === 'quick_message') {
    const body = String(node.data.body ?? '').trim();
    const reps = Array.isArray(node.data.quickReplies) ? node.data.quickReplies : [];
    return body !== '' && reps.some((q) => String(q ?? '').trim() !== '');
  }
  return false;
}

export interface OpeningScan {
  /** Un message de SESSION part-il avant tout template ? */
  sessionOpen: boolean;
  /** Le 1er template atteignable (parcours en largeur depuis l'entrée). */
  firstTemplate: GraphNodeLike | null;
  /** Plusieurs templates DIFFÉRENTS peuvent ouvrir -> aucune ouverture unique à paramétrer. */
  ambiguousTemplate: boolean;
  /** Une ATTENTE est traversée avant le 1er template : rien ne partirait au lancement. */
  waitBeforeTemplate: boolean;
  /** Un template d'ouverture atteint n'a PAS de nom : sur cette branche, rien ne partirait. */
  unnamedOpeningTemplate: boolean;
}

/** Miroir exact de `scanOpening` côté serveur. Parcours en LARGEUR : « le premier template » doit être le plus
 *  proche de l'entrée, pas le premier inséré dans le tableau de blocs. */
export function scanOpening(graph: GraphLike): OpeningScan {
  const out: OpeningScan = { sessionOpen: false, firstTemplate: null, ambiguousTemplate: false, waitBeforeTemplate: false, unnamedOpeningTemplate: false };
  const entry = entryNodeOf(graph);
  if (!entry) return out;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const queue: string[] = [entry.id];
  const noms = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (node.type === 'inbox') continue;
    if (node.type === 'template') {
      const nom = String(node.data.templateName ?? '').trim();
      if (nom !== '') noms.add(nom);
      else out.unnamedOpeningTemplate = true;
      if (!out.firstTemplate) out.firstTemplate = node;
      out.ambiguousTemplate = noms.size > 1;
      continue;
    }
    if (node.type === 'flow' || node.type === 'quick_message') {
      if (envoieVraiment(node)) out.sessionOpen = true;
      continue;
    }
    if (node.type === 'wait') out.waitBeforeTemplate = true;
    if (node.type === 'condition') {
      const t = cibleParSortie(graph, id, 'true');
      const f = cibleParSortie(graph, id, 'false') ?? cible(graph, id);
      if (t) queue.push(t);
      if (f) queue.push(f);
      continue;
    }
    const nx = cible(graph, id);
    if (nx) queue.push(nx);
  }
  return out;
}

/** Le template que la campagne enverra en ouverture, donc celui dont on mappe les variables. null si le
 *  scénario n'ouvre pas par un template, ou si plusieurs templates différents peuvent ouvrir. */
export function firstTemplateOf(graph: GraphLike): GraphNodeLike | null {
  const scan = scanOpening(graph);
  if (scan.ambiguousTemplate) return null;
  return scan.firstTemplate;
}

/**
 * Le scénario peut-il être lancé en campagne broadcast ? Exige une ouverture par template CONFIGURÉ, sans
 * message de session ni attente avant lui. Volontairement plus strict que la garde serveur sur un point : un
 * bloc template sans `templateName` n'a rien à envoyer, mieux vaut ne pas le proposer que le laisser échouer
 * après le clic.
 */
export function isCampaignEligible(graph: GraphLike): boolean {
  const scan = scanOpening(graph);
  if (scan.sessionOpen || scan.waitBeforeTemplate || scan.ambiguousTemplate || scan.unnamedOpeningTemplate) return false;
  if (!scan.firstTemplate) return false;
  return String(scan.firstTemplate.data.templateName ?? '').trim() !== '';
}

/** Un montage impossible : attente qui ferme forcément la fenêtre, puis message de session. */
export interface WaitThenSession {
  /** Le dernier bloc Attente TRAVERSÉ sur ce chemin. */
  waitNodeId: string;
  messageNodeId: string;
}

/**
 * Miroir de `waitBeforeSessionMessage` (`src/workflow/engine.ts`). Cherche « attente cumulée >= 24 h PUIS
 * message rapide ou formulaire » : ce montage ne peut jamais partir (la fenêtre de service court depuis le
 * dernier message du contact, Meta refuse tout message de session hors fenêtre). Sert à le DIRE dans le
 * builder ; le blocage réel est au runtime.
 *
 * Cumul PLAFONNÉ à 24 h : au-delà la réponse ne change plus, et c'est ce qui fait terminer la recherche sur un
 * graphe cyclique (sans ce plafond, un cycle d'attentes ferait croître le cumul sans fin).
 */
export function waitBeforeSessionMessage(graph: GraphLike): WaitThenSession | null {
  const FENETRE_MS = 24 * 3_600_000;
  // Chaque attente compte pour au MOINS un pas de balayage (60 s), la granularité réelle d'un réveil. Sans ce
  // plancher, un délai fractionnaire enregistré par l'API (`{delay: 0.001}`, 60 ms) dans un cycle demanderait
  // ~1,4 million d'itérations par bloc et figerait l'onglet.
  const PAS_MIN_MS = 60_000;
  const UNITES: Record<string, number> = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 };
  const dureeMs = (node: GraphNodeLike): number => {
    const brut = Number(node.data.delay ?? 0);
    if (!Number.isFinite(brut) || brut <= 0) return 0;
    return (UNITES[String(node.data.unit ?? 'hours')] ?? 0) * brut;
  };
  const entry = entryNodeOf(graph);
  if (!entry) return null;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const meilleur = new Map<string, number>();
  const pile: Array<{ id: string; cumul: number; dernierWait: string | null }> = [{ id: entry.id, cumul: 0, dernierWait: null }];
  while (pile.length > 0) {
    const { id, cumul, dernierWait } = pile.pop()!;
    const vu = meilleur.get(id);
    if (vu !== undefined && vu >= cumul) continue;
    meilleur.set(id, cumul);
    const node = byId.get(id);
    if (!node) continue;
    if (node.type === 'inbox') continue;
    if (node.type === 'flow' || node.type === 'quick_message') {
      if (envoieVraiment(node) && cumul >= FENETRE_MS && dernierWait) return { waitNodeId: dernierWait, messageNodeId: id };
      continue;
    }
    const suivant = node.type === 'template'
      ? { cumul: 0, dernierWait: null }
      : node.type === 'wait'
        ? { cumul: Math.min(cumul + Math.max(PAS_MIN_MS, dureeMs(node)), FENETRE_MS), dernierWait: dureeMs(node) > 0 ? id : dernierWait }
        : { cumul, dernierWait };
    if (node.type === 'condition') {
      for (const h of ['true', 'false'] as const) {
        const c = cibleParSortie(graph, id, h);
        if (c) pile.push({ id: c, ...suivant });
      }
      if (!graph.edges.some((e) => e.source === id && (e.sourceHandle === 'true' || e.sourceHandle === 'false'))) {
        const repli = cible(graph, id);
        if (repli) pile.push({ id: repli, ...suivant });
      }
      continue;
    }
    const nx = cible(graph, id);
    if (nx) pile.push({ id: nx, ...suivant });
  }
  return null;
}
