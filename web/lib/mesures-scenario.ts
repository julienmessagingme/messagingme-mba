/**
 * Lecture d'un scénario pour en construire un TABLEAU DE MESURES (Analytics > Mes tableaux).
 *
 * Tout est PUR ici : ordonner les blocs, dire lesquels sont mesurables, nommer les choix, agréger les
 * compteurs. Aucun appel réseau, donc testable sans navigateur — et c'est là que vivent les règles qui
 * décident ce que l'écran a le droit d'afficher.
 */

export interface GraphNode {
  id: string;
  type: string;
  data?: Record<string, unknown>;
}
export interface GraphEdge {
  source: string;
  target: string;
  sourceHandle?: string;
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Une mesure brute telle que la route la rend. */
export interface CompteurBrut {
  nodeId: string;
  kind: string;
  handle: string | null;
  count: number;
  contacts: number;
}

/**
 * Un bloc qui ENVOIE un message, donc qui peut être mesuré.
 *
 * Les autres blocs (tag, champ, condition, attente, assignation, mail) ne produisent rien qu'un contact
 * reçoive : les proposer à la mesure ferait miroiter des compteurs qui resteraient à zéro pour toujours.
 */
const BLOCS_MESSAGE = new Set(['template', 'quick_message', 'flow', 'rcs_message']);

export const estMesurable = (type: string): boolean => BLOCS_MESSAGE.has(type);

export interface Choix {
  /** Le handle tel qu'il arrive dans les mesures (`btn:0`, `card:1:btn:0`). */
  handle: string;
  label: string;
}

export interface BlocMesurable {
  id: string;
  type: string;
  /** Ce que le bloc fait, en une ligne, pour le reconnaître dans la liste. */
  titre: string;
  mesurable: boolean;
  choix: Choix[];
}

/** Titre lisible d'un bloc. Volontairement court : la liste doit se parcourir des yeux. */
function titreDe(n: GraphNode): string {
  const d = n.data ?? {};
  const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  if (n.type === 'template') return s(d.templateName) || 'Template (non choisi)';
  if (n.type === 'quick_message') return s(d.body).slice(0, 60) || 'Message rapide (vide)';
  if (n.type === 'flow') return s(d.flowName) || 'Formulaire';
  if (n.type === 'rcs_message') return 'Message RCS';
  if (n.type === 'condition') return 'Condition';
  if (n.type === 'wait') return 'Attente';
  if (n.type === 'inbox') return 'Assigner à un agent';
  if (n.type === 'email') return 'Envoi de mail';
  if (n.type === 'action') return 'Action';
  return n.type;
}

/** Libellé d'un handle de choix, pour ne pas afficher `card:1:btn:0` à un opérateur. */
export function libelleHandle(handle: string, boutons: string[]): string {
  const carousel = /^card:(\d+):btn:(\d+)$/.exec(handle);
  if (carousel) return `Carte ${Number(carousel[1]) + 1}, bouton ${Number(carousel[2]) + 1}`;
  const simple = /^btn:(\d+)$/.exec(handle);
  if (simple) {
    const i = Number(simple[1]);
    const texte = boutons[i]?.trim();
    return texte ? `« ${texte} »` : `Bouton ${i + 1}`;
  }
  return handle;
}

/** Textes des boutons déclarés sur un bloc (message rapide ou template). */
function boutonsDe(n: GraphNode): string[] {
  const d = n.data ?? {};
  const brut = Array.isArray(d.quickReplies) ? d.quickReplies : Array.isArray(d.templateButtons) ? d.templateButtons : [];
  return brut.map((b) => (typeof b === 'object' && b !== null && 'text' in b ? String((b as { text: unknown }).text ?? '') : ''));
}

/**
 * Les blocs d'un scénario, DANS L'ORDRE DU PARCOURS.
 *
 * L'ordre est celui d'un tableau qui se lit en entonnoir : le bloc d'entrée d'abord, puis ce qu'il atteint.
 * Un bloc inatteignable (branche orpheline en cours de construction) n'est pas ignoré pour autant, il est
 * ajouté à la fin : le masquer donnerait l'impression qu'il n'existe pas, alors qu'il peut très bien avoir
 * déjà tourné avant qu'on débranche son arête.
 *
 * `handlesMesures` = les handles réellement vus dans les données. Ils complètent les boutons déclarés : un
 * carousel ne déclare pas ses cartes dans le graphe, donc ses choix n'apparaissent qu'une fois cliqués.
 */
export function blocsDuScenario(graph: Graph, handlesMesures: Record<string, string[]> = {}): BlocMesurable[] {
  const parId = new Map(graph.nodes.map((n) => [n.id, n]));
  const cibles = new Set(graph.edges.map((e) => e.target));
  const entree = graph.nodes.find((n) => !cibles.has(n.id)) ?? graph.nodes[0];

  const ordre: string[] = [];
  const vus = new Set<string>();
  const file: string[] = entree ? [entree.id] : [];
  while (file.length > 0) {
    const id = file.shift()!;
    if (vus.has(id) || !parId.has(id)) continue;
    vus.add(id);
    ordre.push(id);
    for (const e of graph.edges) if (e.source === id) file.push(e.target);
  }
  for (const n of graph.nodes) if (!vus.has(n.id)) ordre.push(n.id);

  return ordre.map((id) => {
    const n = parId.get(id)!;
    const boutons = boutonsDe(n);
    // Handles connus : ceux des boutons déclarés, ceux des arêtes du graphe, et ceux effectivement mesurés.
    const desBoutons = boutons.map((_, i) => `btn:${i}`);
    const desAretes = graph.edges.filter((e) => e.source === id && e.sourceHandle).map((e) => e.sourceHandle!);
    const tous = [...new Set([...desBoutons, ...desAretes, ...(handlesMesures[id] ?? [])])]
      // Les sorties TYPÉES d'un bloc ne sont pas des choix du contact : elles décrivent une issue technique.
      .filter((h) => !['true', 'false', 'sent', 'unreachable'].includes(h));
    return {
      id,
      type: n.type,
      titre: titreDe(n),
      mesurable: estMesurable(n.type),
      choix: tous.map((h) => ({ handle: h, label: libelleHandle(h, boutons) })),
    };
  });
}

/** Une mesure sélectionnable sur un bloc. `handle` non nul = un choix précis. */
export interface MesureDispo {
  cle: string;
  label: string;
  kind: string;
  handle: string | null;
}

/**
 * Ce qu'on peut compter sur un bloc de message. L'ordre suit la lecture naturelle d'un entonnoir.
 *
 * `estPremier` = ce bloc est-il le PREMIER message du scénario ? Lui seul propose « Échecs » et « Délivrés ».
 * Après lui, le message part à quelqu'un qui vient de répondre : l'envoi aboutit et arrive quasiment toujours.
 * Ces deux mesures y afficheraient des barres plates, l'une à zéro et l'autre collée aux « Envoyés », et
 * noieraient le signal qu'on est venu chercher. Demandé par Julien le 2026-08-19.
 */
export function mesuresDisponibles(bloc: BlocMesurable, estPremier = true): MesureDispo[] {
  if (!bloc.mesurable) return [];
  const base: MesureDispo[] = [
    { cle: `${bloc.id}|sent`, label: 'Envoyés', kind: 'sent', handle: null },
    ...(estPremier
      ? [
        { cle: `${bloc.id}|failed`, label: 'Échecs', kind: 'failed', handle: null },
        { cle: `${bloc.id}|delivered`, label: 'Délivrés', kind: 'delivered', handle: null },
      ]
      : []),
    { cle: `${bloc.id}|read`, label: 'Lus', kind: 'read', handle: null },
  ];
  const choix: MesureDispo[] = bloc.choix.map((c) => ({
    cle: `${bloc.id}|reply_button|${c.handle}`,
    label: `A cliqué ${c.label}`,
    kind: 'reply_button',
    handle: c.handle,
  }));
  // « A répondu sans cliquer » est proposé partout, et pas seulement sur les blocs à boutons : sur un bloc qui
  // n'offre aucun choix, c'est LA mesure de l'engagement.
  return [...base, ...choix, { cle: `${bloc.id}|reply_text`, label: 'A répondu (sans cliquer)', kind: 'reply_text', handle: null }];
}

/** Une barre du graphe final. */
export interface Barre {
  nodeId: string;
  label: string;
  count: number;
  contacts: number;
}

/**
 * Valeur d'une mesure depuis les compteurs bruts. Absente des données = 0, et non « pas de barre » : une
 * mesure choisie qui vaut zéro est une information, la masquer laisserait croire à un oubli.
 */
export function valeurDe(counts: CompteurBrut[], nodeId: string, kind: string, handle: string | null): { count: number; contacts: number } {
  const l = counts.find((c) => c.nodeId === nodeId && c.kind === kind && (c.handle ?? null) === handle);
  return { count: l?.count ?? 0, contacts: l?.contacts ?? 0 };
}

/** Les handles réellement mesurés, par bloc : sert à révéler les choix qu'un carousel ne déclare pas. */
export function handlesMesuresParBloc(counts: CompteurBrut[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of counts) {
    if (c.kind !== 'reply_button' || !c.handle) continue;
    (out[c.nodeId] ??= []).push(c.handle);
  }
  for (const k of Object.keys(out)) out[k] = [...new Set(out[k]!)];
  return out;
}

/**
 * Couleur d'une mesure. UNE couleur par NATURE : toutes les barres « Envoyés » d'un tableau ont la même, tous
 * les « Lus » la même, etc. C'est ce qui rend un histogramme à plusieurs blocs lisible d'un coup d'œil — on
 * compare une nature d'un bloc à l'autre sans relire la légende.
 *
 * Les CLICS font exception, et c'est nécessaire : un bloc peut en porter plusieurs, et les peindre à
 * l'identique rendrait deux barres voisines indiscernables. Ils prennent donc des nuances d'une même teinte,
 * assignées par la POSITION du choix dans le bloc : « premier choix » garde la même nuance d'un bloc à l'autre.
 */
const COULEUR_PAR_NATURE: Record<string, string> = {
  sent: '#0080D6',
  failed: '#E5484D',
  delivered: '#8B5CF6',
  read: '#17C74E',
  reply_text: '#F59E0B',
};
const NUANCES_CLIC = ['#0E7490', '#14B8A6', '#5EEAD4', '#A5F3FC'];

export function couleurDe(kind: string, indexChoix = 0): string {
  if (kind === 'reply_button') return NUANCES_CLIC[indexChoix % NUANCES_CLIC.length]!;
  return COULEUR_PAR_NATURE[kind] ?? '#94A3B8';
}

export interface BarreTableau {
  cle: string;
  label: string;
  count: number;
  contacts: number;
  couleur: string;
}

export interface GroupeTableau {
  nodeId: string;
  titre: string;
  barres: BarreTableau[];
}

/**
 * Les groupes de barres d'un tableau, DANS L'ORDRE DU PARCOURS.
 *
 * L'ordre vient des blocs et non de l'ordre où l'opérateur a cliqué : un histogramme d'entonnoir se lit de
 * gauche à droite dans le sens du scénario, et suivre l'ordre des clics donnerait un dessin différent à chaque
 * fois qu'on recompose la même sélection.
 *
 * Un bloc sans mesure retenue n'apparaît pas : réserver une place vide à chaque bloc du scénario écraserait
 * les groupes réellement mesurés.
 */
export function groupesDuTableau(
  retenues: MesureDispo[],
  counts: CompteurBrut[],
  blocs: BlocMesurable[],
): GroupeTableau[] {
  const parBloc = new Map<string, MesureDispo[]>();
  for (const m of retenues) {
    const id = m.cle.split('|')[0]!;
    parBloc.set(id, [...(parBloc.get(id) ?? []), m]);
  }
  return blocs
    .filter((b) => (parBloc.get(b.id) ?? []).length > 0)
    .map((b) => ({
      nodeId: b.id,
      titre: b.titre,
      barres: (parBloc.get(b.id) ?? []).map((m) => {
        const iChoix = m.handle ? Math.max(0, b.choix.findIndex((c) => c.handle === m.handle)) : 0;
        return { cle: m.cle, label: m.label, ...valeurDe(counts, b.id, m.kind, m.handle), couleur: couleurDe(m.kind, iChoix) };
      }),
    }));
}
