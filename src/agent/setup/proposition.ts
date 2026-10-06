import type { FrequenceMentionIa } from '../agent-store';
import { z } from 'zod';
import {
  BORNES_FICHE, CODE_SORTIE_RE, fichePatchSchema, MAX_SORTIES, normaliserCodeSortie,
  type FicheAgentContenu,
} from '../fiche';
import { OUTILS_MAISON, exigeUneCible } from '../outils-maison';
import { ACTIONS, CHOIX_ACTION, CODES_POINTS } from './couverture';

/**
 * Ce que l'IA de construction a le droit de proposer, et le diff qu'on montre au client.
 *
 * 🔴 Ce schéma est une frontière de sécurité : l'IA de construction lit du contenu tiers qui peut l'orienter.
 * Elle peut écrire la fiche (jsonb), les mots des outils maison du catalogue, et le branchement d'un outil de
 * la bibliothèque (le consentement, jamais la définition). Elle ne peut écrire ni la mention légale d'IA, ni
 * les plafonds, ni le modèle, ni le risque d'un outil, ni créer un outil ou une source, ni activer. Au pire,
 * elle propose des mots que le client refuse dans le diff. Les clés absentes du schéma sont ignorées sans
 * erreur (`safeParse` sans `.strict()`) : du bruit ne fait pas échouer le tour, il n'obtient rien.
 */

/**
 * 🔴 LES OUTILS QUE L'ASSISTANT PEUT PROPOSER : ceux du catalogue SANS cible (RC4). Un tag, un champ, un bloc ou un
 * scénario se fixent à l'écran, dans des listes (tags, champs du mini-CRM, scénarios publiés) que l'assistant ne voit
 * pas : il en inventerait l'identifiant, et un outil posé sans cible refuserait chaque appel. Le schéma annoncé et le
 * schéma appliqué lisent cette même liste ; `assainirProposition` retire un outil à cible proposé quand même.
 */
export const OUTILS_PROPOSABLES = OUTILS_MAISON.filter((o) => !exigeUneCible(o.handler));
const HANDLERS = OUTILS_PROPOSABLES.map((o) => o.handler) as [string, ...string[]];

/**
 * Les bornes, nommées une fois, pour le schéma Zod qui refuse, le schéma JSON annoncé au modèle, et
 * l'assainissement qui ramène une réponse dedans : une borne appliquée sans être annoncée fait refuser un
 * modèle coopératif. `tests/agent-setup-bornes.test.ts` dérive les bornes de Zod et exige que le schéma
 * annoncé les porte toutes.
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
  outils: OUTILS_PROPOSABLES.length,
  connecteurs: 20,
  /** Le nom exposé d'un connecteur, même alphabet que les noms d'outils. */
  nomConnecteur: 64,
  description: 2000,
  nePasUtiliser: 2000,
  branchements: 20,
  /** L'adresse du site dont le client dit que viennent ses réponses de fond. */
  connaissanceUrl: 2000,
} as const;

/**
 * Le nom exposé d'un outil, tel que la base l'impose (`agent_tools.name`), construit depuis la borne pour que
 * motif et longueur ne se contredisent pas. La même règle est écrite dans `src/http/agent-tools.ts` (un
 * module de schéma ne dépend pas d'un module de routes).
 */
const NOM_EXPOSE_RE = new RegExp(`^[a-z0-9_]{1,${BORNES_PROPOSITION.nomConnecteur}}$`);

/**
 * 🔴 `http` et `https` seulement : cette adresse est écrite par le modèle, qui lit du contenu tiers, et
 * s'affiche au client ; un `javascript:` ou un `data:` y mettrait une charge active. L'import refait ses
 * propres contrôles (`urlRecuperable`, `resolutionPublique`).
 *
 * Un littéral, pas un `new RegExp` par gabarit : dans un gabarit, le backslash de `\s` disparaît et la classe
 * devient « tout sauf la lettre s ». La longueur est tenue par `.max()`, pas par le motif.
 */
const URL_PUBLIQUE_RE = /^https?:\/\/[^\s<>"']+$/;

/** Les mots d'un outil, ceux qui décident si le modèle l'appelle au bon moment : ce sont ces deux textes
 *  qu'aucun client n'écrit correctement seul. */
const outilProposeSchema = z.object({
  /** Énumération fermée sur le catalogue : le modèle ne peut pas inventer un comportement. */
  handler: z.enum(HANDLERS),
  description: z.string().trim().min(1).max(BORNES_PROPOSITION.description),
  nePasUtiliser: z.string().trim().max(BORNES_PROPOSITION.nePasUtiliser).default(''),
});

/**
 * Les mots d'un outil de connecteur déjà déclaré : l'assistant peut réécrire les deux textes qui décident
 * quand le modèle l'appelle, rien d'autre (ni adresse, ni secret, ni chemin, ni paramètres, ni risque, ni
 * activation). L'existence du `nom` est vérifiée à l'application, qui ne patche qu'un outil existant.
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
   * Ce que le client vient de répondre, rattaché aux points de l'ordre du jour : une extraction que le
   * serveur relit pour décider lui-même de la couverture (`couverture.ts`). `point` est une chaîne libre, pas
   * une énumération : un code inventé ne débloque rien, mais ne fait pas échouer le tour (422) non plus.
   */
  reponses: z.array(z.object({
    point: z.string().trim().max(BORNES_PROPOSITION.point),
    /** Vide = rien retenu pour ce point. Toléré plutôt que refusé. */
    valeur: z.string().trim().max(BORNES_PROPOSITION.valeur).default(''),
  })).max(BORNES_PROPOSITION.reponses).default([]),
  /**
   * Les moments de bascule, une liste : autant de moments que le client en cite. `moment` est la clé
   * d'appariement, à rendre à l'identique d'un tour à l'autre, sinon le modèle crée une bascule au lieu de
   * compléter l'ancienne.
   */
  bascules: z.array(z.object({
    moment: z.string().trim().min(1).max(BORNES_PROPOSITION.moment),
    action: z.enum(ACTIONS).optional(),
    moyen: z.string().trim().max(BORNES_PROPOSITION.moyen).optional(),
  })).max(BORNES_PROPOSITION.bascules).default([]),
  /** Les champs de fiche proposés, partiels au sens strict : les champs absents restent absents
   *  (`fichePatchSchema` n'applique aucun défaut). */
  fiche: fichePatchSchema.optional(),
  /**
   * Quand l'agent annonce qu'il est une IA : réglage hors fiche, proposable parce que l'entretien pose la
   * question. Une proposition, comme le reste : le client voit le diff et applique. Une IA ne décide pas
   * seule d'arrêter d'annoncer qu'elle est une IA.
   */
  mentionIaFrequence: z.enum(['jamais', 'session', 'chaque_message']).optional(),
  /**
   * Combien de minutes l'agent attend une réponse avant de lâcher (point `silence`). Bornes de la base (1 à
   * 1440, même CHECK sur la colonne) : accepter plus ferait un 500 au moment d'appliquer.
   */
  inactiviteMinutes: z.number().int().min(1).max(1440).optional(),
  /** Handlers uniques, comme les codes de sortie : deux entrées pour le même outil feraient deux lignes de
   *  diff sous la même clé, et une seconde création refusée. */
  outils: z.array(outilProposeSchema).max(BORNES_PROPOSITION.outils)
    .refine((o) => new Set(o.map((x) => x.handler)).size === o.length, 'un outil proposé deux fois')
    .optional(),
  /** Les mots d'un connecteur déjà déclaré. Même exigence d'unicité. */
  connecteurs: z.array(connecteurProposeSchema).max(BORNES_PROPOSITION.connecteurs)
    .refine((o) => new Set(o.map((x) => x.nom)).size === o.length, 'un connecteur proposé deux fois')
    .optional(),
  /**
   * `outilsBranches` et `outilsDebranches` : des noms d'outils de la bibliothèque, rien d'autre. Brancher agit
   * sur le consentement (outil, consommateur), jamais sur la définition, et n'active pas : exposer l'outil au
   * modèle reste un geste humain. L'existence du nom est vérifiée à l'application.
   */
  /**
   * L'adresse du site dont viennent les réponses de fond. Mémorisée, et proposée pré-remplie par l'onglet
   * Base de connaissance ; aucune ligne de diff : « Enregistrer » écrit des champs, et ne doit pas faire
   * valider un crawl de cinquante pages que le client n'a pas vues.
   */
  connaissanceUrl: z.string().trim().regex(URL_PUBLIQUE_RE).max(BORNES_PROPOSITION.connaissanceUrl).optional(),
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

/** Rend une copie bornée d'un tableau, ou la valeur telle quelle si ce n'en est pas un. */
function borner(v: unknown, max: number): unknown {
  return Array.isArray(v) ? v.slice(0, max) : v;
}

/** Retire les clés posées à `undefined` par l'assainissement, celles que le modèle n'avait pas écrites.
 *  Appelée à la racine et sur la fiche. */
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
 * Ramène la réponse du modèle dans les bornes, avant que Zod ne la juge : une borne dépassée (un code de
 * règle d'arrêt trop long) faisait perdre le tour entier, message du client compris.
 *
 * La frontière de sécurité n'est pas ce qu'on assainit : c'est la liste des clés et les énumérations
 * fermées. Une longueur ou un alphabet de slug sont de l'hygiène. On coupe, on normalise, on dédoublonne ;
 * on ne touche jamais à une énumération ni n'ajoute une clé, et Zod juge ensuite (une réponse
 * structurellement fausse reste refusée). Ne mute rien de l'entrée : le journal du 422 doit décrire ce que
 * le modèle a vraiment écrit.
 */
export function assainirProposition(brut: unknown): unknown {
  if (!estObjet(brut)) return brut;
  const p: Record<string, unknown> = { ...brut };

  couper(p, 'message', BORNES_PROPOSITION.message);
  couper(p, 'connaissanceUrl', BORNES_PROPOSITION.connaissanceUrl);

  p.reponses = entrees(p.reponses, BORNES_PROPOSITION.reponses, (r) => {
    couper(r, 'point', BORNES_PROPOSITION.point);
    couper(r, 'valeur', BORNES_PROPOSITION.valeur);
    return r;
  });

  // Une bascule sans moment n'est appariable à rien : elle part, sans faire tomber les autres.
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
     * Le code d'une règle d'arrêt se normalise au lieu d'être refusé, comme pour le client qui le tape
     * (même fonction). Dédoublonné après normalisation : deux libellés tronqués peuvent se rejoindre, et le
     * doublon ferait échouer le `refine` d'unicité.
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
     * 🔴 Une liste dont plus rien ne survit disparaît au lieu de devenir vide : `fiche.sorties` est remplacé, pas
     * fusionné, et du bruit deviendrait une proposition d'effacement de toutes les règles d'arrêt. Une liste
     * vide à l'entrée reste vide : c'est un retrait délibéré.
     */
    if (Array.isArray(f.sorties) && f.sorties.length === 0
      && Array.isArray((p.fiche as Record<string, unknown>).sorties)
      && ((p.fiche as Record<string, unknown>).sorties as unknown[]).length > 0) {
      delete f.sorties;
    }
    p.fiche = sansCleAjoutee(f, p.fiche);
  }

  // Un outil proposé deux fois ferait deux lignes de diff sous la même clé : on garde le premier. Un outil À CIBLE du
  // catalogue (RC4) est retiré, jamais posé sans sa cible : l'assistant ne peut pas la connaître. Retiré AVANT la borne
  // de longueur, qui ne compte que les proposables. Un handler inconnu reste, et Zod le refuse : c'est la frontière.
  const handlers = new Set<string>();
  const sansCible = Array.isArray(p.outils)
    ? p.outils.filter((o) => !(estObjet(o) && typeof o.handler === 'string' && exigeUneCible(o.handler)))
    : p.outils;
  p.outils = entrees(sansCible, BORNES_PROPOSITION.outils, (o) => {
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
   * Aucune clé ajoutée : les affectations ci-dessus posent `undefined` là où le modèle n'avait rien écrit.
   * Pour que l'objet assaini garde la forme de ce que le modèle a écrit, lisible dans le journal de refus.
   */
  return sansCleAjoutee(p, brut);
}

/** Nom de l'outil par lequel le modèle rend sa réponse. Forcé à l'appel : voir `toolChoice`. */
export const OUTIL_PROPOSER = 'proposer';

/** La clause « ne pas utiliser » ne se remplit que si le client a nommé un cas : un champ requis sur un
 *  sujet dont personne n'a parlé serait rempli quand même, par une clause inventée. */
const NE_PAS_UTILISER = 'Quand NE PAS l’appeler. À remplir SEULEMENT si le client a nommé un cas où '
  + 'l’appel serait de trop. Sinon, laisse ce champ vide plutôt que d’en inventer un.';

/**
 * Le schéma envoyé au modèle, écrit à la main : dériver un JSON Schema de Zod ajoute du bruit
 * (`minimum: -9007199254740991`) payé à chaque tour. Miroir de `propositionSchema`,
 * `tests/agent-setup-proposition.test.ts` casse si les deux divergent.
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
    connaissanceUrl: {
      type: 'string',
      pattern: URL_PUBLIQUE_RE.source,
      maxLength: BORNES_PROPOSITION.connaissanceUrl,
      description: 'L’adresse EXACTE du site d’où viennent ses réponses de fond, et SEULEMENT s’il l’a '
        + 'donnée. Commence par http:// ou https://. Ne l’invente jamais : sans adresse, tu la demandes.',
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
      description: 'Les outils du catalogue que tu proposes, avec leurs mots. Poser un tag précis, enregistrer une '
        + 'information, envoyer un bloc et lancer un scénario n’en font pas partie : ils se posent à l’écran, avec ce '
        + 'qu’ils visent.',
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

/** Un changement, tel que l'écran le montre. `avant` est ce qui est en base aujourd'hui. */
export interface Changement {
  /** Clé technique, celle que le `PATCH` écrira (`fiche.objectif`, `outil.poser_tag.description`). */
  champ: string;
  /** Libellé lisible, pour l'écran. Le front ne recompose pas un nom à partir de la clé. */
  label: string;
  avant: string;
  apres: string;
}

/** Un outil de la bibliothèque de l'espace, et si cet agent y est branché. */
export interface OutilDuCatalogue {
  nom: string;
  titre: string;
  branche: boolean;
}

export interface EtatCourant {
  fiche: FicheAgentContenu;
  /** Le régime d'annonce d'IA actuel, celui de l'espace : la question de la construction règle la politique
   *  de la marque, pas celle de ce seul agent. */
  mentionIaFrequence: FrequenceMentionIa;
  /** Le délai d'inactivité actuel, en minutes. */
  inactiviteMinutes: number;
  /** Les outils déjà posés sur l'agent, par handler, avec leurs mots actuels. */
  outils: Array<{ handler: string; description: string; nePasUtiliser: string }>;
  /**
   * Les connecteurs déjà déclarés, par leur nom exposé : l'assistant ne peut proposer que leurs mots.
   * `origine` est requise : la liste porte connecteurs API et outils MCP, qui ne doivent pas se confondre.
   */
  connecteurs?: Array<{
    nom: string; titre: string; description: string; nePasUtiliser: string;
    origine: 'http' | 'mcp';
    /** Apparie un outil à son serveur (le préfixe du nom exposé, réécrit et tronqué, ne prouve rien).
     *  `null` pour un outil maison. */
    sourceId: string | null;
  }>;
  /**
   * La bibliothèque de l'espace, avec l'état de branchement de cet agent : l'assistant peut brancher ou
   * débrancher, pas créer. La définition appartient à l'espace, le consentement au couple (outil,
   * consommateur) : l'assistant n'agit que sur le second.
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
 * `differences`, plus bas : le diff calculé sur l'état courant, qui ne rend que ce qui change vraiment. Une
 * recopie à l'identique ne produit aucune ligne, sinon le client apprendrait à valider sans lire. `reponses`
 * et `bascules` (l'état de l'entretien) en sont exclues par le type.
 */
/** Le régime, dit en français : ce diff est lu par un humain qui tranche une question légale. */
export const LIBELLES_MENTION: Record<string, string> = {
  jamais: 'jamais',
  session: 'une fois par conversation',
  chaque_message: 'à chaque message',
};

/**
 * Un nombre de minutes, dit comme on le dirait à voix haute : `1440` ne se lit pas, et un diff qu'on doit
 * juger ne doit pas demander de faire la division.
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

  // Le régime d'annonce d'IA, hors fiche, en toutes lettres. Le libellé dit « pour tout l'espace » : le
  // réglage n'est pas celui de cet agent seul, et la ligne engage juridiquement la marque.
  if (proposition.mentionIaFrequence !== undefined && proposition.mentionIaFrequence !== courant.mentionIaFrequence) {
    out.push({
      champ: 'mentionIaFrequence',
      label: 'Annonce « je suis une IA » (pour tout l’espace)',
      avant: LIBELLES_MENTION[courant.mentionIaFrequence] ?? courant.mentionIaFrequence,
      apres: LIBELLES_MENTION[proposition.mentionIaFrequence] ?? proposition.mentionIaFrequence,
    });
  }

  // Le délai d'inactivité, hors fiche lui aussi, dit en toutes lettres.
  if (proposition.inactiviteMinutes !== undefined && proposition.inactiviteMinutes !== courant.inactiviteMinutes) {
    out.push({
      champ: 'inactiviteMinutes',
      label: 'Silence du contact : quand l’agent lâche',
      avant: dureeEnClair(courant.inactiviteMinutes),
      apres: dureeEnClair(proposition.inactiviteMinutes),
    });
  }

  /**
   * Le branchement, une ligne par outil, seulement quand l'état change. Un nom absent du catalogue ne produit
   * aucune ligne (le schéma ne peut pas vérifier l'existence). Le libellé dit « disponible », pas « activé » :
   * brancher rattache, activer reste un geste humain.
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
      // On le dit : l'outil reste sur les autres agents, et un connecteur API que plus personne n'utilise est
      // retiré de l'espace.
      apres: 'non branché (il reste sur les autres agents ; s’il ne sert plus à personne, il est retiré de l’espace)',
    });
  }

  for (const o of proposition.outils ?? []) {
    const modele = OUTILS_MAISON.find((m) => m.handler === o.handler);
    const deja = courant.outils.find((x) => x.handler === o.handler);
    const nom = modele?.titre.fr ?? o.handler;
    // Un outil absent est une proposition d'ajout : on le dit, sinon le diff de description cacherait la création.
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

  // Les connecteurs : seulement ceux qui existent. Un nom inconnu est ignoré, sans faire échouer la
  // conversation.
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
