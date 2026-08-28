import { z } from 'zod';
import { fichePatchSchema, type FicheAgentContenu } from '../fiche';
import { OUTILS_MAISON } from '../outils-maison';

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

export const propositionSchema = z.object({
  /** Ce que l'assistant dit au client, en clair. Toujours présent : une proposition sans explication est
   *  un diff que personne ne peut juger. */
  message: z.string().trim().min(1).max(4000),
  /** Les champs de fiche proposés. PARTIEL au sens strict : le modèle ne touche qu'à ce dont il parle, et
   *  les champs absents restent ABSENTS (voir `fichePatchSchema`, qui n'applique aucun défaut). */
  fiche: fichePatchSchema.optional(),
  /** 🔴 HANDLERS UNIQUES, même exigence que les codes de sortie de la fiche. Deux entrées pour le même outil
   *  produiraient deux lignes de diff portant la MÊME clé, et l'application tenterait de créer deux fois le
   *  même outil : la seconde création se ferait refuser sur un nom déjà pris, en laissant la première. */
  outils: z.array(outilProposeSchema).max(OUTILS_MAISON.length)
    .refine((o) => new Set(o.map((x) => x.handler)).size === o.length, 'un outil proposé deux fois')
    .optional(),
});

export type Proposition = z.infer<typeof propositionSchema>;
export type OutilPropose = z.infer<typeof outilProposeSchema>;

/** Nom de l'outil par lequel le modèle rend sa réponse. Forcé à l'appel : voir `toolChoice`. */
export const OUTIL_PROPOSER = 'proposer';

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
    outils: {
      type: 'array',
      description: 'Les outils du catalogue que tu proposes, avec leurs mots.',
      items: {
        type: 'object',
        properties: {
          handler: { type: 'string', enum: [...HANDLERS] },
          description: { type: 'string', description: 'Quand l’appeler, en une à trois phrases, avec un exemple de tournure du client.' },
          nePasUtiliser: { type: 'string', description: 'Quand NE PAS l’appeler. Jamais vide.' },
        },
        required: ['handler', 'description', 'nePasUtiliser'],
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
  /** Les outils DÉJÀ posés sur l'agent, par handler, avec leurs mots actuels. */
  outils: Array<{ handler: string; description: string; nePasUtiliser: string }>;
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
export function differences(courant: EtatCourant, proposition: Proposition): Changement[] {
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

  return out;
}
