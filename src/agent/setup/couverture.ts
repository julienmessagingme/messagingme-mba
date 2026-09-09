/**
 * L'ORDRE DU JOUR DE L'ENTRETIEN, ET QUI LE CONDUIT.
 *
 * 🔴 CE FICHIER A CHANGÉ DE NATURE LE 2026-08-31. Il portait six dimensions à plat, le modèle choisissait sa
 * question suivante, et il déclarait lui-même ce qu'il avait couvert. Le serveur ne faisait que compter. Rien
 * n'était déterministe, et ça se voyait : Julien, à l'usage, « la première phase (objectif, quand s'arrêter)
 * se passe bien, mais il manque beaucoup de choses au questionnement : le ton, l'identité, quelle base de
 * connaissance pour répondre aux questions ». Un modèle pressé de faire plaisir déclarait couvert et passait.
 *
 * L'INVERSION : l'ordre du jour et la couverture sont des faits du SERVEUR. Le modèle ne choisit plus rien ;
 * il formule la question qu'on lui désigne et il extrait la réponse. Deux conséquences qui font la
 * détermination :
 *
 *  1. **Un point n'est couvert que s'il a été POSÉ au client** (`poses`), pas seulement si le modèle prétend
 *     connaître la réponse. C'est ce qui garantit qu'on a réellement fait le tour, et pas que le modèle a
 *     bien deviné. Une réponse donnée spontanément avant qu'on pose la question est gardée : le tour venu, on
 *     la fait CONFIRMER en une phrase au lieu de reposer la question, ce qui rend l'entretien court sans rien
 *     sauter.
 *  2. **Certains points n'existent que si la réponse à un autre les fait exister** (`debloquePar`). C'est le
 *     creusement que Julien demandait : « si c'est l'agent qui peut le faire lui-même, il faut que l'agent
 *     creuse et demande, ben comment l'agent fait dans ces cas là ? (en gros il faut définir quel tool
 *     l'agent va pouvoir appeler pour gérer ça) ». Répondre « l'agent le fait tout seul » à `bascules` ouvre
 *     donc `quel_outil`, mécaniquement, et l'entretien ne peut pas se terminer sans.
 *
 * Chaque point correspond à ce qu'il faut savoir pour écrire la fiche sans rien inventer : ce n'est pas un
 * questionnaire décoratif.
 */

/**
 * Ce que l'agent FAIT au moment d'une bascule. Énumération fermée, et c'est elle qui pilote le creusement :
 * le serveur lit cette valeur pour décider s'il reste une question à poser.
 *
 * ⚠️ `continuer` est une réponse COMPLÈTE, pas un aveu d'ignorance. Un client qui pose encore des questions
 * n'est pas un point de bascule, c'est le travail normal de l'agent. Sans cette valeur, le modèle inventerait
 * une action pour un moment qui n'en demande aucune, ce qu'il faisait avant le 2026-08-28.
 */
export const ACTIONS = ['scenario', 'outil_api', 'outil_mcp', 'humain', 'continuer', 'autre'] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * Le questionnaire montré au client pour UNE bascule. Julien, 2026-08-31 : « il faut que tu prennes 1 par 1,
 * je dis bien 1 par 1, et que tu poses les questions sous forme de questionnaire avec des choix ».
 *
 * ⚠️ `humain` et `continuer` ne figuraient pas dans sa liste, et sont gardés quand même : ce sont DEUX réponses
 * qu'il avait lui-même exigées le 2026-08-28 (« si le mec continue de poser des questions ben tu continues de
 * répondre »). Les retirer rouvrirait le défaut qu'on venait de fermer, celui de l'action inventée faute de
 * pouvoir dire « rien de spécial ».
 *
 * ⚠️ `outil_mcp` est proposé alors que MCP N'EST PAS ENCORE CÂBLÉ (lot L4, non développé). C'est assumé : le
 * client doit pouvoir dire son intention, et l'assistant a pour consigne de préciser que ce sera à brancher.
 * Le taire donnerait un questionnaire qui ment par omission ; le proposer sans le dire promettrait un
 * branchement inexistant.
 */
export const CHOIX_ACTION: ReadonlyArray<{ action: Action; libelle: string }> = [
  { action: 'scenario', libelle: 'créer et lancer un scénario' },
  { action: 'outil_api', libelle: 'appeler un outil branché par API (un connecteur que vous avez déclaré)' },
  { action: 'outil_mcp', libelle: 'appeler un outil branché par MCP (pas encore disponible : ce serait à brancher)' },
  { action: 'humain', libelle: 'passer la main à un humain' },
  { action: 'continuer', libelle: 'rien de particulier, il continue simplement à répondre' },
  { action: 'autre', libelle: 'autre chose' },
];

/** Les actions qui appellent un MOYEN concret. `humain` a son propre point, `continuer` ne demande rien. */
const DEMANDE_UN_MOYEN = new Set<Action>(['scenario', 'outil_api', 'outil_mcp', 'autre']);

/**
 * CE QUI EST RÉELLEMENT BRANCHÉ, au moment où on pose la question.
 *
 * 🔴 Julien, 2026-08-31 : « si la personne dit MCP ou API, il faut que t'ailles chercher ce qui est branché
 * pour que la personne dise exactement lequel c'est ; donc si c'est pas branché ou s'il y a rien, ben y a
 * rien et la personne devra choisir autre chose ».
 *
 * C'est le dernier verrou contre l'outil inventé. Le reste du dispositif empêche le MODÈLE d'en inventer un ;
 * celui-ci empêche la CONVERSATION de se conclure sur un moyen qui n'existe pas, en montrant l'inventaire réel
 * au lieu de laisser le client nommer quelque chose au hasard.
 *
 * Trois listes et pas une, parce que les trois situations appellent trois réponses différentes.
 */
export interface Inventaire {
  /** Les outils de connecteur DÉJÀ branchés SUR CET AGENT : appelables aujourd'hui, sans rien faire de plus. */
  outilsApi: string[];
  /** Les systèmes déclarés dans l'espace mais PAS branchés sur cet agent : à relier, ce qui est un geste
   *  d'administrateur et non une réponse d'entretien. Les taire ferait dire « rien n'existe » à un client qui
   *  a justement déclaré son ERP la semaine dernière. */
  systemesApi: string[];
  /** Les serveurs MCP déclarés. ⚠️ MCP n'est PAS exécutable aujourd'hui (lot L4 non développé) : même non
   *  vide, cette liste ne rend rien appelable, et la question le dit. */
  mcp: string[];
}

export const INVENTAIRE_VIDE: Inventaire = { outilsApi: [], systemesApi: [], mcp: [] };

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
   * LA QUESTION, telle qu'on la poserait. Deux usages, et le second est le seul qui garantisse quoi que ce
   * soit : le modèle la reçoit pour la reformuler dans le fil de la conversation, ET le serveur la POSE
   * LUI-MÊME quand le modèle a rendu un message qui n'interroge rien. Sans ce repli, l'entretien s'arrête net
   * sur un accusé de réception, ce qui est arrivé à Julien le 2026-08-31 au point 3 sur 8.
   */
  question: string;
  /** Possibilités à montrer au client pour qu'il tranche au lieu de rédiger. Ce sont des EXEMPLES à
   *  transposer dans son métier, jamais un menu à réciter (cf. le mandat). */
  pistes?: string[];
  /**
   * Ce point COLLECTE une liste de moments, et chaque moment ouvre ensuite ses propres questions. C'est le
   * creusement, et il est devenu une BOUCLE le 2026-08-31 : il n'y a pas « un » moment de bascule avec « une »
   * action, il y en a autant que le client en cite, chacun avec la sienne.
   */
  collecteDesMoments?: true;
}

/**
 * L'ordre du jour, de la substance vers la surface.
 *
 * Il compte neuf points au lieu de six, et l'ordre n'est pas décoratif : on ne demande le ton et l'identité
 * qu'une fois qu'on sait ce que l'agent fait, sinon on décore une coquille. Neuf reste tenable ; c'est
 * l'entretien de quarante questions qui serait un formulaire avec plus de friction, pas celui-ci.
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
    /**
     * 🔴 « MON SITE » N'EST PAS UNE RÉPONSE SUFFISANTE, ET S'EN CONTENTER A COÛTÉ UN AGENT MUET. Le
     * 2026-09-08, Julien a répondu « les réponses viennent du site internet ». L'entretien l'a noté, n'a
     * jamais demandé LEQUEL, et l'onglet Base de connaissance est resté vide : il a fallu y coller l'adresse
     * à la main. Une source qu'on ne sait pas nommer n'est pas une source, c'est une intention.
     */
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
     * 🔴 UN SEUL POINT POUR DEUX QUESTIONS, ET C'EST VOULU. Julien en a demandé deux (« dois-je dire que je
     * suis une IA », puis « à chaque fois ou une fois par session »), mais la seconde n'a de sens que si la
     * première est oui : deux points la poseraient même après un non. Un point d'agenda est une unité de
     * COUVERTURE, pas de phrase, et le repli du serveur repose `question` quand le modèle n'interroge rien.
     * Même forme que `connaissance`, qui exige déjà une relance ciblée dans son `aObtenir`.
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
 * UN moment où l'agent doit faire autre chose que répondre, et ce qu'il y fait.
 *
 * 🔴 C'est une LISTE, et c'est tout l'objet du changement du 2026-08-31. Le modèle précédent portait UNE action
 * sur le point `bascules` : Julien en a cité deux dans la même phrase (prendre un rendez-vous -> un outil ;
 * donner l'adresse d'une concession -> un scénario), et le second écrasait le premier en silence.
 */
export interface Bascule {
  /** Le moment, dans les mots du client. Sert de CLÉ (on apparie là-dessus) et d'intitulé de question. */
  moment: string;
  /** Ce que l'agent y fait. Absent = pas encore tranché, c'est la prochaine question. */
  action?: Action;
  /** Le moyen concret (quel scénario, quel connecteur, quoi d'autre). Absent quand l'action n'en demande pas. */
  moyen?: string;
}

/** L'état de l'entretien, tel que le serveur le tient. */
export interface EtatEntretien {
  /** Les points DÉJÀ POSÉS au client. Un point jamais posé n'est jamais couvert, même répondu d'avance. */
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

/** Codes des points ENGENDRÉS par une bascule. L'index les rend stables tant que la liste ne se réordonne
 *  pas, ce que `fusionnerBascules` garantit (appariement par moment, ajout en fin). */
const codeAction = (i: number): string => `bascule_${i + 1}_action`;
const codeMoyen = (i: number): string => `bascule_${i + 1}_moyen`;

/** Le libellé d'une action, pour le prompt et l'écran. */
export function libelleAction(action: Action): string {
  return CHOIX_ACTION.find((c) => c.action === action)?.libelle ?? action;
}

/**
 * L'ordre du jour EFFECTIF : les points de base, plus DEUX points par bascule citée (que fait-on ? par quel
 * moyen ?), insérés juste après le point qui les a fait naître.
 *
 * 🔴 C'est ici que « un par un » devient un fait et non une consigne. Une bascule sans action engendre sa
 * question ; une action qui appelle un moyen engendre la sienne ; et l'entretien ne peut pas se terminer tant
 * qu'il en reste une. Le total annoncé au client GRANDIT donc à mesure qu'il cite des moments, ce qui est
 * honnête : il ne pouvait pas savoir combien il en aurait avant de les avoir dits.
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
 * La question du moyen, selon l'action choisie ET l'inventaire réel.
 *
 * 🔴 Elle MONTRE ce qui est branché plutôt que de demander au client de le deviner. Quand rien ne l'est, elle
 * le dit et propose les deux seules issues honnêtes : changer d'action, ou décrire ce qu'il faudra brancher.
 * Ne laisser aucune issue ferait un entretien qui ne peut plus se terminer.
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
    const declares = inv.mcp.length > 0 ? ` (vous avez déclaré ${enumerer(inv.mcp)}, mais rien ne peut encore l’appeler)` : '';
    return `MCP n’est PAS encore disponible sur cette console${declares}. Décrivez ce qu’il faudrait brancher, `
      + 'ou choisissez autre chose pour ce moment.';
  }
  return 'que doit-il faire exactement ?';
}

/** Ce qui reste à couvrir, dans l'ordre. Un point compte comme couvert s'il a été POSÉ **et** répondu. */
export function manquesDeCouverture(etat: EtatEntretien, inv: Inventaire = INVENTAIRE_VIDE): string[] {
  const poses = new Set(etat.poses);
  const repondus = new Set(retenues(etat.reponses).map((r) => r.point));
  const liste = bascules(etat);
  // Une question engendrée est « répondue » quand la bascule porte le champ correspondant : elle ne passe pas
  // par `reponses`, sinon la même information vivrait à deux endroits et finirait par diverger.
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
 * LE point de ce tour : le premier de l'ordre du jour effectif qui ne soit pas couvert. `null` = l'entretien
 * est fini, on peut montrer la proposition.
 *
 * C'est cette fonction, et elle seule, qui décide de quoi on parle. Le modèle ne vote pas.
 */
export function prochainPoint(etat: EtatEntretien, inv: Inventaire = INVENTAIRE_VIDE): Point | null {
  const manquants = manquesDeCouverture(etat, inv);
  return manquants.length === 0 ? null : parCode(etat, inv).get(manquants[0]!) ?? null;
}

/**
 * Le point OUVERT et celui qui le suit.
 *
 * Le second existe parce que le serveur choisit la question AVANT de lire la réponse du client : il ne peut
 * donc pas savoir que le message qu'on s'apprête à traiter répond justement au point ouvert. Donner les deux
 * laisse l'assistant enchaîner sans reposer une question déjà résolue, tout en lui interdisant de sauter plus
 * loin. Un seul point ferait piétiner l'entretien, la liste entière le laisserait le survoler.
 */
export function prochainsPoints(etat: EtatEntretien, inv: Inventaire = INVENTAIRE_VIDE): [Point | null, Point | null] {
  const manquants = manquesDeCouverture(etat, inv);
  const par = parCode(etat, inv);
  return [par.get(manquants[0] ?? '') ?? null, par.get(manquants[1] ?? '') ?? null];
}

/**
 * Fusionne les réponses d'un tour dans l'état. Une nouvelle réponse REMPLACE l'ancienne du même point : le
 * client a le droit de se raviser, et l'entretien doit suivre plutôt que garder sa première idée.
 */
export function fusionner(etat: readonly Reponse[], nouvelles: readonly Reponse[]): Reponse[] {
  const par = new Map(etat.map((r) => [r.point, r]));
  for (const r of retenues(nouvelles)) par.set(r.point, r);
  // Ordre de l'AGENDA, pas ordre d'arrivée : l'état se relit comme le questionnaire, en base comme au prompt.
  return AGENDA.map((p) => par.get(p.code)).filter((r): r is Reponse => r !== undefined);
}

/**
 * Fusionne les bascules d'un tour.
 *
 * 🔴 APPARIEMENT PAR MOMENT, ET AJOUT EN FIN. C'est ce qui rend les codes engendrés (`bascule_2_action`…)
 * stables d'un tour à l'autre : si la liste se réordonnait, un point noté POSÉ désignerait soudain une autre
 * bascule, et on reposerait une question déjà tranchée en croyant en poser une neuve.
 *
 * Un champ ABSENT d'une nouvelle version ne l'efface pas : le modèle rend souvent la bascule entière alors
 * qu'il n'a appris que son action, et effacer le reste ferait perdre un moyen déjà donné.
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
 * L'ordre du jour tel qu'il part dans le prompt, avec ce qui est déjà su.
 *
 * Le modèle reçoit la liste ENTIÈRE et les réponses déjà notées, pas seulement ce qui manque : il doit
 * pouvoir constater qu'une réponse déjà donnée rend la question suivante inutile à reposer telle quelle, et
 * revenir sur un point si la suite le contredit.
 */
export function ordreDuJour(etat: EtatEntretien, inv: Inventaire = INVENTAIRE_VIDE): string {
  const gardees = new Map(retenues(etat.reponses).map((r) => [r.point, r.valeur]));
  // Ce qu'on sait des points ENGENDRÉS ne vit pas dans `reponses` mais sur la bascule elle-même : on le
  // reprojette ici pour que le modèle voie l'ordre du jour d'un seul tenant.
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
      const etatDuPoint = su === undefined
        ? 'À POSER'
        : poses.has(p.code) ? 'couvert' : 'répondu d’avance, À FAIRE CONFIRMER';
      return `  ${p.code.padEnd(large)} [${etatDuPoint}] : ${p.aObtenir}${su ? ` -> « ${su} »` : ''}`;
    })
    .join('\n');
}

/** Les possibilités à montrer pour le point du tour, si on en a. */
export function pistesDe(point: Point): string {
  return point.pistes && point.pistes.length > 0 ? point.pistes.join(' | ') : '(aucune piste toute faite : fais-le parler)';
}

/**
 * 🔴 LE MESSAGE POSE-T-IL UNE QUESTION ?
 *
 * Test volontairement GROSSIER, et dans un seul sens : pas le moindre point d'interrogation, donc à coup sûr
 * aucune question. L'inverse n'est pas vrai (une question peut se formuler sans point d'interrogation), et
 * c'est très bien ainsi : ce test ne sert qu'à déclencher un REPLI, jamais à refuser un message. Un faux
 * négatif ajoute une question de trop ; un faux positif laisserait l'entretien mort, ce qu'on ne veut à aucun
 * prix.
 *
 * POURQUOI ÇA EXISTE. Le mandat bornait le MAXIMUM (« jamais plus d'une question à la fois ») et n'a jamais
 * posé de minimum. Julien, le 2026-08-31, en plein entretien : l'assistant a accusé réception de sa réponse
 * (« D'accord : les pages de description des véhicules seront importées ») et s'est arrêté là. L'entretien
 * cale, et le client n'a plus rien à quoi répondre. Une consigne de prompt seule est un vœu : celle-ci a un
 * mécanisme derrière.
 */
export function poseUneQuestion(message: string): boolean {
  return message.includes('?');
}
