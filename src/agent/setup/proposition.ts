import type { FrequenceMentionIa } from '../agent-store';
import { z } from 'zod';
import { fichePatchSchema, type FicheAgentContenu } from '../fiche';
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
 *  - les OUTILS MAISON du catalogue, par leur handler, avec leurs MOTS.
 *
 * Ce qu'elle ne peut PAS écrire, et la liste est aussi importante que la précédente : la mention légale
 * d'IA (AI Act, article 50), les plafonds de tours, d'appels et de dépense, le modèle de l'agent, le RISQUE
 * d'un outil, et surtout son ACTIVATION. Compromettre la conversation de setup ne compromet donc pas
 * l'agent : au pire, elle propose des mots que le client voit passer dans un diff et refuse.
 *
 * ⚠️ Ces clés sont ABSENTES du schéma, elles ne sont pas « refusées » : `safeParse` d'un objet Zod sans
 * `.strict()` les ignore silencieusement, ce qui est exactement le comportement voulu ici. Un modèle qui
 * renvoie du bruit ne doit pas faire échouer tout un tour de conversation ; il doit juste ne rien obtenir.
 */

const HANDLERS = OUTILS_MAISON.map((o) => o.handler) as [string, ...string[]];

/** Les mots d'un outil, ceux qui décident si le modèle l'appelle au bon moment. C'est là que se joue le
 *  gain mesuré par Guo et al. : ce sont ces deux textes qu'aucun client n'écrit correctement seul. */
const outilProposeSchema = z.object({
  /** Énumération FERMÉE sur le catalogue : le modèle ne peut pas inventer un comportement. */
  handler: z.enum(HANDLERS),
  description: z.string().trim().min(1).max(2000),
  nePasUtiliser: z.string().trim().max(2000).default(''),
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
  nom: z.string().trim().regex(/^[a-z0-9_]{1,64}$/),
  description: z.string().trim().min(1).max(2000),
  nePasUtiliser: z.string().trim().max(2000).default(''),
});

export const propositionSchema = z.object({
  /** Ce que l'assistant dit au client, en clair. Toujours présent : une proposition sans explication est
   *  un diff que personne ne peut juger. */
  message: z.string().trim().min(1).max(4000),
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
    point: z.string().trim().max(64),
    /** Vide = rien retenu pour ce point. Toléré plutôt que refusé : voir la doctrine ci-dessus. */
    valeur: z.string().trim().max(2000).default(''),
  })).max(CODES_POINTS.length * 2).default([]),
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
    moment: z.string().trim().min(1).max(400),
    action: z.enum(ACTIONS).optional(),
    moyen: z.string().trim().max(2000).optional(),
  })).max(24).default([]),
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
  outils: z.array(outilProposeSchema).max(OUTILS_MAISON.length)
    .refine((o) => new Set(o.map((x) => x.handler)).size === o.length, 'un outil proposé deux fois')
    .optional(),
  /** Les MOTS d'un connecteur DÉJÀ déclaré. Même exigence d'unicité, et pour la même raison. */
  connecteurs: z.array(connecteurProposeSchema).max(20)
    .refine((o) => new Set(o.map((x) => x.nom)).size === o.length, 'un connecteur proposé deux fois')
    .optional(),
});

export type Proposition = z.infer<typeof propositionSchema>;
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
    message: { type: 'string', description: 'Ce que tu dis au client, en français, bref.' },
    mentionIaFrequence: {
      type: 'string',
      enum: ['jamais', 'session', 'chaque_message'],
      description: 'QUAND l’agent annonce qu’il est une IA, et SEULEMENT si le client l’a tranché : '
        + 'jamais = il ne l’annonce pas ; session = une seule fois par conversation ; chaque_message = à '
        + 'chaque réponse. Ne le propose pas de toi-même : c’est la responsabilité de la marque, pas la tienne.',
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
      description: 'Les moments où l’agent doit faire autre chose que répondre, un par entrée. Reprends le '
        + '`moment` À L’IDENTIQUE quand tu complètes une bascule déjà citée, sinon tu en crées une nouvelle.',
      items: {
        type: 'object',
        properties: {
          moment: { type: 'string', description: 'Le moment, dans les mots du client. Ex. « le client veut prendre rendez-vous ».' },
          action: {
            type: 'string',
            enum: [...ACTIONS],
            description: `Ce que l’agent fait à ce moment-là, et SEULEMENT si le client l’a tranché : ${CHOIX_ACTION.map((c) => `${c.action} = ${c.libelle}`).join(' ; ')}.`,
          },
          moyen: { type: 'string', description: 'Le moyen concret (quel scénario, quel connecteur, quoi d’autre), si le client l’a dit.' },
        },
        required: ['moment'],
      },
    },
    reponses: {
      type: 'array',
      description: 'Ce que le client vient de DIRE, rattaché aux points de l’ordre du jour. N’y mets que ce '
        + 'qu’il a réellement exprimé dans son dernier message : un point que tu as seulement supposé n’en fait '
        + 'PAS partie. Tant qu’il manque une réponse, tes champs ne seront pas montrés au client.',
      items: {
        type: 'object',
        properties: {
          point: { type: 'string', enum: [...CODES_POINTS] },
          valeur: { type: 'string', description: 'Sa réponse, dans tes mots, en une phrase.' },
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
        nom: { type: 'string', description: 'Le nom que l’agent se donne au contact. Vide, il n’en donne aucun.' },
        objectif: { type: 'string', description: 'Ce que l’agent est là pour faire, au-delà de répondre.' },
        ton: { type: 'string', description: 'Vouvoiement, longueur des phrases, emoji ou non.' },
        personnalite: { type: 'string', description: 'Les quelques traits qui le caractérisent.' },
        reglesTransfert: { type: 'string', description: 'Quand il passe la main à un humain, en français.' },
        sorties: {
          type: 'array',
          description: 'Les aboutissements de la conversation. Chacun devient une sortie du bloc dans le scénario.',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'minuscules, chiffres et tirets bas ; commence et finit par une lettre ou un chiffre' },
              label: { type: 'string', description: 'ce que ça veut dire, en clair' },
            },
            required: ['code', 'label'],
          },
        },
      },
    },
    connecteurs: {
      type: 'array',
      description: 'Les connecteurs DÉJÀ déclarés dont tu proposes de réécrire les mots. Tu ne peux pas en créer.',
      items: {
        type: 'object',
        properties: {
          nom: { type: 'string', description: 'le nom exact du connecteur déjà déclaré' },
          description: { type: 'string', description: 'Quand l’appeler, avec un exemple de tournure du client.' },
          nePasUtiliser: { type: 'string', description: NE_PAS_UTILISER },
        },
        required: ['nom', 'description'],
      },
    },
    outils: {
      type: 'array',
      description: 'Les outils du catalogue que tu proposes, avec leurs mots.',
      items: {
        type: 'object',
        properties: {
          handler: { type: 'string', enum: [...HANDLERS] },
          description: { type: 'string', description: 'Quand l’appeler, en une à trois phrases, avec un exemple de tournure du client.' },
          nePasUtiliser: { type: 'string', description: NE_PAS_UTILISER },
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
export interface EtatCourant {
  fiche: FicheAgentContenu;
  /** Le régime d'annonce d'IA ACTUEL, pour que le diff dise ce qui change (migration 0126). */
  mentionIaFrequence: FrequenceMentionIa;
  /** Le délai d'inactivité ACTUEL, en minutes, pour la même raison. */
  inactiviteMinutes: number;
  /** Les outils DÉJÀ posés sur l'agent, par handler, avec leurs mots actuels. */
  outils: Array<{ handler: string; description: string; nePasUtiliser: string }>;
  /** Les CONNECTEURS déjà déclarés par un administrateur, par leur nom exposé. L'assistant ne peut proposer
   *  que leurs mots, et seulement pour ceux-là : il n'en invente pas. */
  connecteurs?: Array<{ nom: string; titre: string; description: string; nePasUtiliser: string }>;
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
const LIBELLES_MENTION: Record<string, string> = {
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
function dureeEnClair(minutes: number): string {
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
  if (proposition.mentionIaFrequence !== undefined && proposition.mentionIaFrequence !== courant.mentionIaFrequence) {
    out.push({
      champ: 'mentionIaFrequence',
      label: 'Annonce « je suis une IA »',
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
