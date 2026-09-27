import type { FicheAgentContenu } from '../fiche';

/**
 * L'ordre du jour de l'entretien, et qui le conduit : le serveur, pas le modèle. Le modèle formule la
 * question qu'on lui désigne et extrait la réponse.
 *
 * 1. Un point n'est couvert que s'il a été posé au client (`poses`), pas parce que le modèle prétend en
 *    connaître la réponse. Une réponse donnée d'avance est gardée, et se fait confirmer en une phrase.
 * 2. Certains points n'existent que si une réponse les fait exister : répondre « l'agent le fait tout seul »
 *    à une bascule ouvre la question du moyen, et l'entretien ne peut pas se terminer sans.
 *
 * Chaque point correspond à ce qu'il faut savoir pour écrire la fiche sans rien inventer.
 */

/**
 * Ce que l'agent fait au moment d'une bascule. Énumération fermée, lue par le serveur pour décider s'il
 * reste une question à poser. `continuer` est une réponse complète : sans elle, le modèle inventerait une
 * action pour un moment qui n'en demande aucune.
 */
export const ACTIONS = ['scenario', 'outil_api', 'outil_mcp', 'humain', 'continuer', 'autre'] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * Le questionnaire montré au client pour une bascule, un choix par ligne. `humain` et `continuer` restent
 * proposés : sans eux, le client ne pourrait pas dire « rien de spécial », et une action serait inventée.
 */
export const CHOIX_ACTION: ReadonlyArray<{ action: Action; libelle: string }> = [
  { action: 'scenario', libelle: 'créer et lancer un scénario' },
  { action: 'outil_api', libelle: 'appeler un outil branché par API (un connecteur que vous avez déclaré)' },
  { action: 'outil_mcp', libelle: 'appeler un outil branché par MCP (un serveur MCP que vous avez déclaré)' },
  { action: 'humain', libelle: 'passer la main à un humain' },
  { action: 'continuer', libelle: 'rien de particulier, il continue simplement à répondre' },
  { action: 'autre', libelle: 'autre chose' },
];

/** Les actions qui appellent un moyen concret. `humain` a son propre point, `continuer` ne demande rien. */
const DEMANDE_UN_MOYEN = new Set<Action>(['scenario', 'outil_api', 'outil_mcp', 'autre']);

/**
 * Ce qui est réellement branché, au moment où on pose la question : la conversation ne peut pas se conclure
 * sur un moyen qui n'existe pas. Des listes distinctes, parce que chaque situation appelle une réponse
 * différente.
 */
export interface Inventaire {
  /** Les outils de connecteur déjà branchés sur cet agent : appelables aujourd'hui. */
  outilsApi: string[];
  /** Les systèmes déclarés dans l'espace mais pas branchés sur cet agent : à relier (geste d'administrateur).
   *  Les taire ferait dire « rien n'existe » à un client qui a déclaré son ERP. */
  systemesApi: string[];
  /** Les serveurs MCP déclarés dans l'espace, mais dont aucun outil n'est encore branché sur cet agent. */
  mcp: string[];
  /** Les outils MCP déjà branchés sur cet agent, par leur nom exposé : séparés des connecteurs API, pour ne
   *  pas promettre un appel API sur un outil MCP. */
  outilsMcp: string[];
}

export const INVENTAIRE_VIDE: Inventaire = { outilsApi: [], systemesApi: [], mcp: [], outilsMcp: [] };

/** Une énumération lisible, « a, b et c ». */
function enumerer(noms: readonly string[]): string {
  if (noms.length <= 1) return noms[0] ?? '';
  return `${noms.slice(0, -1).join(', ')} et ${noms[noms.length - 1]}`;
}

/** Le questionnaire, tel qu'il part dans le prompt et dans la question de repli. */
export function questionnaireAction(moment: string): string {
  const lignes = CHOIX_ACTION.map((c, i) => `${i + 1}) ${c.libelle}`).join('\n');
  return [`Quand ${moment}, que doit faire l’agent ?`, lignes].join('\n');
}

export interface Point {
  code: string;
  /** Ce que l'assistant doit avoir obtenu. Part dans le prompt, telle quelle. */
  aObtenir: string;
  /**
   * La question, telle qu'on la poserait : le modèle la reformule, et le serveur la pose lui-même quand le
   * modèle a rendu un message qui n'interroge rien. Sans ce repli, l'entretien s'arrêterait sur un accusé de
   * réception.
   */
  question: string;
  /** Possibilités à montrer au client pour qu'il tranche au lieu de rédiger : des exemples à transposer dans
   *  son métier, jamais un menu à réciter. */
  pistes?: string[];
  /** Ce point collecte une liste de moments, et chaque moment ouvre ensuite ses propres questions : autant de
   *  moments que le client en cite, chacun avec son action. */
  collecteDesMoments?: true;
}

/**
 * L'ordre du jour, de la substance vers la surface : on ne demande le ton et l'identité qu'une fois qu'on
 * sait ce que l'agent fait. `tests/agent-setup-agenda.test.ts` tient l'invariant que chaque point a quelque
 * part où ranger sa réponse.
 */
export const AGENDA: Point[] = [
  {
    code: 'mission',
    question: 'Au-delà de répondre aux questions, quel est le but de votre agent ?',
    aObtenir: 'ce que l’agent est là pour faire, au-delà de répondre',
    pistes: ['répondre et orienter', 'qualifier une demande', 'prendre un rendez-vous', 'faire un suivi de commande'],
  },
  {
    code: 'perimetre',
    question: 'Y a-t-il des choses dont il ne doit jamais parler, ou qu’il ne doit jamais faire ?',
    aObtenir: 'ce dont il ne parle pas, ce qu’il ne fait jamais',
    pistes: ['rien de tarifaire', 'aucun engagement contractuel', 'pas de conseil technique'],
  },
  {
    code: 'connaissance',
    question: 'D’où viendront ses réponses de fond : des pages de votre site, un document que vous me joignez, des fiches que vous écrirez, ou rien pour l’instant ?',
    /** « Mon site » ne suffit pas : une source qu'on ne sait pas nommer laisse la base de connaissance vide. */
    aObtenir: 'D’OÙ viennent ses réponses de fond : une base de connaissance à remplir, des pages de son site '
      + 'à importer, un document qu’il va joindre, ou rien du tout (et alors l’agent transfère toute question de fond). '
      + 'S’il dit « mon site », DEMANDE-LUI L’ADRESSE EXACTE avant de passer au point suivant : sans elle, '
      + 'personne ne peut remplir sa base, et son agent transférera toutes les questions de fond',
    pistes: ['des pages de mon site', 'un document que je vous donne', 'je remplirai les fiches à la main', 'rien pour l’instant'],
  },
  {
    code: 'aboutissements',
    question: 'À quoi ressemble une conversation réussie, celle après laquelle vous êtes content ?',
    aObtenir: 'à quoi ressemble une conversation qui finit bien ; il peut y en avoir plusieurs',
    pistes: ['rendez-vous pris', 'demande qualifiée', 'question résolue', 'transmis à un humain'],
  },
  {
    code: 'bascules',
    question: 'À quels moments votre agent doit-il faire autre chose que répondre ? Citez-les, on les prendra un par un.',
    aObtenir: 'la LISTE des moments où il doit faire autre chose que répondre. Ne demande PAS encore ce qu’il '
      + 'y fait : on prendra chaque moment un par un juste après',
    pistes: ['le client veut prendre rendez-vous', 'il demande où vous êtes', 'il faut qualifier son besoin'],
    collecteDesMoments: true,
  },
  {
    /**
     * Le silence du contact est une fin de conversation comme une autre (`agents.inactivite_minutes`) : un
     * réglage qu'on ne demande jamais garde sa valeur d'usine chez tout le monde. Placé entre
     * `aboutissements` et `humain` : ce qui réussit, ce qui se passe sans réponse, puis qui reprend.
     */
    code: 'silence',
    question: 'Si le contact ne répond plus, au bout de combien de temps votre agent doit-il lâcher la conversation ?',
    aObtenir: 'au bout de combien de temps SANS réponse du contact l’agent cesse d’attendre, EN MINUTES. '
      + 'Convertis toi-même ce qu’il dit (« une demi-heure » = 30, « deux heures » = 120, « une journée » = 1440). '
      + 'Le maximum est 24 heures, soit 1440 minutes : s’il demande plus, dis-le et propose 1440',
    pistes: ['30 minutes', '2 heures', 'une demi-journée', '24 heures'],
  },
  {
    code: 'humain',
    question: 'Quand un humain doit-il reprendre la conversation ? « Jamais » est une réponse valable.',
    aObtenir: 'quand un humain reprend la conversation ; « jamais » est une réponse valable',
    pistes: ['sur demande explicite', 'quand l’agent bloque', 'sur un sujet sensible', 'jamais'],
  },
  {
    code: 'identite',
    question: 'Sous quel nom votre agent se présente-t-il, et quels traits doit-il avoir ?',
    aObtenir: 'sous quel NOM l’agent se présente au contact (ou aucun), et les deux ou trois traits qui le '
      + 'caractérisent',
    pistes: ['un prénom', 'le nom de la marque', 'aucun nom'],
  },
  {
    /**
     * Un seul point pour deux questions (annoncer, puis à quelle fréquence) : la seconde n'a de sens que si la
     * première est oui. Un point d'agenda est une unité de couverture, pas de phrase ; la relance ciblée est
     * dans `aObtenir`, comme pour `connaissance`.
     */
    code: 'annonce_ia',
    question: 'Votre agent doit-il annoncer qu’il est une IA ? Si oui, à chaque message ou une seule fois par conversation ?',
    aObtenir: 'SI l’agent annonce qu’il est une IA, et si oui À QUELLE FRÉQUENCE : à chaque message, ou une '
      + 'seule fois par conversation. S’il répond oui sans préciser, DEMANDE-LUI la fréquence avant de passer '
      + 'au point suivant : sans elle, on ne peut pas régler l’agent et il retombe sur « une fois par '
      + 'conversation », qui n’est peut-être pas ce qu’il veut. ⚠️ Ne cherche pas à le convaincre : informer '
      + 'l’interlocuteur relève de SA responsabilité de marque, pas de la nôtre, et « jamais » est une réponse '
      + 'parfaitement valable qu’on enregistre sans commenter',
    pistes: ['oui, une fois par conversation', 'oui, à chaque message', 'non, jamais'],
  },
  {
    code: 'ton',
    question: 'Comment doit-il parler : vouvoiement ou tutoiement, phrases courtes ou développées, emoji ou non ?',
    aObtenir: 'comment il parle : vouvoiement ou tutoiement, phrases courtes ou développées, emoji ou non',
    pistes: ['vouvoiement, phrases courtes, sans emoji', 'tutoiement, chaleureux', 'formel et détaillé'],
  },
];

const PAR_CODE = new Map(AGENDA.map((p) => [p.code, p]));

/** Les codes valables, pour l'énumération du schéma montré au modèle. */
export const CODES_POINTS = AGENDA.map((p) => p.code) as [string, ...string[]];

/** Une réponse retenue par l'assistant, rattachée à un point de l'ordre du jour. */
export interface Reponse {
  point: string;
  /** Ce que le client a dit, dans les mots de l'assistant. Vide = rien de retenu, donc rien de couvert. */
  valeur: string;
}

/**
 * Un moment où l'agent doit faire autre chose que répondre, et ce qu'il y fait. Une liste : deux moments
 * cités dans la même phrase ne doivent pas s'écraser.
 */
export interface Bascule {
  /** Le moment, dans les mots du client. Sert de clé (on apparie là-dessus) et d'intitulé de question. */
  moment: string;
  /** Ce que l'agent y fait. Absent = pas encore tranché, c'est la prochaine question. */
  action?: Action;
  /** Le moyen concret (quel scénario, quel connecteur, quoi d'autre). Absent quand l'action n'en demande pas. */
  moyen?: string;
}

/** L'état de l'entretien, tel que le serveur le tient. */
export interface EtatEntretien {
  /** Les points déjà posés au client. Un point jamais posé n'est jamais couvert, même répondu d'avance. */
  poses: string[];
  reponses: Reponse[];
  /** Les moments de bascule et leur traitement. Vide tant que le point `bascules` n'a rien donné. */
  bascules?: Bascule[];
}

/** Une réponse est retenue si elle porte un code connu et un contenu. Le reste vient d'un modèle, donc d'une
 *  source non fiable : inventer un code ne doit rien débloquer, et ne doit rien casser non plus. */
function retenues(reponses: readonly Reponse[]): Reponse[] {
  return reponses.filter((r) => PAR_CODE.has(r.point) && r.valeur.trim() !== '');
}

/** Les bascules réellement exploitables : un moment non vide. Le reste vient d'un modèle. */
function bascules(etat: EtatEntretien): Bascule[] {
  return (etat.bascules ?? []).filter((b) => b.moment.trim() !== '');
}

/** Codes des points engendrés par une bascule. L'index les rend stables tant que la liste ne se réordonne
 *  pas, ce que `fusionnerBascules` garantit (appariement par moment, ajout en fin). */
const codeAction = (i: number): string => `bascule_${i + 1}_action`;
const codeMoyen = (i: number): string => `bascule_${i + 1}_moyen`;

/** Le libellé d'une action, pour le prompt et l'écran. */
export function libelleAction(action: Action): string {
  return CHOIX_ACTION.find((c) => c.action === action)?.libelle ?? action;
}

/**
 * L'ordre du jour effectif : les points de base, plus deux points par bascule citée (que fait-on ? par quel
 * moyen ?), insérés après le point qui les a fait naître. L'entretien ne peut pas se terminer tant qu'il en
 * reste un ; le total grandit à mesure que le client cite des moments.
 */
export function agendaEffectif(etat: EtatEntretien, inv: Inventaire = INVENTAIRE_VIDE): Point[] {
  const liste = bascules(etat);
  const engendres: Point[] = [];
  liste.forEach((b, i) => {
    engendres.push({
      code: codeAction(i),
      question: questionnaireAction(b.moment),
      aObtenir: `ce que l’agent fait quand « ${b.moment} », parmi les choix proposés`,
    });
    if (b.action && DEMANDE_UN_MOYEN.has(b.action)) {
      engendres.push({
        code: codeMoyen(i),
        question: `Pour « ${b.moment} » : ${moyenDemande(b.action, inv)}`,
        aObtenir: `le moyen CONCRET pour « ${b.moment} » (${libelleAction(b.action)})`,
      });
    }
  });
  const out: Point[] = [];
  for (const p of AGENDA) {
    out.push(p);
    if (p.collecteDesMoments) out.push(...engendres);
  }
  return out;
}

/**
 * La question du moyen, selon l'action choisie et l'inventaire réel : elle montre ce qui est branché, et
 * quand rien ne l'est, propose de changer d'action ou de décrire ce qu'il faudra brancher, pour que
 * l'entretien puisse toujours se terminer.
 */
function moyenDemande(action: Action, inv: Inventaire): string {
  if (action === 'scenario') return 'quel scénario doit-il lancer, ou que doit contenir ce scénario ?';
  if (action === 'outil_api') {
    if (inv.outilsApi.length > 0) {
      const dispo = `Branchés sur cet agent : ${enumerer(inv.outilsApi)}.`;
      const aRelier = inv.systemesApi.length > 0
        ? ` Déclarés dans votre espace mais pas encore reliés à cet agent : ${enumerer(inv.systemesApi)}.`
        : '';
      return `lequel doit-il appeler ? ${dispo}${aRelier}`;
    }
    if (inv.systemesApi.length > 0) {
      return 'AUCUN connecteur n’est branché sur cet agent. Vous avez déclaré '
        + `${enumerer(inv.systemesApi)} dans votre espace : il reste à y brancher l’appel (menu Tools > `
        + 'Connecteurs API). En attendant, dites-moi lequel, ou choisissez autre chose pour ce moment.';
    }
    return 'AUCUN connecteur API n’est branché, et aucun système n’est déclaré dans votre espace : il n’y a '
      + 'rien à appeler aujourd’hui. Décrivez ce qu’il faudrait brancher, ou choisissez autre chose pour ce moment.';
  }
  if (action === 'outil_mcp') {
    // Même forme que `outil_api`, sur deux niveaux : ce qui est branché sur cet agent d'abord, ce qui est
    // seulement déclaré dans l'espace ensuite.
    if (inv.outilsMcp.length > 0) {
      const dispo = `Branchés sur cet agent : ${enumerer(inv.outilsMcp)}.`;
      const aRelier = inv.mcp.length > 0
        ? ` Serveurs déclarés dans votre espace mais dont rien n'est encore relié à cet agent : ${enumerer(inv.mcp)}.`
        : '';
      return `lequel doit-il appeler ? ${dispo}${aRelier}`;
    }
    if (inv.mcp.length > 0) {
      return 'AUCUN outil MCP n’est branché sur cet agent. Vous avez déclaré '
        + `${enumerer(inv.mcp)} dans votre espace : il reste à en importer les outils (menu Tools > `
        + 'Connecteurs MCP). En attendant, dites-moi lequel, ou choisissez autre chose pour ce moment.';
    }
    return 'AUCUN serveur MCP n’est déclaré dans votre espace : il n’y a rien à appeler aujourd’hui. '
      + 'Vous pouvez en déclarer un depuis le menu Tools > Connecteurs MCP. Décrivez ce qu’il faudrait '
      + 'brancher, ou choisissez autre chose pour ce moment.';
  }
  return 'que doit-il faire exactement ?';
}

/**
 * Les points dont le contenu a disparu de la fiche, élément par élément : vider un champ fait parler de ce
 * point-là seulement. Un signalement, pas une question : la réponse du client est toujours dans
 * `reponses`, c'est le champ qui a été effacé.
 *
 * Seuls les points dont le champ a un état « vide » signifiant sont surveillés : `silence` et `annonce_ia`
 * ont toujours une valeur, `connaissance` peut être vide à bon droit, `perimetre` et `bascules` vivent dans
 * l'entretien.
 */
export function pointsSansContenu(fiche: FicheAgentContenu): string[] {
  const vide = (t: string): boolean => t.trim() === '';
  const out: string[] = [];
  if (vide(fiche.objectif)) out.push('mission');
  if (fiche.sorties.length === 0) out.push('aboutissements');
  if (vide(fiche.reglesTransfert)) out.push('humain');
  // `identite` couvre le nom et les traits : vide seulement si les deux le sont.
  if (vide(fiche.nom) && vide(fiche.personnalite)) out.push('identite');
  if (vide(fiche.ton)) out.push('ton');
  return out;
}

/**
 * Ce qui reste à couvrir, dans l'ordre. Un point est couvert s'il a été posé et répondu.
 *
 * Un champ vidé ne rouvre pas son point : la couverture retient la proposition, et un champ ne se remplit
 * qu'en appliquant une proposition. Le rouvrir enfermerait l'entretien dans un cycle. Un champ vidé produit
 * un signalement (`pointsSansContenu`).
 */
export function manquesDeCouverture(etat: EtatEntretien, inv: Inventaire = INVENTAIRE_VIDE): string[] {
  const poses = new Set(etat.poses);
  const repondus = new Set(retenues(etat.reponses).map((r) => r.point));
  const liste = bascules(etat);
  // Une question engendrée est répondue quand la bascule porte le champ : pas de copie dans `reponses`, qui
  // finirait par diverger.
  liste.forEach((b, i) => {
    if (b.action) repondus.add(codeAction(i));
    if (b.moyen && b.moyen.trim() !== '') repondus.add(codeMoyen(i));
  });
  return agendaEffectif(etat, inv)
    .filter((p) => !(poses.has(p.code) && repondus.has(p.code)))
    .map((p) => p.code);
}

/** Tous les points de l'ordre du jour effectif, par code. */
function parCode(etat: EtatEntretien, inv: Inventaire): Map<string, Point> {
  return new Map(agendaEffectif(etat, inv).map((p) => [p.code, p]));
}

/**
 * Le point de ce tour : le premier non couvert de l'ordre du jour effectif, ou `null` si l'entretien est
 * fini. Seule cette fonction décide de quoi on parle.
 */
export function prochainPoint(etat: EtatEntretien, inv: Inventaire = INVENTAIRE_VIDE): Point | null {
  const manquants = manquesDeCouverture(etat, inv);
  return manquants.length === 0 ? null : parCode(etat, inv).get(manquants[0]!) ?? null;
}

/**
 * Le point ouvert et celui qui le suit : le serveur choisit la question avant de lire la réponse, et ne sait
 * pas si le message traité répond déjà au point ouvert. Deux points laissent enchaîner sans reposer une
 * question résolue, sans permettre de sauter plus loin.
 */
export function prochainsPoints(etat: EtatEntretien, inv: Inventaire = INVENTAIRE_VIDE): [Point | null, Point | null] {
  const manquants = manquesDeCouverture(etat, inv);
  const par = parCode(etat, inv);
  return [par.get(manquants[0] ?? '') ?? null, par.get(manquants[1] ?? '') ?? null];
}

/** Fusionne les réponses d'un tour. Une nouvelle réponse remplace l'ancienne du même point : le client a le
 *  droit de se raviser. */
export function fusionner(etat: readonly Reponse[], nouvelles: readonly Reponse[]): Reponse[] {
  const par = new Map(etat.map((r) => [r.point, r]));
  for (const r of retenues(nouvelles)) par.set(r.point, r);
  // Ordre de l'agenda, pas d'arrivée : l'état se relit comme le questionnaire.
  return AGENDA.map((p) => par.get(p.code)).filter((r): r is Reponse => r !== undefined);
}

/**
 * Fusionne les bascules d'un tour, appariées par moment et ajoutées en fin : les codes engendrés
 * (`bascule_2_action`) restent stables, sinon un point noté posé désignerait une autre bascule. Un champ
 * absent d'une nouvelle version n'efface rien : le modèle rend souvent la bascule entière en n'ayant appris
 * que son action.
 */
export function fusionnerBascules(etat: readonly Bascule[], nouvelles: readonly Bascule[]): Bascule[] {
  const out = etat.map((b) => ({ ...b }));
  for (const n of nouvelles) {
    const moment = n.moment.trim();
    if (moment === '') continue;
    const deja = out.find((b) => b.moment.trim().toLowerCase() === moment.toLowerCase());
    if (!deja) {
      out.push({ moment, ...(n.action ? { action: n.action } : {}), ...(n.moyen ? { moyen: n.moyen } : {}) });
      continue;
    }
    if (n.action) deja.action = n.action;
    if (n.moyen && n.moyen.trim() !== '') deja.moyen = n.moyen;
  }
  return out;
}

/**
 * L'ordre du jour tel qu'il part dans le prompt, entier et avec ce qui est déjà su : le modèle doit voir
 * qu'une réponse donnée rend une question inutile à reposer telle quelle, et revenir sur un point contredit.
 */
export function ordreDuJour(
  etat: EtatEntretien, inv: Inventaire = INVENTAIRE_VIDE, vides: readonly string[] = [],
): string {
  const gardees = new Map(retenues(etat.reponses).map((r) => [r.point, r.valeur]));
  // Ce qu'on sait des points engendrés vit sur la bascule : reprojeté ici, pour un ordre du jour d'un seul bloc.
  bascules(etat).forEach((b, i) => {
    if (b.action) gardees.set(codeAction(i), libelleAction(b.action));
    if (b.moyen && b.moyen.trim() !== '') gardees.set(codeMoyen(i), b.moyen);
  });
  const poses = new Set(etat.poses);
  const effectif = agendaEffectif(etat, inv);
  const large = Math.max(...effectif.map((p) => p.code.length));
  return effectif
    .map((p) => {
      const su = gardees.get(p.code);
      /** « Vidé depuis » et non « à poser » : la réponse existe, c'est le champ qui a été effacé ailleurs. */
      const etatDuPoint = vides.includes(p.code) && su !== undefined
        ? 'VIDÉ DEPUIS, à reproposer'
        : su === undefined
          ? 'À POSER'
          : poses.has(p.code) ? 'couvert' : 'répondu d’avance, À FAIRE CONFIRMER';
      return `  ${p.code.padEnd(large)} [${etatDuPoint}] : ${p.aObtenir}${su ? ` -> « ${su} »` : ''}`;
    })
    .join('\n');
}

/**
 * La première adresse http(s) de la réponse au point `connaissance`, ou `null`. Un repli pour les entretiens
 * menés avant le champ dédié `connaissanceUrl`. La ponctuation finale est retirée : « ...son site
 * https://exemple.fr. » donnerait sinon une adresse qui ne résout pas.
 */
const URL_DANS_LE_TEXTE = /https?:\/\/[^\s<>"'),]+/;

export function urlDeConnaissance(etat: EtatEntretien): string | null {
  const dit = etat.reponses.find((r) => r.point === 'connaissance')?.valeur ?? '';
  const trouve = URL_DANS_LE_TEXTE.exec(dit);
  return trouve ? trouve[0].replace(/[.,;:!?]+$/, '') : null;
}

/** Les possibilités à montrer pour le point du tour, si on en a. */
export function pistesDe(point: Point): string {
  return point.pistes && point.pistes.length > 0 ? point.pistes.join(' | ') : '(aucune piste toute faite : fais-le parler)';
}

/**
 * Le message pose-t-il une question ? Test volontairement grossier, dans un seul sens : sans point
 * d'interrogation, aucune question à coup sûr. Il ne sert qu'à déclencher un repli (le serveur pose la
 * question), jamais à refuser un message : un faux négatif ajoute une question, un faux positif laisserait
 * l'entretien mort.
 */
export function poseUneQuestion(message: string): boolean {
  return message.includes('?');
}
