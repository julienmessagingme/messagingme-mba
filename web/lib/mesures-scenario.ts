/**
 * Lecture d'un scénario pour en construire un TABLEAU DE MESURES (Analytics > Mes tableaux).
 *
 * Tout est PUR ici : ordonner les blocs, dire lesquels sont mesurables, nommer les choix, agréger les
 * compteurs. Aucun appel réseau, donc testable sans navigateur — et c'est là que vivent les règles qui
 * décident ce que l'écran a le droit d'afficher.
 *
 * ⚠️ Module `.ts` PUR : `useT()` est un hook, il est inappelable ici. La langue arrive donc en paramètre
 * `locale` REQUIS (convention du dépôt, cf. `format.ts`) : sans défaut, tsc liste tous les appelants le jour
 * où on en ajoute un. C'est ce qui manquait, et tout cet écran s'affichait en français en mode anglais.
 */
import type { Locale } from './locale';
import { NODE_META } from './nodeMeta';
import type { WorkflowNodeType } from './api';

/** Libellé du TYPE de bloc, dans la langue voulue. Une seule source : `NODE_META`, déjà en paires [fr, en]. */
function libelleType(type: string, locale: Locale): string {
  const meta = NODE_META[type as WorkflowNodeType];
  if (!meta) return type;
  return locale === 'en' ? meta.label[1] : meta.label[0];
}

/** Guillemets de la langue. Même règle que `format.ts`, pour ne pas écrire « … » dans une phrase anglaise. */
function guillemets(s: string, locale: Locale): string {
  return locale === 'en' ? `“${s}”` : `« ${s} »`;
}

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
  /**
   * Nombre de PERSONNES distinctes. `null` quand la mesure ne sait pas les distinguer : un clic sur un lien
   * de template arrive sans identité (le lien est le même pour tous les destinataires). Mettre 0 aurait dit
   * « personne », et mettre `count` aurait dit « une personne par clic » : deux mensonges pour éviter un vide.
   */
  contacts: number | null;
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
  /** `false` = `titre` n'est que le nom du type. La carte du scénario s'en sert pour ne pas le répéter. */
  titrePropre: boolean;
  mesurable: boolean;
  choix: Choix[];
  /**
   * Boutons URL dont le lien est TRACÉ, donc mesurables. La liste vient des compteurs, pas du graphe : le
   * graphe sait qu'un bouton est de type URL, mais pas si son lien passe par notre redirection. Un template
   * approuvé avant la mise en service porte l'adresse du client en dur, et rien ne le mesurera jamais.
   */
  liens: Choix[];
}

/**
 * Titre lisible d'un bloc, et s'il lui est PROPRE.
 *
 * `propre = false` veut dire « je n'ai que le nom du type » : la carte du scénario s'en sert pour ne pas
 * réafficher sous l'en-tête ce qui y est déjà écrit. Elle comparait auparavant deux chaînes, dont une
 * traduite et l'autre non : en anglais l'égalité n'arrivait jamais et le doublon revenait sur chaque bloc.
 */
function titreDe(n: GraphNode, locale: Locale): { titre: string; propre: boolean } {
  const d = n.data ?? {};
  const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const saisi = n.type === 'template' ? s(d.templateName)
    : n.type === 'quick_message' ? s(d.body).slice(0, 60)
    : n.type === 'flow' ? s(d.flowName)
    : '';
  if (saisi !== '') return { titre: saisi, propre: true };
  // Repli : le nom du TYPE. `template` et `quick_message` précisent en plus qu'ils sont vides, sinon on ne
  // distinguerait pas un bloc à configurer d'un bloc prêt.
  if (n.type === 'template') return { titre: locale === 'en' ? 'Template (not chosen)' : 'Template (non choisi)', propre: false };
  if (n.type === 'quick_message') return { titre: locale === 'en' ? 'Quick message (empty)' : 'Message rapide (vide)', propre: false };
  return { titre: libelleType(n.type, locale), propre: false };
}

/** Libellé d'un handle de choix, pour ne pas afficher `card:1:btn:0` à un opérateur. */
export function libelleHandle(handle: string, boutons: string[], locale: Locale): string {
  const carousel = /^card:(\d+):btn:(\d+)$/.exec(handle);
  if (carousel) {
    const c = Number(carousel[1]) + 1;
    const b = Number(carousel[2]) + 1;
    return locale === 'en' ? `Card ${c}, button ${b}` : `Carte ${c}, bouton ${b}`;
  }
  const simple = /^btn:(\d+)$/.exec(handle);
  if (simple) {
    const i = Number(simple[1]);
    const texte = boutons[i]?.trim();
    if (texte) return guillemets(texte, locale);
    return locale === 'en' ? `Button ${i + 1}` : `Bouton ${i + 1}`;
  }
  return handle;
}

/** Un bouton déclaré sur un bloc, avec son TYPE : un bouton URL ne se mesure pas comme un bouton de choix. */
interface BoutonDeclare {
  texte: string;
  type: string;
}

/**
 * Boutons déclarés sur un bloc (message rapide ou template), DANS L'ORDRE, types compris.
 *
 * Le type n'est pas décoratif : Meta n'émet AUCUN événement quand on clique un bouton URL. Traiter tous les
 * boutons pareil faisait proposer « A cliqué « Voir le site » » sur un lien, une case qui restait à zéro pour
 * toujours. Un message rapide n'a que des boutons de choix, d'où le type par défaut.
 */
function boutonsDe(n: GraphNode): BoutonDeclare[] {
  const d = n.data ?? {};
  const brut = Array.isArray(d.quickReplies) ? d.quickReplies : Array.isArray(d.templateButtons) ? d.templateButtons : [];
  return brut.map((b) => {
    if (typeof b !== 'object' || b === null) return { texte: '', type: 'QUICK_REPLY' };
    const o = b as { text?: unknown; type?: unknown };
    return { texte: String(o.text ?? ''), type: typeof o.type === 'string' ? o.type : 'QUICK_REPLY' };
  });
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
export function blocsDuScenario(
  graph: Graph,
  locale: Locale,
  handlesMesures: Record<string, string[]> = {},
  handlesLiens: Record<string, string[]> = {},
): BlocMesurable[] {
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
    const libelles = boutons.map((b) => b.texte);
    // Handles connus : ceux des boutons de CHOIX déclarés, ceux des arêtes du graphe, et ceux effectivement
    // mesurés. Les boutons URL en sont EXCLUS : Meta n'émet rien quand on les clique, leur compteur de
    // « choix » resterait à zéro pour toujours. Ils sont mesurés autrement, par la redirection.
    const desBoutons = boutons.map((b, i) => ({ b, i })).filter((x) => x.b.type !== 'URL').map((x) => `btn:${x.i}`);
    const desAretes = graph.edges.filter((e) => e.source === id && e.sourceHandle).map((e) => e.sourceHandle!);
    const tous = [...new Set([...desBoutons, ...desAretes, ...(handlesMesures[id] ?? [])])]
      // Les sorties TYPÉES d'un bloc ne sont pas des choix du contact : elles décrivent une issue technique.
      .filter((h) => !['true', 'false', 'sent', 'unreachable'].includes(h));
    const { titre, propre } = titreDe(n, locale);
    return {
      id,
      type: n.type,
      titre,
      titrePropre: propre,
      mesurable: estMesurable(n.type),
      choix: tous.map((h) => ({ handle: h, label: libelleHandle(h, libelles, locale) })),
      liens: (handlesLiens[id] ?? []).map((h) => ({ handle: h, label: libelleHandle(h, libelles, locale) })),
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
 * Libellés des mesures SANS bouton, en paires `[fr, en]`.
 *
 * Une seule table pour les deux lectures : `mesuresDisponibles` (qui nomme ce qu'on peut cocher) et
 * `libelleDeCle` (le repli quand la période ne porte aucun compteur). Deux copies divergeraient au premier
 * libellé retouché, et l'écran afficherait deux noms pour la même chose.
 */
const LIBELLES_NATURE: Record<string, [string, string]> = {
  sent: ['Envoyés', 'Sent'],
  failed: ['Échecs', 'Failed'],
  delivered: ['Délivrés', 'Delivered'],
  read: ['Lus', 'Read'],
  reply_text: ['A répondu (sans cliquer)', 'Replied (without tapping)'],
};

/** Libellé d'une mesure qui porte sur un BOUTON précis. `null` si la nature n'en est pas une. */
function libelleAvecBouton(kind: string, bouton: string, locale: Locale): string | null {
  const en = locale === 'en';
  if (kind === 'reply_button') return en ? `Tapped ${bouton}` : `A cliqué ${bouton}`;
  if (kind === 'url_click') return en ? `Clicked the link ${bouton}` : `A cliqué sur le lien ${bouton}`;
  return null;
}

/** Le libellé d'une nature sans bouton, dans la langue voulue. */
function libelleNature(kind: string, locale: Locale): string {
  const paire = LIBELLES_NATURE[kind];
  return paire ? (locale === 'en' ? paire[1] : paire[0]) : kind;
}

/**
 * Ce qu'on peut compter sur un bloc de message. L'ordre suit la lecture naturelle d'un entonnoir.
 *
 * `estPremier` = ce bloc est-il le PREMIER message du scénario ? Lui seul propose « Échecs » et « Délivrés ».
 * Après lui, le message part à quelqu'un qui vient de répondre : l'envoi aboutit et arrive quasiment toujours.
 * Ces deux mesures y afficheraient des barres plates, l'une à zéro et l'autre collée aux « Envoyés », et
 * noieraient le signal qu'on est venu chercher. Demandé par Julien le 2026-08-19.
 */
export function mesuresDisponibles(bloc: BlocMesurable, locale: Locale, estPremier = true): MesureDispo[] {
  if (!bloc.mesurable) return [];
  const nature = (kind: string): MesureDispo => ({ cle: `${bloc.id}|${kind}`, label: libelleNature(kind, locale), kind, handle: null });
  const base: MesureDispo[] = [
    nature('sent'),
    ...(estPremier ? [nature('failed'), nature('delivered')] : []),
    nature('read'),
  ];
  const choix: MesureDispo[] = bloc.choix.map((c) => ({
    cle: `${bloc.id}|reply_button|${c.handle}`,
    label: libelleAvecBouton('reply_button', c.label, locale)!,
    kind: 'reply_button',
    handle: c.handle,
  }));
  // Clics sur un LIEN : mesurés par notre redirection, pas par Meta, qui n'émet rien sur un bouton URL.
  const liens: MesureDispo[] = bloc.liens.map((l) => ({
    cle: `${bloc.id}|url_click|${l.handle}`,
    label: libelleAvecBouton('url_click', l.label, locale)!,
    kind: 'url_click',
    handle: l.handle,
  }));
  // « A répondu sans cliquer » est proposé partout, et pas seulement sur les blocs à boutons : sur un bloc qui
  // n'offre aucun choix, c'est LA mesure de l'engagement.
  return [...base, ...choix, ...liens, nature('reply_text')];
}

/** Une barre du graphe final. */
export interface Barre {
  nodeId: string;
  label: string;
  count: number;
  contacts: number | null;
}

/**
 * Valeur d'une mesure depuis les compteurs bruts. Absente des données = 0, et non « pas de barre » : une
 * mesure choisie qui vaut zéro est une information, la masquer laisserait croire à un oubli.
 */
export function valeurDe(counts: CompteurBrut[], nodeId: string, kind: string, handle: string | null): { count: number; contacts: number | null } {
  const l = counts.find((c) => c.nodeId === nodeId && c.kind === kind && (c.handle ?? null) === handle);
  // Mesure ABSENTE -> 0 personne, et non « inconnu » : les natures qui comptent des personnes en comptent
  // bien zéro quand rien n'est arrivé. Seule une ligne PRÉSENTE peut dire qu'elle ne sait pas les distinguer,
  // ce que fait le serveur pour les clics de lien (`contacts: null`).
  return { count: l?.count ?? 0, contacts: l ? l.contacts : 0 };
}

/** Les handles réellement mesurés, par bloc : sert à révéler les choix qu'un carousel ne déclare pas. */
export function handlesMesuresParBloc(counts: CompteurBrut[]): Record<string, string[]> {
  return handlesParBloc(counts, 'reply_button');
}

/**
 * Les boutons dont le LIEN est tracé, par bloc.
 *
 * C'est le serveur qui fait autorité, pas le graphe : celui-ci sait qu'un bouton est de type URL, jamais si
 * son lien passe par notre redirection. Le serveur rend une ligne même à ZÉRO clic, sinon la mesure ne
 * pourrait pas être cochée avant le premier clic.
 */
export function handlesClicsLienParBloc(counts: CompteurBrut[]): Record<string, string[]> {
  return handlesParBloc(counts, 'url_click');
}

function handlesParBloc(counts: CompteurBrut[], kind: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of counts) {
    if (c.kind !== kind || !c.handle) continue;
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
// Les clics sur un LIEN prennent une famille de teintes à part : dans un même bloc, « a cliqué « Oui » » et
// « a cliqué sur le lien » sont deux gestes différents, et les nuancer dans la même teinte les confondrait.
const NUANCES_LIEN = ['#C026D3', '#E879F9'];

export function couleurDe(kind: string, indexChoix = 0): string {
  if (kind === 'reply_button') return NUANCES_CLIC[indexChoix % NUANCES_CLIC.length]!;
  if (kind === 'url_click') return NUANCES_LIEN[indexChoix % NUANCES_LIEN.length]!;
  return COULEUR_PAR_NATURE[kind] ?? '#94A3B8';
}

export interface BarreTableau {
  cle: string;
  label: string;
  count: number;
  contacts: number | null;
  couleur: string;
}

/**
 * Libellé d'une mesure reconstruit à partir de sa SEULE clé (`nodeId|kind[|handle]`).
 *
 * Filet du filet : `mesuresDisponibles` ne sait nommer un bouton que si le compteur correspondant existe sur
 * la période choisie (`bloc.choix` et `bloc.liens` sont bâtis à partir des compteurs reçus). Sur une période
 * sans aucun clic, la clé d'un tableau enregistré ne s'y retrouve pas, et retomber sur le libellé FIGÉ
 * ferait ressortir du français dans une console en anglais. Ici on perd le texte du bouton, jamais la langue.
 */
function libelleDeCle(cle: string, locale: Locale): string {
  const [, kind = '', handle = ''] = cle.split('|');
  if (LIBELLES_NATURE[kind]) return libelleNature(kind, locale);
  // Sans les compteurs de la période, on n'a plus le TEXTE du bouton : son numéro reste juste et lisible.
  return libelleAvecBouton(kind, libelleHandle(handle, [], locale), locale) ?? cle;
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
  locale: Locale,
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
        // L'index de nuance se prend dans la liste de SA nature : un clic de lien numéroté sur la liste des
        // choix aurait pris la nuance d'un autre bouton, ou serait retombé sur la première faute de match.
        const liste = m.kind === 'url_click' ? b.liens : b.choix;
        const iChoix = m.handle ? Math.max(0, liste.findIndex((c) => c.handle === m.handle)) : 0;
        // Libellé RE-DÉRIVÉ dans la langue courante, jamais celui de `m`. Un tableau enregistré garde le
        // libellé figé au moment de l'enregistrement : le relire tel quel ressortirait du français dans une
        // console en anglais, même une fois tout le reste traduit. `label` reste dans le JSON stocké, il
        // cesse simplement de faire autorité à l'affichage.
        const frais = mesuresDisponibles(b, locale, true).find((x) => x.cle === m.cle)?.label ?? libelleDeCle(m.cle, locale);
        return { cle: m.cle, label: frais, ...valeurDe(counts, b.id, m.kind, m.handle), couleur: couleurDe(m.kind, iChoix) };
      }),
    }));
}
