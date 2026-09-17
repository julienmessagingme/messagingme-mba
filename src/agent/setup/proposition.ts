import type { FrequenceMentionIa } from '../agent-store';
import { z } from 'zod';
import {
  BORNES_FICHE, CODE_SORTIE_RE, fichePatchSchema, MAX_SORTIES, normaliserCodeSortie,
  type FicheAgentContenu,
} from '../fiche';
import { OUTILS_MAISON } from '../outils-maison';
import { ACTIONS, CHOIX_ACTION, CODES_POINTS } from './couverture';

/**
 * Ce que l'IA de construction a le DROIT de proposer, et le diff qu'on montre au client.
 *
 * 🔴 CE SCHÉMA EST UNE FRONTIÈRE DE SÉCURITÉ, pas une commodité de parsing. L'IA de setup lit du contenu
 * tiers (le site du client, un jour les descriptions d'outils d'un serveur MCP) : un contenu hostile peut
 * l'orienter. Ce qu'elle peut écrire est donc énuméré ici, et rien d'autre ne passe :
 *
 *  - la FICHE (jsonb) : objectif, ton, identité, règles de transfert, règles d'arrêt ;
 *  - les OUTILS MAISON du catalogue, par leur handler, avec leurs MOTS ;
 *  - le BRANCHEMENT d'un outil de la bibliothèque de l'espace sur cet agent, par son nom (2026-09-15),
 *    c'est-à-dire le CONSENTEMENT du couple (outil, consommateur), jamais la définition de l'outil.
 *
 * Ce qu'elle ne peut PAS écrire, et la liste est aussi importante que la précédente : la mention légale
 * d'IA (AI Act, article 50), les plafonds de tours, d'appels et de dépense, le modèle de l'agent, le RISQUE
 * d'un outil, la CRÉATION d'un outil ou d'une source, et surtout son ACTIVATION. Compromettre la conversation de setup ne compromet donc pas
 * l'agent : au pire, elle propose des mots que le client voit passer dans un diff et refuse.
 *
 * ⚠️ Ces clés sont ABSENTES du schéma, elles ne sont pas « refusées » : `safeParse` d'un objet Zod sans
 * `.strict()` les ignore silencieusement, ce qui est exactement le comportement voulu ici. Un modèle qui
 * renvoie du bruit ne doit pas faire échouer tout un tour de conversation ; il doit juste ne rien obtenir.
 */

const HANDLERS = OUTILS_MAISON.map((o) => o.handler) as [string, ...string[]];

/**
 * LES BORNES, NOMMÉES UNE FOIS. Trois lecteurs en dépendent et devaient jusqu'ici s'accorder de mémoire :
 * le schéma Zod qui REFUSE, le schéma JSON qu'on ANNONCE au modèle, et l'assainissement qui RAMÈNE une
 * réponse dedans.
 *
 * 🔴 CE SONT LES TROIS QUI ONT DIVERGÉ, ET LE 2026-09-17 ON A MESURÉ L'ÉCART : 31 bornes sur 31 étaient
 * appliquées par Zod sans qu'AUCUNE ne soit annoncée au modèle. Un modèle parfaitement coopératif, qui
 * respectait chaque consigne écrite du mandat, voyait son tour refusé en 422 sur une règle qu'il n'avait
 * jamais reçue.
 *
 * ⚠️ `tests/agent-setup-bornes.test.ts` DÉRIVE la liste des bornes de Zod et exige que le schéma annoncé
 * les porte toutes : ce n'est plus une liste à tenir à la main. Le test de MIROIR voisin
 * (`agent-setup-proposition.test.ts`) ne pouvait pas voir l'écart, il ne compare que des noms de clés.
 */
export const BORNES_PROPOSITION = {
  message: 4000,
  /** Deux entrées par point de l'ordre du jour : de quoi corriger une réponse déjà donnée. */
  reponses: CODES_POINTS.length * 2,
  point: 64,
  valeur: 2000,
  bascules: 24,
  moment: 400,
  moyen: 2000,
  outils: OUTILS_MAISON.length,
  connecteurs: 20,
  /** Le nom exposé d'un connecteur, même alphabet que les noms d'outils. */
  nomConnecteur: 64,
  description: 2000,
  nePasUtiliser: 2000,
  branchements: 20,
} as const;

/**
 * Le NOM EXPOSÉ d'un outil, tel que la base l'impose (`agent_tools.name`, migration 0086).
 *
 * ⚠️ Construite depuis la borne ci-dessus plutôt qu'écrite en dur : un motif et une longueur qui se
 * contredisent est exactement le genre d'écart que ce fichier vient de payer. La même règle est écrite à la
 * main dans `src/http/agent-tools.ts` ; elle n'est pas importée d'ici, un module de schéma n'ayant pas à
 * dépendre d'un module de routes.
 */
const NOM_EXPOSE_RE = new RegExp(`^[a-z0-9_]{1,${BORNES_PROPOSITION.nomConnecteur}}$`);

/** Les mots d'un outil, ceux qui décident si le modèle l'appelle au bon moment. C'est là que se joue le
 *  gain mesuré par Guo et al. : ce sont ces deux textes qu'aucun client n'écrit correctement seul. */
const outilProposeSchema = z.object({
  /** Énumération FERMÉE sur le catalogue : le modèle ne peut pas inventer un comportement. */
  handler: z.enum(HANDLERS),
  description: z.string().trim().min(1).max(BORNES_PROPOSITION.description),
  nePasUtiliser: z.string().trim().max(BORNES_PROPOSITION.nePasUtiliser).default(''),
});

/**
 * Les MOTS d'un outil de CONNECTEUR déjà déclaré (lot L2, décision D-L2-4).
 *
 * 🔴 LA FRONTIÈRE NE BOUGE PAS D'UN POUCE. L'assistant peut réécrire les deux textes qui décident QUAND le
 * modèle appelle un connecteur ; il ne peut ni le créer, ni toucher à son adresse, à son secret, à son
 * gabarit de chemin, à ses paramètres, à son risque ou à son activation. Déclarer une source, c'est écrire
 * une adresse réseau et un secret : cela reste un geste d'administrateur.
 *
 * L'existence du `nom` n'est PAS vérifiable par ce schéma (il ne connaît pas les outils de cet agent) : elle
 * l'est à l'APPLICATION, qui ne patche qu'un outil existant et n'en crée jamais.
 */
const connecteurProposeSchema = z.object({
  nom: z.string().trim().regex(NOM_EXPOSE_RE),
  description: z.string().trim().min(1).max(BORNES_PROPOSITION.description),
  nePasUtiliser: z.string().trim().max(BORNES_PROPOSITION.nePasUtiliser).default(''),
});

export const propositionSchema = z.object({
  /** Ce que l'assistant dit au client, en clair. Toujours présent : une proposition sans explication est
   *  un diff que personne ne peut juger. */
  message: z.string().trim().min(1).max(BORNES_PROPOSITION.message),
  /**
   * 🔴 CE QUE LE CLIENT VIENT DE RÉPONDRE, rattaché aux points de l'ordre du jour. Ce n'est plus une
   * déclaration de couverture (« j'ai couvert le ton ») mais une EXTRACTION (« au point ton, il a dit ceci ») :
   * le serveur peut donc la relire, la garder, et décider lui-même de ce qui est couvert. C'est ce qui a fait
   * passer l'entretien d'un vœu à un mécanisme, cf. `couverture.ts`.
   *
   * ⚠️ Le `point` est une CHAÎNE LIBRE, pas une énumération, et c'est délibéré. Un code inventé ne doit rien
   * débloquer, mais il ne doit pas non plus faire échouer le tour : c'est la doctrine de ce fichier (« un
   * modèle qui renvoie du bruit doit juste n'obtenir rien »), et une énumération ici rendait 422 sur une
   * conversation par ailleurs parfaitement valide. Le tri se fait dans `couverture.ts`, qui ignore l'inconnu.
   */
  reponses: z.array(z.object({
    point: z.string().trim().max(BORNES_PROPOSITION.point),
    /** Vide = rien retenu pour ce point. Toléré plutôt que refusé : voir la doctrine ci-dessus. */
    valeur: z.string().trim().max(BORNES_PROPOSITION.valeur).default(''),
  })).max(BORNES_PROPOSITION.reponses).default([]),
  /**
   * 🔴 LES MOMENTS DE BASCULE, UN PAR UN. C'est une LISTE et pas un champ, parce qu'il y en a autant que le
   * client en cite. Le modèle précédent portait UNE action sur le point `bascules` : Julien en a donné deux
   * dans la même phrase (prendre un rendez-vous -> un outil ; donner l'adresse d'une concession -> un
   * scénario), et le second écrasait le premier en silence.
   *
   * ⚠️ `moment` est la CLÉ d'appariement. Le modèle doit le rendre à l'IDENTIQUE d'un tour à l'autre quand il
   * complète une bascule déjà connue, sinon il en crée une nouvelle au lieu de compléter l'ancienne.
   */
  bascules: z.array(z.object({
    moment: z.string().trim().min(1).max(BORNES_PROPOSITION.moment),
    action: z.enum(ACTIONS).optional(),
    moyen: z.string().trim().max(BORNES_PROPOSITION.moyen).optional(),
  })).max(BORNES_PROPOSITION.bascules).default([]),
  /** Les champs de fiche proposés. PARTIEL au sens strict : le modèle ne touche qu'à ce dont il parle, et
   *  les champs absents restent ABSENTS (voir `fichePatchSchema`, qui n'applique aucun défaut). */
  fiche: fichePatchSchema.optional(),
  /**
   * QUAND l'agent annonce qu'il est une IA (migration 0126, demande de Julien du 2026-09-09).
   *
   * 🔴 LE SEUL RÉGLAGE HORS FICHE QUE L'ASSISTANT PUISSE PROPOSER, et il est ici parce que l'entretien pose
   * désormais la question. Sans ce champ, on aurait interrogé le client pour ranger sa réponse nulle part :
   * c'est exactement l'incohérence contre laquelle Julien a prévenu (« il faut alors que le câblage derrière
   * soit cohérent »).
   *
   * ⚠️ Il reste une PROPOSITION, comme tout le reste : la route n'écrit rien, le client voit le diff et
   * applique. Une IA ne décide pas seule d'arrêter d'annoncer qu'elle est une IA.
   */
  mentionIaFrequence: z.enum(['jamais', 'session', 'chaque_message']).optional(),
  /**
   * COMBIEN DE MINUTES l'agent attend une réponse avant de lâcher (demande de Julien, 2026-09-11).
   *
   * 🔴 LE DEUXIÈME RÉGLAGE HORS FICHE, et il est ici pour la même raison que le premier : l'entretien pose
   * désormais la question (point `silence`). Sans ce champ, on interrogerait le client pour ranger sa
   * réponse nulle part, ce qui est l'incohérence exacte contre laquelle il avait prévenu.
   *
   * ⚠️ LES BORNES SONT CELLES DE LA BASE (1 à 1440), pas des valeurs choisies ici. La colonne porte le même
   * CHECK : accepter 5000 dans le schéma ferait remonter un 500 au moment d'appliquer, sur une proposition
   * que le client venait de valider.
   */
  inactiviteMinutes: z.number().int().min(1).max(1440).optional(),
  /** 🔴 HANDLERS UNIQUES, même exigence que les codes de sortie de la fiche. Deux entrées pour le même outil
   *  produiraient deux lignes de diff portant la MÊME clé, et l'application tenterait de créer deux fois le
   *  même outil : la seconde création se ferait refuser sur un nom déjà pris, en laissant la première. */
  outils: z.array(outilProposeSchema).max(BORNES_PROPOSITION.outils)
    .refine((o) => new Set(o.map((x) => x.handler)).size === o.length, 'un outil proposé deux fois')
    .optional(),
  /** Les MOTS d'un connecteur DÉJÀ déclaré. Même exigence d'unicité, et pour la même raison. */
  connecteurs: z.array(connecteurProposeSchema).max(BORNES_PROPOSITION.connecteurs)
    .refine((o) => new Set(o.map((x) => x.nom)).size === o.length, 'un connecteur proposé deux fois')
    .optional(),
  /**
   * BRANCHER ou DÉBRANCHER un outil de la bibliothèque de l'espace, par son NOM EXPOSÉ.
   *
   * 🔴 DES NOMS, ET RIEN QUE DES NOMS. Le schéma ne porte ni adresse, ni secret, ni gabarit de chemin, ni
   * risque, ni activation : brancher agit sur le CONSENTEMENT du couple (outil, consommateur), jamais sur la
   * définition. Un objet que le modèle enrichirait d'une `baseUrl` verrait ce champ tomber en silence, ce
   * qui est le comportement voulu de ce fichier.
   *
   * 🔴 ET BRANCHER N'ACTIVE PAS. Un outil rattaché est DISPONIBLE ; l'exposer au modèle reste un second
   * geste humain, celui que la migration 0086 rend incontournable. Les fondre ferait exposer au modèle un
   * outil dont personne n'a relu les mots.
   *
   * L'EXISTENCE du nom n'est pas vérifiable ici (le schéma ne connaît pas le catalogue) : elle l'est à
   * l'APPLICATION, qui ne branche qu'un outil existant et n'en crée jamais.
   */
  outilsBranches: z.array(z.string().trim().regex(NOM_EXPOSE_RE)).max(BORNES_PROPOSITION.branchements).optional(),
  outilsDebranches: z.array(z.string().trim().regex(NOM_EXPOSE_RE)).max(BORNES_PROPOSITION.branchements).optional(),
});

export type Proposition = z.infer<typeof propositionSchema>;

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Coupe une chaîne à sa borne, en place. Ne crée rien : une valeur absente ou d'un autre type ressort telle
 *  quelle, et c'est Zod qui la jugera. */
function couper(o: Record<string, unknown>, cle: string, max: number): void {
  const v = o[cle];
  if (typeof v === 'string') o[cle] = v.trim().slice(0, max);
}

/** Rend une COPIE bornée d'un tableau, ou la valeur telle quelle si ce n'en est pas un. */
function borner(v: unknown, max: number): unknown {
  return Array.isArray(v) ? v.slice(0, max) : v;
}

/**
 * Retire les clés posées à `undefined` par l'assainissement, c'est-à-dire celles que le modèle n'avait pas
 * écrites. Appelée à la RACINE et sur la FICHE : n'en faire qu'une des deux rendrait faux le commentaire qui
 * l'accompagne, et ce dépôt tient qu'une justification fausse est pire qu'aucune.
 */
function sansCleAjoutee(apres: Record<string, unknown>, avant: Record<string, unknown>): Record<string, unknown> {
  for (const cle of Object.keys(apres)) if (apres[cle] === undefined && !(cle in avant)) delete apres[cle];
  return apres;
}

/** Les entrées d'un tableau d'objets, nettoyées puis filtrées. Ce qui n'est pas un objet est écarté : Zod
 *  l'aurait de toute façon refusé, et le garder ferait tomber tout le tour pour une entrée. */
function entrees(v: unknown, max: number, soin: (e: Record<string, unknown>) => Record<string, unknown> | null): unknown {
  const tab = borner(v, max);
  if (!Array.isArray(tab)) return tab;
  return tab.flatMap((e) => {
    if (!estObjet(e)) return [];
    const propre = soin({ ...e });
    return propre ? [propre] : [];
  });
}

/**
 * RAMÈNE la réponse du modèle DANS les bornes, avant que Zod ne la juge.
 *
 * 🔴 CE QU'ELLE RÉPARE, ET CE N'EST PAS UN CONFORT (2026-09-17). Julien, au 9e point sur 10 de l'entretien :
 * « l'assistant a rendu une proposition hors format ». Ce tour-là est le PREMIER du temps 2, celui où le
 * mandat demande enfin d'écrire tous les champs : c'est donc le premier où les bornes s'exercent, et
 * n'importe laquelle d'entre elles faisait perdre le tour ENTIER, message du client compris (la route
 * n'écrit l'entretien qu'après une réponse valide). Mesuré le jour même : **31 bornes sur 31** étaient
 * appliquées par Zod sans qu'aucune ne soit annoncée au modèle. Un code de règle d'arrêt de 36 caractères,
 * parfaitement conforme à tout ce qu'on lui avait écrit, suffisait.
 *
 * 🔴 LA FRONTIÈRE DE SÉCURITÉ N'EST PAS CE QU'ON ASSAINIT, et la distinction décide de tout : la frontière,
 * c'est la LISTE DES CLÉS (ce que l'assistant a le droit de proposer) et les ÉNUMÉRATIONS FERMÉES (le
 * catalogue de handlers). Une longueur et un alphabet de slug sont de l'HYGIÈNE. Les avoir traités comme la
 * frontière est précisément ce qui a transformé un détail de forme en perte de tour. Donc : on coupe, on
 * normalise, on dédoublonne ; on ne touche JAMAIS à une énumération ni n'ajoute une clé, et Zod reste le
 * juge après coup.
 *
 * ⚠️ ELLE NE REND RIEN DE VALIDE, elle rend quelque chose de PLUS PROCHE du valide. Le `safeParse` qui suit
 * n'est pas décoratif : une réponse structurellement fausse (un handler hors catalogue, un `fiche` qui est
 * un tableau) doit toujours être refusée, et elle l'est.
 *
 * ⚠️ ELLE NE MUTE RIEN DE CE QU'ON LUI DONNE : le `brut` vient de `secure-json-parse`, et le journal du 422
 * doit pouvoir décrire ce que le modèle a VRAIMENT écrit.
 */
export function assainirProposition(brut: unknown): unknown {
  if (!estObjet(brut)) return brut;
  const p: Record<string, unknown> = { ...brut };

  couper(p, 'message', BORNES_PROPOSITION.message);

  p.reponses = entrees(p.reponses, BORNES_PROPOSITION.reponses, (r) => {
    couper(r, 'point', BORNES_PROPOSITION.point);
    couper(r, 'valeur', BORNES_PROPOSITION.valeur);
    return r;
  });

  // Une bascule sans moment n'est appariable à rien (le `moment` EST la clé) : elle part, elle ne fait pas
  // tomber les autres.
  p.bascules = entrees(p.bascules, BORNES_PROPOSITION.bascules, (b) => {
    couper(b, 'moment', BORNES_PROPOSITION.moment);
    couper(b, 'moyen', BORNES_PROPOSITION.moyen);
    return b.moment === '' ? null : b;
  });

  if (estObjet(p.fiche)) {
    const f: Record<string, unknown> = { ...p.fiche };
    for (const cle of ['nom', 'objectif', 'ton', 'personnalite', 'reglesTransfert'] as const) {
      couper(f, cle, BORNES_FICHE[cle]);
    }
    /**
     * 🔴 LE CODE D'UNE RÈGLE D'ARRÊT SE NORMALISE, IL NE SE REFUSE PLUS, et c'est la réparation d'une
     * asymétrie : le client qui TAPE un code le voit corrigé sous ses yeux (`AgentSorties.tsx`), quand
     * l'assistant qui PROPOSE le même code perdait tout son tour. Même fonction des deux côtés.
     *
     * ⚠️ On dédoublonne APRÈS avoir normalisé : deux libellés distincts peuvent se rejoindre une fois
     * tronqués à 32 caractères, et le doublon ferait échouer le `refine` d'unicité, donc le tour entier.
     * C'est déjà ce que fait la LECTURE (`agent-store.pg.ts`, qui écarte un doublon en silence).
     */
    const vus = new Set<string>();
    f.sorties = entrees(f.sorties, MAX_SORTIES, (s) => {
      if (typeof s.code === 'string') s.code = normaliserCodeSortie(s.code);
      couper(s, 'label', BORNES_FICHE.label);
      if (typeof s.code !== 'string' || !CODE_SORTIE_RE.test(s.code) || s.label === '') return null;
      if (vus.has(s.code)) return null;
      vus.add(s.code);
      return s;
    });
    /**
     * 🔴 UNE LISTE DONT PLUS RIEN NE SURVIT DISPARAÎT, ELLE NE DEVIENT PAS UNE LISTE VIDE, et c'est le seul
     * endroit où l'assainissement pouvait être DESTRUCTEUR. `fiche.sorties` est le seul champ que le patch
     * REMPLACE au lieu de fusionner : un modèle qui aurait rendu des sorties inexploitables (des chaînes au
     * lieu d'objets) produisait alors un diff « Règles d'arrêt : avant = les trois de l'agent, après = rien »,
     * c'est-à-dire une proposition d'EFFACEMENT fabriquée à partir de bruit, qu'il ne restait qu'à valider.
     * Relevé en revue le 2026-09-17, sur le correctif lui-même.
     *
     * ⚠️ VIDE À L'ENTRÉE RESTE VIDE À LA SORTIE : `sorties: []` est une proposition de retrait DÉLIBÉRÉE du
     * modèle, et la confondre avec du bruit lui retirerait un geste légitime. La différence n'est pas le
     * résultat, c'est ce qu'il y avait avant.
     */
    if (Array.isArray(f.sorties) && f.sorties.length === 0
      && Array.isArray((p.fiche as Record<string, unknown>).sorties)
      && ((p.fiche as Record<string, unknown>).sorties as unknown[]).length > 0) {
      delete f.sorties;
    }
    p.fiche = sansCleAjoutee(f, p.fiche);
  }

  // Un outil proposé deux fois produirait deux lignes de diff sous la même clé : on garde le premier, comme
  // le fait déjà la lecture du catalogue.
  const handlers = new Set<string>();
  p.outils = entrees(p.outils, BORNES_PROPOSITION.outils, (o) => {
    couper(o, 'description', BORNES_PROPOSITION.description);
    couper(o, 'nePasUtiliser', BORNES_PROPOSITION.nePasUtiliser);
    if (typeof o.handler !== 'string' || handlers.has(o.handler)) return null;
    handlers.add(o.handler);
    return o;
  });

  const noms = new Set<string>();
  p.connecteurs = entrees(p.connecteurs, BORNES_PROPOSITION.connecteurs, (c) => {
    couper(c, 'description', BORNES_PROPOSITION.description);
    couper(c, 'nePasUtiliser', BORNES_PROPOSITION.nePasUtiliser);
    if (typeof c.nom !== 'string' || noms.has(c.nom)) return null;
    noms.add(c.nom);
    return c;
  });

  p.outilsBranches = borner(p.outilsBranches, BORNES_PROPOSITION.branchements);
  p.outilsDebranches = borner(p.outilsDebranches, BORNES_PROPOSITION.branchements);

  /**
   * ⚠️ AUCUNE CLÉ AJOUTÉE : les affectations ci-dessus posent `undefined` là où le modèle n'avait rien
   * écrit, et on les retire. Ni Zod ni `differences` ne les distingueraient d'une absence (les deux lisent
   * `?? []` / `?? {}`), donc ce n'est PAS ce qui protège le diff : c'est pour que l'objet assaini garde la
   * FORME de ce que le modèle a écrit, seule chose qu'un lecteur du journal de refus puisse interpréter.
   */
  return sansCleAjoutee(p, brut);
}
export type OutilPropose = z.infer<typeof outilProposeSchema>;
export type ConnecteurPropose = z.infer<typeof connecteurProposeSchema>;

/** Nom de l'outil par lequel le modèle rend sa réponse. Forcé à l'appel : voir `toolChoice`. */
export const OUTIL_PROPOSER = 'proposer';

/**
 * 🔴 CE TEXTE A ÉTÉ INVERSÉ LE 2026-08-28, ET C'EST LE CORRECTIF LE PLUS COURT DE TOUT LE LOT.
 *
 * Il disait « Quand NE PAS l'appeler. Jamais vide. », et le champ était REQUIS. Un modèle à qui on impose de
 * remplir un champ sur un sujet dont personne n'a parlé le remplit quand même : d'où la clause que Julien a
 * relevée, « ne pas l'appeler si le client pose encore des questions sur les séjours », qui aurait empêché
 * l'agent d'agir précisément pendant qu'il fait son travail. On ne demande plus rien qui n'ait été dit.
 */
const NE_PAS_UTILISER = 'Quand NE PAS l’appeler. À remplir SEULEMENT si le client a nommé un cas où '
  + 'l’appel serait de trop. Sinon, laisse ce champ vide plutôt que d’en inventer un.';

/**
 * Le schéma envoyé au modèle, écrit À LA MAIN.
 *
 * Même raison qu'en tâche 15 : dériver un JSON Schema d'un schéma Zod produit du bruit
 * (`minimum: -9007199254740991` et consorts) qu'on paie à CHAQUE tour dans le prompt. Il est le miroir de
 * `propositionSchema` ci-dessus, et `tests/agent-setup-proposition.test.ts` casse si les deux divergent :
 * un champ présent ici et absent là serait promis au modèle puis jeté en silence, un champ présent là et
 * absent ici ne serait jamais rempli.
 */
export const SCHEMA_PROPOSITION = {
  type: 'object',
  properties: {
    message: { type: 'string', minLength: 1, maxLength: BORNES_PROPOSITION.message, description: 'Ce que tu dis au client, en français, bref.' },
    mentionIaFrequence: {
      type: 'string',
      enum: ['jamais', 'session', 'chaque_message'],
      description: 'QUAND les agents de cet ESPACE annoncent qu’ils sont des IA, et SEULEMENT si le client '
        + 'l’a tranché : jamais = ils ne l’annoncent pas ; session = une seule fois par conversation ; '
        + 'chaque_message = à chaque réponse. Ce choix vaut pour TOUS les agents de l’espace, pas seulement '
        + 'celui-ci. Ne le propose pas de toi-même : c’est la responsabilité de la marque, pas la tienne.',
    },
    inactiviteMinutes: {
      type: 'integer',
      minimum: 1,
      maximum: 1440,
      description: 'Combien de MINUTES l’agent attend une réponse du contact avant de lâcher la '
        + 'conversation, et SEULEMENT si le client l’a dit. Convertis ce qu’il dit en minutes '
        + '(« une demi-heure » = 30, « deux heures » = 120, « une journée » = 1440). Maximum 1440.',
    },
    bascules: {
      type: 'array',
      maxItems: BORNES_PROPOSITION.bascules,
      description: 'Les moments où l’agent doit faire autre chose que répondre, un par entrée. Reprends le '
        + '`moment` À L’IDENTIQUE quand tu complètes une bascule déjà citée, sinon tu en crées une nouvelle.',
      items: {
        type: 'object',
        properties: {
          moment: { type: 'string', minLength: 1, maxLength: BORNES_PROPOSITION.moment, description: 'Le moment, dans les mots du client. Ex. « le client veut prendre rendez-vous ».' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: `Ce que l’agent fait à ce moment-là, et SEULEMENT si le client l’a tranché : ${CHOIX_ACTION.map((c) => `${c.action} = ${c.libelle}`).join(' ; ')}.`,
          },
          moyen: { type: 'string', maxLength: BORNES_PROPOSITION.moyen, description: 'Le moyen concret (quel scénario, quel connecteur, quoi d’autre), si le client l’a dit.' },
        },
        required: ['moment'],
      },
    },
    reponses: {
      type: 'array',
      maxItems: BORNES_PROPOSITION.reponses,
      description: 'Ce que le client vient de DIRE, rattaché aux points de l’ordre du jour. N’y mets que ce '
        + 'qu’il a réellement exprimé dans son dernier message : un point que tu as seulement supposé n’en fait '
        + 'PAS partie. Tant qu’il manque une réponse, tes champs ne seront pas montrés au client.',
      items: {
        type: 'object',
        properties: {
          point: { type: 'string', enum: [...CODES_POINTS] },
          valeur: { type: 'string', maxLength: BORNES_PROPOSITION.valeur, description: 'Sa réponse, dans tes mots, en une phrase.' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: 'Pour un point de bascule UNIQUEMENT : ce que l’agent fait à ce moment-là. '
              + '« continuer » veut dire qu’il continue simplement à répondre, et c’est une réponse complète.',
          },
        },
        required: ['point', 'valeur'],
      },
    },
    fiche: {
      type: 'object',
      description: 'Les champs de la fiche que tu proposes de changer. N’y mets QUE ceux dont tu viens de parler.',
      properties: {
        nom: { type: 'string', maxLength: BORNES_FICHE.nom, description: 'Le nom que l’agent se donne au contact. Vide, il n’en donne aucun.' },
        objectif: { type: 'string', maxLength: BORNES_FICHE.objectif, description: 'Ce que l’agent est là pour faire, au-delà de répondre.' },
        ton: { type: 'string', maxLength: BORNES_FICHE.ton, description: 'Vouvoiement, longueur des phrases, emoji ou non.' },
        personnalite: { type: 'string', maxLength: BORNES_FICHE.personnalite, description: 'Les quelques traits qui le caractérisent.' },
        reglesTransfert: { type: 'string', maxLength: BORNES_FICHE.reglesTransfert, description: 'Quand il passe la main à un humain, en français.' },
        sorties: {
          type: 'array',
          maxItems: MAX_SORTIES,
          description: 'Les aboutissements de la conversation. Chacun devient une sortie du bloc dans le scénario.',
          items: {
            type: 'object',
            properties: {
              code: {
                type: 'string',
                maxLength: BORNES_FICHE.code,
                pattern: CODE_SORTIE_RE.source,
                description: `minuscules, chiffres et tirets bas ; commence et finit par une lettre ou un chiffre ; ${BORNES_FICHE.code} caractères au plus`,
              },
              label: { type: 'string', minLength: 1, maxLength: BORNES_FICHE.label, description: 'ce que ça veut dire, en clair' },
            },
            required: ['code', 'label'],
          },
        },
      },
    },
    connecteurs: {
      type: 'array',
      maxItems: BORNES_PROPOSITION.connecteurs,
      description: 'Les connecteurs DÉJÀ déclarés dont tu proposes de réécrire les mots. Tu ne peux pas en créer.',
      items: {
        type: 'object',
        properties: {
          nom: { type: 'string', pattern: NOM_EXPOSE_RE.source, description: 'le nom exact du connecteur déjà déclaré' },
          description: { type: 'string', minLength: 1, maxLength: BORNES_PROPOSITION.description, description: 'Quand l’appeler, avec un exemple de tournure du client.' },
          nePasUtiliser: { type: 'string', maxLength: BORNES_PROPOSITION.nePasUtiliser, description: NE_PAS_UTILISER },
        },
        required: ['nom', 'description'],
      },
    },
    outilsBranches: {
      type: 'array',
      maxItems: BORNES_PROPOSITION.branchements,
      items: { type: 'string', pattern: NOM_EXPOSE_RE.source },
      description: 'Les NOMS EXACTS d’outils de la bibliothèque de l’espace à BRANCHER sur cet agent. '
        + 'Uniquement ceux de la liste qu’on te montre : tu ne peux pas en créer, et un nom qui n’y figure '
        + 'pas sera refusé. Brancher rend l’outil disponible ; l’ACTIVER reste un geste du client.',
    },
    outilsDebranches: {
      type: 'array',
      maxItems: BORNES_PROPOSITION.branchements,
      items: { type: 'string', pattern: NOM_EXPOSE_RE.source },
      description: 'Les NOMS EXACTS d’outils de la bibliothèque à DÉBRANCHER de cet agent. La définition '
        + 'reste dans l’espace et sur les autres agents : tu ne supprimes rien.',
    },
    outils: {
      type: 'array',
      maxItems: BORNES_PROPOSITION.outils,
      description: 'Les outils du catalogue que tu proposes, avec leurs mots.',
      items: {
        type: 'object',
        properties: {
          handler: { type: 'string', enum: [...HANDLERS] },
          description: { type: 'string', minLength: 1, maxLength: BORNES_PROPOSITION.description, description: 'Quand l’appeler, en une à trois phrases, avec un exemple de tournure du client.' },
          nePasUtiliser: { type: 'string', maxLength: BORNES_PROPOSITION.nePasUtiliser, description: NE_PAS_UTILISER },
        },
        required: ['handler', 'description'],
      },
    },
  },
  required: ['message'],
} as const;

/** Un changement, tel que l'écran le montre. `avant` est ce qui est en base AUJOURD'HUI. */
export interface Changement {
  /** Clé technique, celle que le `PATCH` écrira (`fiche.objectif`, `outil.poser_tag.description`). */
  champ: string;
  /** Libellé lisible, pour l'écran. Le front ne recompose pas un nom à partir de la clé. */
  label: string;
  avant: string;
  apres: string;
}

/** L'état courant contre lequel le diff se calcule. */
/** Un outil de la BIBLIOTHÈQUE de l'espace, et si CET agent y est branché. */
export interface OutilDuCatalogue {
  nom: string;
  titre: string;
  branche: boolean;
}

export interface EtatCourant {
  fiche: FicheAgentContenu;
  /**
   * Le régime d'annonce d'IA ACTUEL, pour que le diff dise ce qui change.
   *
   * ⚠️ C'est celui de l'ESPACE depuis la migration 0140, plus celui de la fiche : la question posée à la
   * construction règle la politique de la marque, pas celle de ce robot-là.
   */
  mentionIaFrequence: FrequenceMentionIa;
  /** Le délai d'inactivité ACTUEL, en minutes, pour la même raison. */
  inactiviteMinutes: number;
  /** Les outils DÉJÀ posés sur l'agent, par handler, avec leurs mots actuels. */
  outils: Array<{ handler: string; description: string; nePasUtiliser: string }>;
  /** Les CONNECTEURS déjà déclarés par un administrateur, par leur nom exposé. L'assistant ne peut proposer
   *  que leurs mots, et seulement pour ceux-là : il n'en invente pas. */
  /**
   * ⚠️ `origine` EST REQUISE, et c'est ce qui empêche les deux familles de se confondre. Cette liste est
   * construite sur `origin !== 'mba'`, donc elle porte les connecteurs API ET les outils MCP ; sans elle,
   * `inventaireDe` les versait tous dans `outilsApi` et l'assistant annonçait un outil MCP comme un
   * connecteur API.
   */
  connecteurs?: Array<{
    nom: string; titre: string; description: string; nePasUtiliser: string;
    origine: 'http' | 'mcp';
    /**
     * ⚠️ REQUIS, ET C'EST LUI QUI APPARIE UN OUTIL À SON SERVEUR. Le rapprochement se faisait d'abord sur le
     * PRÉFIXE du nom exposé, que le client peut réécrire à l'écran et qui se tronque à 64 caractères : un
     * outil renommé, deux libellés qui se normalisent pareil, ou un libellé long faisaient alors dire à la
     * question de l'assistant deux choses contraires dans la même phrase. `null` pour un outil maison.
     */
    sourceId: string | null;
  }>;
  /**
   * LA BIBLIOTHÈQUE DE L'ESPACE (migration 0127), avec l'état de branchement de CET agent.
   *
   * 🔴 C'EST CE QUI REND LE BRANCHEMENT PROPOSABLE SANS RIEN CRÉER. Julien, 2026-09-14 : « il n'a pas la
   * main pour créer des outils puisqu'il n'a que la liste d'outils déjà setuppés, donc au pire il en
   * débranche un ». La définition appartient à l'ESPACE, le consentement au couple (outil, consommateur) :
   * l'assistant n'agit que sur le second.
   */
  catalogue?: OutilDuCatalogue[];
}

const LABELS_FICHE: Record<string, string> = {
  nom: 'Nom donné au contact',
  objectif: 'Objectif de l’agent',
  ton: 'Ton',
  personnalite: 'Personnalité',
  reglesTransfert: 'Quand passer la main à un humain',
  sorties: 'Règles d’arrêt',
};

/** Les règles d'arrêt, rendues lisibles pour la comparaison ET pour l'écran : c'est la même chaîne. */
function texteSorties(sorties: FicheAgentContenu['sorties']): string {
  return sorties.map((s) => `${s.code} : ${s.label}`).join('\n');
}

/**
 * Le diff, calculé sur l'état COURANT.
 *
 * 🔴 Ne rend QUE ce qui change vraiment. Un modèle qui recopie l'objectif à l'identique ne doit pas
 * produire une ligne de diff : le client apprendrait à cliquer « Garder » sans lire, et c'est précisément
 * l'habitude que ce diff existe pour empêcher. C'est aussi ce qui fait qu'une proposition sans effet rend
 * une liste vide, donc un écran qui dit « rien à changer » plutôt qu'un bouton qui n'aurait rien fait.
 */
// `reponses` et `bascules` sont l'état de l'ENTRETIEN, pas une proposition d'écriture : le diff ne les
// regarde pas, et les exclure du type le dit plutôt que de compter sur la discipline de l'appelant.
/** Le régime, dit en français : ce diff est lu par un humain qui tranche une question légale. */
export const LIBELLES_MENTION: Record<string, string> = {
  jamais: 'jamais',
  session: 'une fois par conversation',
  chaque_message: 'à chaque message',
};

/**
 * Un nombre de minutes, dit comme on le dirait à voix haute.
 *
 * ⚠️ `1440` ne se lit pas, et c'est un diff qu'un humain doit JUGER : lui montrer le nombre nu reviendrait à
 * lui demander de faire la division lui-même, donc à l'inviter à cliquer « Garder » sans lire.
 */
export function dureeEnClair(minutes: number): string {
  if (minutes % 1440 === 0) return minutes === 1440 ? '24 heures' : `${minutes / 1440} jours`;
  if (minutes % 60 === 0) return minutes === 60 ? '1 heure' : `${minutes / 60} heures`;
  return `${minutes} minutes`;
}

export function differences(courant: EtatCourant, proposition: Omit<Proposition, 'reponses' | 'bascules'>): Changement[] {
  const out: Changement[] = [];

  for (const [cle, valeur] of Object.entries(proposition.fiche ?? {})) {
    if (valeur === undefined) continue;
    const label = LABELS_FICHE[cle] ?? cle;
    if (cle === 'sorties') {
      const apres = texteSorties(valeur as FicheAgentContenu['sorties']);
      const avant = texteSorties(courant.fiche.sorties);
      if (apres !== avant) out.push({ champ: 'fiche.sorties', label, avant, apres });
      continue;
    }
    const apres = String(valeur);
    const avant = String(courant.fiche[cle as keyof FicheAgentContenu] ?? '');
    if (apres !== avant) out.push({ champ: `fiche.${cle}`, label, avant, apres });
  }

  // Le régime d'annonce d'IA : hors fiche, donc traité à part. Libellé en toutes lettres plutôt que le code,
  // parce que ce diff est lu par un humain qui décide d'une question légale, pas par un développeur.
  // ⚠️ LE LIBELLÉ DIT « pour tout l'espace » DEPUIS 0140. Le réglage a quitté la fiche de l'agent : laisser
  // le diff parler comme s'il ne touchait que celui-ci ferait valider un changement plus large que ce qui
  // est montré, sur la seule ligne de la construction qui engage juridiquement la marque.
  if (proposition.mentionIaFrequence !== undefined && proposition.mentionIaFrequence !== courant.mentionIaFrequence) {
    out.push({
      champ: 'mentionIaFrequence',
      label: 'Annonce « je suis une IA » (pour tout l’espace)',
      avant: LIBELLES_MENTION[courant.mentionIaFrequence] ?? courant.mentionIaFrequence,
      apres: LIBELLES_MENTION[proposition.mentionIaFrequence] ?? proposition.mentionIaFrequence,
    });
  }

  // Le délai d'inactivité : hors fiche lui aussi. Dit en toutes lettres plutôt qu'en nombre nu, parce que
  // « 1440 » ne se lit pas et que c'est la seule ligne du diff que le client doit pouvoir juger d'un coup.
  if (proposition.inactiviteMinutes !== undefined && proposition.inactiviteMinutes !== courant.inactiviteMinutes) {
    out.push({
      champ: 'inactiviteMinutes',
      label: 'Silence du contact : quand l’agent lâche',
      avant: dureeEnClair(courant.inactiviteMinutes),
      apres: dureeEnClair(proposition.inactiviteMinutes),
    });
  }

  /**
   * LE BRANCHEMENT, une ligne par outil, et SEULEMENT quand l'état change vraiment.
   *
   * 🔴 UN NOM ABSENT DU CATALOGUE NE PRODUIT AUCUNE LIGNE. Le schéma ne peut pas vérifier l'existence (il
   * ne connaît pas la bibliothèque) : c'est ici que ça se joue, et une ligne de diff sur un outil
   * inexistant promettrait au client un branchement que l'application ne pourrait pas faire.
   *
   * ⚠️ LE LIBELLÉ DIT « disponible », PAS « activé ». Brancher rattache ; exposer l'outil au modèle reste un
   * second geste humain (migration 0086). Un diff qui dirait « activé » ferait croire l'inverse.
   */
  const catalogue = courant.catalogue ?? [];
  for (const nom of proposition.outilsBranches ?? []) {
    const outil = catalogue.find((c) => c.nom === nom);
    if (!outil || outil.branche) continue;
    out.push({
      champ: `outil.${nom}.rattachement`,
      label: `${outil.titre} : brancher sur cet agent`,
      avant: 'non branché',
      apres: 'branché (disponible, à activer ensuite)',
    });
  }
  for (const nom of proposition.outilsDebranches ?? []) {
    const outil = catalogue.find((c) => c.nom === nom);
    if (!outil || !outil.branche) continue;
    out.push({
      champ: `outil.${nom}.rattachement`,
      label: `${outil.titre} : débrancher de cet agent`,
      avant: 'branché',
      // ⚠️ On le DIT : la définition reste dans l'espace et sur les autres agents. Sans cette phrase, le
      // client croirait supprimer un outil qu'un autre agent utilise peut-être.
      apres: 'non branché (la définition reste dans votre bibliothèque)',
    });
  }

  for (const o of proposition.outils ?? []) {
    const modele = OUTILS_MAISON.find((m) => m.handler === o.handler);
    const deja = courant.outils.find((x) => x.handler === o.handler);
    const nom = modele?.titre.fr ?? o.handler;
    // Un outil ABSENT est une proposition d'ajout : on le dit, sinon le client verrait un diff de
    // description sans comprendre qu'il crée aussi l'outil.
    const prefixe = deja ? nom : `${nom} (à ajouter)`;
    if ((deja?.description ?? '') !== o.description) {
      out.push({
        champ: `outil.${o.handler}.description`,
        label: `${prefixe} : quand l’appeler`,
        avant: deja?.description ?? '',
        apres: o.description,
      });
    }
    if ((deja?.nePasUtiliser ?? '') !== o.nePasUtiliser) {
      out.push({
        champ: `outil.${o.handler}.nePasUtiliser`,
        label: `${prefixe} : quand NE PAS l’appeler`,
        avant: deja?.nePasUtiliser ?? '',
        apres: o.nePasUtiliser,
      });
    }
  }

  // Les CONNECTEURS : seulement ceux qui EXISTENT. Un nom inconnu est ignoré en silence, comme tout ce qui
  // n'est pas au schéma : l'assistant n'obtient rien, et la conversation n'échoue pas pour autant.
  for (const c of proposition.connecteurs ?? []) {
    const deja = (courant.connecteurs ?? []).find((x) => x.nom === c.nom);
    if (!deja) continue;
    if (deja.description !== c.description) {
      out.push({
        champ: `connecteur.${c.nom}.description`,
        label: `${deja.titre} : quand l’appeler`,
        avant: deja.description,
        apres: c.description,
      });
    }
    if (deja.nePasUtiliser !== c.nePasUtiliser) {
      out.push({
        champ: `connecteur.${c.nom}.nePasUtiliser`,
        label: `${deja.titre} : quand NE PAS l’appeler`,
        avant: deja.nePasUtiliser,
        apres: c.nePasUtiliser,
      });
    }
  }

  return out;
}
