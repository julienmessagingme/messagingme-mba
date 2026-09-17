import { z } from 'zod';

/**
 * La FICHE d'un agent : tout ce que le client décrit de son agent, et rien d'autre.
 *
 * 🔴 CETTE FRONTIÈRE EST LE SUJET DE LA COLONNE `fiche`. Ce qui est ici est ce que l'IA de construction
 * pourra écrire un jour à partir d'une conversation. Ce qui n'y est PAS (plafonds, modèle, mention légale,
 * statut) vit en colonnes, hors du jsonb, et n'est écrit que par un administrateur authentifié : une IA ne
 * relève pas elle-même son propre plafond de dépense, et n'efface pas la phrase qui annonce qu'elle est une
 * IA (obligation légale, AI Act article 50).
 *
 * Validé par `safeParse`, jamais `parse` : la fiche vient d'un formulaire ou d'un modèle, donc d'une source
 * non fiable dans les deux cas.
 */

/**
 * Le code d'une règle d'arrêt. Même alphabet que les noms d'outils, parce qu'il finit dans un handle d'arête
 * `sortie:<code>` du builder : un caractère exotique y produirait des écarts silencieux entre ce que le
 * builder dessine et ce que le moteur route.
 *
 * ⚠️ NI SOULIGNÉ EN TÊTE, NI EN QUEUE, et c'est exigé plutôt que toléré : `normaliserCodeSortie` ci-dessous
 * (et sa copie de saisie, `web/lib/agent-sorties.ts`) ne peut pas en produire, donc accepter `_rdv` côté
 * serveur créerait un code que le client ne peut pas taper et que personne ne pourrait plus reproduire ni
 * corriger.
 */
export const CODE_SORTIE_RE = /^[a-z0-9](?:[a-z0-9_]{0,30}[a-z0-9])?$/;

/**
 * Les BORNES de longueur des champs de la fiche, en un seul endroit.
 *
 * 🔴 ELLES SONT EXPORTÉES PARCE QU'UN AUTRE FICHIER DOIT LES CONNAÎTRE, et les avoir gardées privées a coûté
 * un tour d'entretien entier : l'assistant de construction refusait une proposition trop longue sans jamais
 * avoir annoncé au modèle la longueur permise. Un nombre recopié là-bas aurait dérivé ; lu ici, non.
 *
 * ⚠️ DÉCLARÉES AVANT `sortieAgentSchema`, qui les lit à l'évaluation du module : plus bas, la zone morte
 * temporelle d'un `const` ferait tomber l'import entier, et pas seulement ce champ.
 */
export const BORNES_FICHE = {
  nom: 80, objectif: 4000, ton: 1000, personnalite: 1000, reglesTransfert: 4000,
  /** Le libellé d'une règle d'arrêt. */
  label: 60,
  /** Le CODE d'une règle d'arrêt : la longueur maximale que `CODE_SORTIE_RE` ci-dessus laisse passer. */
  code: 32,
} as const;

/**
 * Ramène un code libre vers ce que `CODE_SORTIE_RE` accepte. Rend une chaîne VIDE quand il ne reste rien
 * d'exploitable, pour que l'appelant écarte l'entrée au lieu de fabriquer une sortie nommée « _ ».
 *
 * 🔴 C'EST L'AUTORITÉ, et `web/lib/agent-sorties.ts` en est la COPIE (recopiée pour ne pas tirer du code
 * serveur dans le bundle client, comme `MAX_DESTINATAIRES_EMAIL`). `tests/web-agent-code-sortie-parity.test.ts`
 * compare les deux FONCTIONS et casse dès qu'elles divergent d'un caractère.
 *
 * 🔴 ELLE EXISTE CÔTÉ SERVEUR DEPUIS LE 2026-09-17, ET L'ASYMÉTRIE D'AVANT COÛTAIT UN TOUR D'ENTRETIEN
 * ENTIER. Le client qui TAPE un code le voyait normalisé sous ses yeux ; l'assistant de construction qui
 * PROPOSE le même code voyait toute sa proposition refusée en 422, parce que le serveur n'avait que la regex
 * et aucun moyen de ramener une valeur dedans. Le plafond de 32 caractères n'était écrit nulle part ailleurs
 * que dans cette regex : ni le mandat ni le schéma envoyé au modèle ne le mentionnaient.
 *
 * ⚠️ UN CODE DÉJÀ VALIDE RESSORT INCHANGÉ, et c'est ce qui la rend sûre à poser sur un chemin existant :
 * sinon rouvrir une fiche déplacerait ses codes, et les arêtes déjà tirées dans le builder désigneraient des
 * sorties qui n'existent plus.
 */
export function normaliserCodeSortie(brut: string): string {
  return brut
    // Décomposition puis retrait des marques diacritiques : un accent ne passe pas dans un handle d'arête,
    // mais la lettre qui le porte, si.
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, BORNES_FICHE.code)
    // Le `slice` peut laisser un souligné en fin de chaîne : on le retire APRÈS, sinon un code tronqué
    // sortirait avec une terminaison que personne n'a écrite.
    .replace(/_+$/g, '');
}

/**
 * Une règle d'arrêt : « quand l'agent a fini de faire ÇA, il sort par là ».
 *
 * 🔴 LA FICHE FAIT AUTORITÉ, et elle est la SEULE source de ces codes. L'outil maison `terminer` expose au
 * modèle une énumération fermée des sorties possibles : cette énumération se DÉRIVE d'ici au moment de
 * construire le schéma envoyé au modèle, elle ne se recopie jamais en base. Deux copies finiraient par
 * diverger, et l'agent rendrait un code que le graphe ne sait pas router.
 */
export const sortieAgentSchema = z.object({
  code: z.string().regex(CODE_SORTIE_RE),
  label: z.string().trim().min(1).max(BORNES_FICHE.label),
});

/** Plafond de règles d'arrêt. Au-delà, le bloc devient illisible dans le builder, et le modèle choisit mal
 *  dans une énumération trop large. */
export const MAX_SORTIES = 12;

/**
 * Les champs de la fiche, SANS défaut. Les deux schémas ci-dessous en dérivent tous les deux, et c'est le
 * seul moyen d'avoir une lecture et un patch qui ne divergent jamais sur les bornes.
 */
const CHAMPS = {
  /** Le nom que l'agent se donne dans la conversation. Vide -> il n'en donne aucun. */
  nom: z.string().trim().max(BORNES_FICHE.nom),
  /** Ce que l'agent est là pour faire. C'est le champ qui porte le plus de sens pour le modèle. */
  objectif: z.string().trim().max(BORNES_FICHE.objectif),
  ton: z.string().trim().max(BORNES_FICHE.ton),
  personnalite: z.string().trim().max(BORNES_FICHE.personnalite),
  /** Quand passer la main à un humain, en français, tel que le client le dirait. */
  reglesTransfert: z.string().trim().max(BORNES_FICHE.reglesTransfert),
  /**
   * 🔴 CODES UNIQUES, exigé ICI parce que la LECTURE le suppose déjà : `sortiesDeLaFiche` écarte un doublon
   * en silence. Sans cette garde, l'écriture accepterait ce que la lecture jette, et la fiche cesserait de
   * dire ce que le builder route. Le formulaire bloque déjà le doublon, mais l'IA de construction écrira ici
   * aussi.
   */
  sorties: z.array(sortieAgentSchema).max(MAX_SORTIES)
    .refine((s) => new Set(s.map((x) => x.code)).size === s.length, 'codes de sortie en double'),
};

/** La fiche COMPLÈTE, telle qu'on la LIT : chaque champ absent prend son défaut, ce qui rend une ligne
 *  ancienne ou mal formée éditable au lieu de faire tomber l'écran. */
export const ficheAgentSchema = z.object({
  nom: CHAMPS.nom.default(''),
  objectif: CHAMPS.objectif.default(''),
  ton: CHAMPS.ton.default(''),
  personnalite: CHAMPS.personnalite.default(''),
  reglesTransfert: CHAMPS.reglesTransfert.default(''),
  sorties: CHAMPS.sorties.default([]),
});

/**
 * La fiche en PATCH : chaque champ optionnel et SANS DÉFAUT.
 *
 * 🔴 POURQUOI CE SECOND SCHÉMA EXISTE, et c'est un piège qui a déjà coûté une fois. `ficheAgentSchema
 * .partial()` NE FAIT PAS ce qu'on croit : `.partial()` rend le champ optionnel, mais le `.default()` qui est
 * DESSOUS s'applique quand même à l'absence. Un `{ objectif }` ressort donc en fiche ENTIÈRE, chaque autre
 * champ rempli par son défaut. Écrit ensuite par la fusion jsonb (`fiche || $n`), il n'y a plus aucune clé
 * absente à protéger : le ton, la personnalité et TOUTES les règles d'arrêt sont effacés, sans la moindre
 * erreur. La correction de la tâche 19a (la fusion et le verrou de version) ne fermait donc pas le cas
 * qu'elle visait, et rien ne le voyait : le formulaire renvoie toujours la fiche entière.
 *
 * `tests/agent-sorties-fiche.test.ts` ancre le comportement des DEUX schémas, précisément parce qu'ils se
 * ressemblent assez pour qu'on reprenne le mauvais.
 */
export const fichePatchSchema = z.object({
  nom: CHAMPS.nom.optional(),
  objectif: CHAMPS.objectif.optional(),
  ton: CHAMPS.ton.optional(),
  personnalite: CHAMPS.personnalite.optional(),
  reglesTransfert: CHAMPS.reglesTransfert.optional(),
  sorties: CHAMPS.sorties.optional(),
});

export type FicheAgentContenu = z.infer<typeof ficheAgentSchema>;

/** Une fiche vide, valide. Sert de valeur par défaut à la création et de repli à la lecture d'un jsonb illisible. */
export function ficheVide(): FicheAgentContenu {
  return { nom: '', objectif: '', ton: '', personnalite: '', reglesTransfert: '', sorties: [] };
}
