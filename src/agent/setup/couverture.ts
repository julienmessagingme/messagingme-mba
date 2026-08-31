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
export const ACTIONS = ['outil', 'bloc_scenario', 'humain', 'continuer'] as const;
export type Action = (typeof ACTIONS)[number];

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
  /** Ce point n'entre à l'ordre du jour QUE si un autre point a livré cette action. C'est le creusement. */
  debloquePar?: { point: string; action: Action };
  /** Le modèle doit rendre une `action` typée pour ce point, pas seulement du texte. */
  attendUneAction?: true;
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
    aObtenir: 'D’OÙ viennent ses réponses de fond : une base de connaissance à remplir, des pages de son site '
      + 'à importer, un document qu’il va joindre, ou rien du tout (et alors l’agent transfère toute question de fond)',
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
    question: 'À quel moment doit-il faire autre chose que répondre, et que doit-il faire à ce moment-là ?',
    aObtenir: 'les moments où il doit faire autre chose que répondre, ET CE QU’IL FAIT à ce moment-là',
    pistes: ['appeler un outil', 'envoyer un bloc du scénario', 'passer la main à un humain', 'continuer simplement à répondre'],
    attendUneAction: true,
  },
  {
    // 🔴 LE CREUSEMENT. « L'agent le fait tout seul » n'est pas une réponse : c'est le début d'une question.
    code: 'quel_outil',
    question: 'Concrètement, par quel moyen l’agent fait-il cela tout seul ?',
    aObtenir: 'CONCRÈTEMENT, par quel moyen l’agent fait ce qu’il vient de dire qu’il ferait seul : quel outil '
      + 'du catalogue, ou quel connecteur déjà déclaré. Si rien de ce qui existe ne convient, dis-le clairement '
      + 'plutôt que d’inventer un outil : ce sera à câbler avant que l’agent puisse le faire',
    debloquePar: { point: 'bascules', action: 'outil' },
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
  /** Pour les points qui en attendent une (`bascules`) : ce que l'agent FAIT. C'est elle qui débloque un suivi. */
  action?: Action;
}

/** L'état de l'entretien, tel que le serveur le tient. */
export interface EtatEntretien {
  /** Les points DÉJÀ POSÉS au client. Un point jamais posé n'est jamais couvert, même répondu d'avance. */
  poses: string[];
  reponses: Reponse[];
}

/** Une réponse est retenue si elle porte un code connu et un contenu. Le reste vient d'un modèle, donc d'une
 *  source non fiable : inventer un code ne doit rien débloquer, et ne doit rien casser non plus. */
function retenues(reponses: readonly Reponse[]): Reponse[] {
  return reponses.filter((r) => PAR_CODE.has(r.point) && r.valeur.trim() !== '');
}

/**
 * L'ordre du jour EFFECTIF : les points de base, plus les suivis que les réponses déjà données ont ouverts.
 *
 * Un suivi non débloqué n'est pas « optionnel », il n'EXISTE pas : il ne compte ni dans le total affiché au
 * client, ni dans ce qui reste à faire. C'est ce qui permet d'annoncer honnêtement « encore deux points » à
 * un client dont l'agent n'appellera jamais d'outil.
 */
export function agendaEffectif(reponses: readonly Reponse[]): Point[] {
  const gardees = retenues(reponses);
  return AGENDA.filter((p) => {
    if (!p.debloquePar) return true;
    return gardees.some((r) => r.point === p.debloquePar!.point && r.action === p.debloquePar!.action);
  });
}

/** Ce qui reste à couvrir, dans l'ordre. Un point compte comme couvert s'il a été POSÉ **et** répondu. */
export function manquesDeCouverture(etat: EtatEntretien): string[] {
  const poses = new Set(etat.poses);
  const repondus = new Set(retenues(etat.reponses).map((r) => r.point));
  return agendaEffectif(etat.reponses)
    .filter((p) => !(poses.has(p.code) && repondus.has(p.code)))
    .map((p) => p.code);
}

/**
 * LE point de ce tour : le premier de l'ordre du jour effectif qui ne soit pas couvert. `null` = l'entretien
 * est fini, on peut montrer la proposition.
 *
 * C'est cette fonction, et elle seule, qui décide de quoi on parle. Le modèle ne vote pas.
 */
export function prochainPoint(etat: EtatEntretien): Point | null {
  const manquants = manquesDeCouverture(etat);
  return manquants.length === 0 ? null : PAR_CODE.get(manquants[0]!) ?? null;
}

/**
 * Le point OUVERT et celui qui le suit.
 *
 * Le second existe parce que le serveur choisit la question AVANT de lire la réponse du client : il ne peut
 * donc pas savoir que le message qu'on s'apprête à traiter répond justement au point ouvert. Donner les deux
 * laisse l'assistant enchaîner sans reposer une question déjà résolue, tout en lui interdisant de sauter plus
 * loin. Un seul point ferait piétiner l'entretien, la liste entière le laisserait le survoler.
 */
export function prochainsPoints(etat: EtatEntretien): [Point | null, Point | null] {
  const manquants = manquesDeCouverture(etat);
  return [PAR_CODE.get(manquants[0] ?? '') ?? null, PAR_CODE.get(manquants[1] ?? '') ?? null];
}

/**
 * Fusionne les réponses d'un tour dans l'état. Une nouvelle réponse REMPLACE l'ancienne du même point : le
 * client a le droit de se raviser, et l'entretien doit suivre plutôt que garder sa première idée.
 *
 * ⚠️ Se raviser peut REFERMER un suivi : passer `bascules` de « appeler un outil » à « continuer à répondre »
 * retire `quel_outil` de l'ordre du jour, et la réponse qu'on y avait déjà notée devient sans objet. On la
 * garde en base sans la compter (elle redeviendrait juste si le client revenait en arrière), et
 * `agendaEffectif` fait le tri : c'est lui la source de vérité, pas la liste des réponses.
 */
export function fusionner(etat: readonly Reponse[], nouvelles: readonly Reponse[]): Reponse[] {
  const par = new Map(etat.map((r) => [r.point, r]));
  for (const r of retenues(nouvelles)) par.set(r.point, r);
  // Ordre de l'AGENDA, pas ordre d'arrivée : l'état se relit comme le questionnaire, en base comme au prompt.
  return AGENDA.map((p) => par.get(p.code)).filter((r): r is Reponse => r !== undefined);
}

/**
 * L'ordre du jour tel qu'il part dans le prompt, avec ce qui est déjà su.
 *
 * Le modèle reçoit la liste ENTIÈRE et les réponses déjà notées, pas seulement ce qui manque : il doit
 * pouvoir constater qu'une réponse déjà donnée rend la question suivante inutile à reposer telle quelle, et
 * revenir sur un point si la suite le contredit.
 */
export function ordreDuJour(etat: EtatEntretien): string {
  const gardees = new Map(retenues(etat.reponses).map((r) => [r.point, r]));
  const poses = new Set(etat.poses);
  const effectif = agendaEffectif(etat.reponses);
  const large = Math.max(...effectif.map((p) => p.code.length));
  return effectif
    .map((p) => {
      const r = gardees.get(p.code);
      const etatDuPoint = r === undefined
        ? 'À POSER'
        : poses.has(p.code) ? 'couvert' : 'répondu d’avance, À FAIRE CONFIRMER';
      const su = r ? ` -> « ${r.valeur} »${r.action ? ` [${r.action}]` : ''}` : '';
      return `  ${p.code.padEnd(large)} [${etatDuPoint}] : ${p.aObtenir}${su}`;
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
