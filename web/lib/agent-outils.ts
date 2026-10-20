/**
 * Le nom EXPOSÉ d'un outil, tel que le modèle l'appelle.
 *
 * 🔴 POURQUOI CETTE RÈGLE EXISTE DEUX FOIS. La colonne `agent_tools.name` porte un `check` en base
 * (`^[a-z0-9_]{1,64}$`, charset commun à OpenAI et Gemini) et la route le rejoue en 400. Sans normalisation
 * côté navigateur, le client tape « Poser un tag », reçoit un refus technique sur un champ qu'il croyait bon,
 * et n'a aucun moyen de deviner l'alphabet attendu. On lui applique donc la règle SOUS SES YEUX, comme pour
 * les codes de règles d'arrêt (`web/lib/partage/sorties-agent.ts`).
 *
 * ⚠️ Ce n'est PAS la même règle que celle des codes de sortie : celle-là interdit le tiret bas aux extrémités
 * et s'arrête à 32 caractères, parce qu'un code de sortie devient un handle d'arête. Les mélanger ferait
 * refuser des noms d'outils parfaitement valides. `tests/web-agent-outils.test.ts` ancre celle-ci contre le
 * schéma de la route, que les deux builds ne partagent pas.
 */

export const MAX_NOM_OUTIL = 64;

export function normaliserNomOutil(brut: string): string {
  const propre = brut
    // Décomposer puis retirer les marques combinantes (`\p{M}`) : « poser_tâg » doit devenir « poser_tag »,
    // et non « poser_ta_g » comme le ferait un simple filtre sur l'alphabet.
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_{2,}/g, '_')
    .slice(0, MAX_NOM_OUTIL);
  // 🔴 Une saisie sans le moindre caractère alphanumérique (« --- », « ### », des espaces) se resserre en un
  // SEUL tiret bas, que la règle du serveur accepte : le champ enregistrerait alors « _ » comme nom d'outil
  // exposé au modèle, au lieu de rendre la main. On rend une chaîne vide, et l'appelant garde le nom
  // précédent. Même doctrine que `normaliserCodeSortie`, mais pas la même règle : ici `_debut` et `fin_` sont
  // des noms parfaitement valides, on ne peut donc pas se contenter de dépouiller les extrémités.
  return /[a-z0-9]/.test(propre) ? propre : '';
}

/**
 * 🔴 LES OUTILS PROPRES À L'AGENT IA, SECTION « TOUJOURS LÀ » (RC4, décision de Julien du 2026-10-06) : terminer,
 * passer à l'équipe, chercher dans la connaissance, lire la fiche, marquer urgent. Un interrupteur chacun, au-dessus de
 * la grille « Quel outil ajouter ? ». Aucun n'a de cible : ils se posent tels quels. L'ordre est celui de l'écran.
 * `tests/web-agent-outils.test.ts` les tient égaux aux handlers SANS cible du catalogue serveur.
 */
export const TOUJOURS_LA = ['terminer', 'escalader', 'chercher_connaissance', 'lire_contact', 'marquer_urgent'] as const;
export type HandlerToujoursLa = (typeof TOUJOURS_LA)[number];

export function estToujoursLa(handler: string): handler is HandlerToujoursLa {
  return (TOUJOURS_LA as readonly string[]).includes(handler);
}

/**
 * Les cartes de la grille qui posent un outil maison À CIBLE, et le handler qu'elles posent (RC4, alignés sur l'agent de
 * Meta : un tag, un champ, un bloc, un scénario fixés par l'administrateur ; plus l'action, propre à l'agent IA, plan
 * du 2026-10-13). Tenu égal à `HANDLERS_A_CIBLE` du serveur par `tests/web-agent-outils.test.ts`.
 */
export const HANDLER_DU_TYPE = {
  tag: 'poser_tag', champ: 'ecrire_variable', bloc: 'envoyer_bloc', scenario: 'lancer_scenario', action: 'declencher_action',
  enchainement: 'enchainer', qualification: 'qualifier_transferer',
} as const;
export type TypeACible = keyof typeof HANDLER_DU_TYPE;

/** Le type de carte d'un handler à cible, ou `null`. */
export function typeDuHandler(handler: string): TypeACible | null {
  const trouve = (Object.keys(HANDLER_DU_TYPE) as TypeACible[]).find((t) => HANDLER_DU_TYPE[t] === handler);
  return trouve ?? null;
}

/**
 * LES ACTIONS (plan `docs/superpowers/plans/2026-10-13-actions-agent.md`) : recopies de `TYPES_CHAMP_ACTION`,
 * `BORNES_ACTION` et `CODE_CHAMP_ACTION_RE` du serveur (`src/agent/outils-maison.ts`), tenues égales par
 * `tests/web-agent-outils.test.ts` : les deux builds ne partagent pas ce module.
 */
export const TYPES_CHAMP_ACTION = ['texte', 'nombre', 'date', 'email', 'liste'] as const;
export type TypeChampAction = (typeof TYPES_CHAMP_ACTION)[number];
export const BORNES_ACTION = { nom: 60, consigne: 600, champs: 10, code: 40, libelle: 80, valeurs: 20, valeur: 60 } as const;
export const CODE_CHAMP_ACTION_RE = /^[a-z][a-z0-9_]{0,39}$/;

/** Un champ d'action tel que l'écran le saisit. `valeurs` ne sert qu'à une liste. */
export interface ChampActionSaisi { code: string; libelle: string; type: TypeChampAction; valeurs: string[] }

/** Une cible telle que l'écran la saisit (le format des composants de l'agent de Meta), pour un handler à cible. */
export type CibleSaisieAgent =
  | { type: 'tag'; tag: string }
  | { type: 'champ'; champ: string; valeurs: string[] }
  | { type: 'bloc'; workflowId: string; code: string }
  | { type: 'scenario'; workflowId: string }
  | { type: 'action'; nom: string; consigne: string; champs: ChampActionSaisi[] }
  | { type: 'enchainement'; etapes: EtapeSaisie[] }
  /** « Qualifier et transférer » : ses questions, saisies comme des étapes « demander » (le même éditeur). */
  | { type: 'qualification'; etapes: EtapeSaisie[] };
export type CibleActionSaisie = Extract<CibleSaisieAgent, { type: 'action' }>;
export type CibleEnchainementSaisie = Extract<CibleSaisieAgent, { type: 'enchainement' }>;
export type CibleQualificationSaisie = Extract<CibleSaisieAgent, { type: 'qualification' }>;

/**
 * L'OUTIL ENCHAÎNÉ (demande de Julien du 2026-10-20) : des étapes que l'administrateur range dans l'ordre qu'il veut.
 * Recopie des types et des bornes de `src/agent/enchainement.ts`, tenue égale par `tests/web-agent-outils.test.ts` :
 * les deux builds ne partagent pas ce module.
 */
export const TYPES_ETAPE = ['demander', 'valeur', 'tag', 'urgent', 'bloc', 'scenario', 'transferer'] as const;
export type TypeEtape = (typeof TYPES_ETAPE)[number];
export const BORNES_ENCHAINEMENT = { etapes: 12, question: 120, champ: 64, valeur: 120, valeurs: 50, valeurFixe: 500, texte: 1000 } as const;
/** La clé d'un champ « demander » devient le nom d'un paramètre : même alphabet que le serveur. */
export const CLE_CHAMP_DEMANDE_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const PARAM_DEJA_DEMANDE = 'deja_demande';
/** Les clés qu'une question ne peut pas remplir : `deja_demande` et la phrase de l'agent (`message`). */
export const CLES_RESERVEES: readonly string[] = [PARAM_DEJA_DEMANDE, 'message'];

/** Une étape telle que l'écran la saisit : un seul objet, chaque type lit ses champs. */
export interface EtapeSaisie {
  type: TypeEtape;
  champ: string;
  question: string;
  valeurs: string[];
  valeur: string;
  tag: string;
  workflowId: string;
  code: string;
}

export function etapeVide(type: TypeEtape): EtapeSaisie {
  return { type, champ: '', question: '', valeurs: [], valeur: '', tag: '', workflowId: '', code: '' };
}

/** Les mots de chaque type d'étape, dans le menu « + Ajouter une étape » et en tête de l'étape. */
export const LIBELLES_ETAPE: Readonly<Record<TypeEtape, Bilingue>> = {
  demander: ['Demander une information', 'Ask for a detail'],
  valeur: ['Enregistrer une valeur fixe', 'Save a fixed value'],
  tag: ['Poser un tag', 'Set a tag'],
  urgent: ['Marquer la conversation urgente', 'Mark the conversation urgent'],
  bloc: ['Envoyer un bloc', 'Send a block'],
  scenario: ['Lancer un scénario (termine)', 'Start a scenario (ends)'],
  transferer: ['Transférer en « À traiter » (termine)', 'Hand over to “To handle” (ends)'],
};

/** Les étapes qui partent chez le contact : jamais avant une question (le serveur l'exige aussi). */
const PART_CHEZ_LE_CONTACT: ReadonlySet<TypeEtape> = new Set(['bloc', 'scenario']);
/** Les étapes après lesquelles l'agent se retire : une seule, en dernier. */
const TERMINALES: ReadonlySet<TypeEtape> = new Set(['scenario', 'transferer']);

/** L'outil part-il chez le contact ? Il est alors irréversible, et l'autonomie se coche à la pose. */
export function enchainementIrreversible(etapes: readonly EtapeSaisie[]): boolean {
  return etapes.some((e) => PART_CHEZ_LE_CONTACT.has(e.type));
}

/** Ce qui ne va pas dans une question (une étape « demander »), ou `null`. `quoi` : « Étape 2 » ou « Question 2 ». */
function manqueDeLaQuestion(e: EtapeSaisie, quoi: Bilingue): Bilingue | null {
  const [fr, en] = quoi;
  if (e.champ === '') return [`${fr} : choisissez le champ où ranger la réponse.`, `${en}: pick the field that stores the answer.`];
  if (!CLE_CHAMP_DEMANDE_RE.test(e.champ) || CLES_RESERVEES.includes(e.champ)) {
    return [`${fr} : le champ « ${e.champ} » a une clé que l’agent ne peut pas remplir (minuscules, chiffres, tirets bas, une lettre d’abord).`,
      `${en}: the field “${e.champ}” has a key the agent cannot fill (lowercase, digits, underscores, a letter first).`];
  }
  if (e.question.trim() === '') return [`${fr} : dites ce que l’agent demande.`, `${en}: say what the agent asks.`];
  if (e.question.trim().length > BORNES_ENCHAINEMENT.question) {
    return [`${fr} : ${BORNES_ENCHAINEMENT.question} caractères au plus.`, `${en}: at most ${BORNES_ENCHAINEMENT.question} characters.`];
  }
  if (e.valeurs.length > BORNES_ENCHAINEMENT.valeurs || e.valeurs.some((v) => v.length > BORNES_ENCHAINEMENT.valeur)) {
    return [`${fr} : ${BORNES_ENCHAINEMENT.valeurs} valeurs de ${BORNES_ENCHAINEMENT.valeur} caractères au plus.`,
      `${en}: at most ${BORNES_ENCHAINEMENT.valeurs} values of ${BORNES_ENCHAINEMENT.valeur} characters.`];
  }
  return null;
}

const DEUX_QUESTIONS_MEME_CHAMP: Bilingue = ['Deux questions remplissent le même champ.', 'Two questions fill the same field.'];

/**
 * Ce qui manque à un enchaînement, ou ce qui ne va pas dans son ORDRE, dit avant le 400 du serveur
 * (`fauteDOrdre`, `src/agent/enchainement.ts`) ; `null` = il est prêt.
 */
export function manqueDeLEnchainement(c: CibleEnchainementSaisie): Bilingue | null {
  if (c.etapes.length === 0) return ['Ajoutez une première étape.', 'Add a first step.'];
  if (c.etapes.length > BORNES_ENCHAINEMENT.etapes) {
    return [`Au plus ${BORNES_ENCHAINEMENT.etapes} étapes.`, `At most ${BORNES_ENCHAINEMENT.etapes} steps.`];
  }
  for (const [i, e] of c.etapes.entries()) {
    const n = i + 1;
    switch (e.type) {
      case 'demander': {
        const faute = manqueDeLaQuestion(e, [`Étape ${n}`, `Step ${n}`]);
        if (faute !== null) return faute;
        break;
      }
      case 'valeur':
        if (e.champ === '' || e.valeur.trim() === '') return [`Étape ${n} : choisissez le champ et sa valeur.`, `Step ${n}: pick the field and its value.`];
        break;
      case 'tag':
        if (e.tag.trim() === '') return [`Étape ${n} : choisissez le tag.`, `Step ${n}: pick the tag.`];
        break;
      case 'bloc':
        if (e.workflowId === '' || e.code === '') return [`Étape ${n} : choisissez le bloc.`, `Step ${n}: pick the block.`];
        break;
      case 'scenario':
        if (e.workflowId === '') return [`Étape ${n} : choisissez le scénario.`, `Step ${n}: pick the scenario.`];
        break;
      case 'urgent':
      case 'transferer':
        break;
    }
  }
  const types = c.etapes.map((e) => e.type);
  const terminales = types.flatMap((x, i) => (TERMINALES.has(x) ? [i] : []));
  if (terminales.length > 1) {
    return ['Un seul scénario ou transfert à l’équipe : l’agent se retire au premier, le suivant ne partirait jamais.',
      'A single scenario or handover to the team: the agent steps back at the first one, the next would never run.'];
  }
  if (terminales.length === 1 && terminales[0] !== types.length - 1) {
    return ['Le scénario ou le transfert ferme la marche : l’agent se retire, rien de ce qui suit ne partirait. Mettez-le en dernier.',
      'The scenario or the handover comes last: the agent steps back, nothing after it would run. Put it last.'];
  }
  const premierEnvoi = types.findIndex((x) => PART_CHEZ_LE_CONTACT.has(x));
  if (premierEnvoi !== -1 && premierEnvoi < types.lastIndexOf('demander')) {
    return ['Un bloc ou un scénario vient après toutes les questions : l’agent pose toujours les questions en premier, un bloc placé avant partirait en réalité après la réponse.',
      'A block or a scenario comes after all the questions: the agent always asks first, so a block placed before would actually be sent after the answer.'];
  }
  const cles = c.etapes.filter((e) => e.type === 'demander').map((e) => e.champ);
  if (new Set(cles).size !== cles.length) return DEUX_QUESTIONS_MEME_CHAMP;
  return null;
}

/** Ce qui manque à « Qualifier et transférer » (`cibleQualificationSchema` du serveur) ; `null` = il est prêt. */
export function manqueDeLaQualification(c: CibleQualificationSaisie): Bilingue | null {
  if (c.etapes.length === 0) return ['Ajoutez une première question.', 'Add a first question.'];
  if (c.etapes.length > BORNES_ENCHAINEMENT.etapes) {
    return [`Au plus ${BORNES_ENCHAINEMENT.etapes} questions.`, `At most ${BORNES_ENCHAINEMENT.etapes} questions.`];
  }
  for (const [i, e] of c.etapes.entries()) {
    const faute = manqueDeLaQuestion(e, [`Question ${i + 1}`, `Question ${i + 1}`]);
    if (faute !== null) return faute;
  }
  if (new Set(c.etapes.map((e) => e.champ)).size !== c.etapes.length) return DEUX_QUESTIONS_MEME_CHAMP;
  return null;
}

/** Les mots de la carte « Qualifier et transférer », propre à l'agent IA. */
export const TEXTES_QUALIFICATION = {
  titre: ['Qualifier et transférer', 'Qualify and hand over'] as Bilingue,
  aide: [
    'L’agent pose vos questions, range chaque réponse dans un champ, puis passe la conversation dans « À traiter ».',
    'The agent asks your questions, stores each answer in a field, then moves the conversation to “To handle”.',
  ] as Bilingue,
  quand: [
    'Appelle cet outil dès que le contact veut parler à quelqu’un de l’équipe, ou qu’il [décrivez la situation], avec les informations qu’il a déjà données.',
    'Call this tool as soon as the contact wants to talk to someone on the team, or [describe the situation], with the details they already gave.',
  ] as Bilingue,
  pasQuand: [
    'N’appelle pas cet outil pour une question à laquelle les sources répondent.',
    'Do not call this tool for a question the sources answer.',
  ] as Bilingue,
} as const;

/** Le titre proposé d'un outil « Enregistrer une information », d'après le libellé du champ choisi. */
export function titreDuChamp(libelle: string): Bilingue {
  return [`Enregistrer : ${libelle}`, `Record: ${libelle}`];
}

/** Un titre que l'écran a proposé lui-même (« Enregistrer : … ») : il suit encore le champ choisi. */
export function estTitreDeChamp(titre: string): boolean {
  return titre.startsWith('Enregistrer : ') || titre.startsWith('Record: ');
}

/** Les mots de la carte « Enchaîner des étapes », propre à l'agent IA. */
export const TEXTES_ENCHAINEMENT = {
  titre: ['Enchaîner des étapes', 'Chain steps'] as Bilingue,
  aide: [
    'Plusieurs actions dans l’ordre que vous choisissez : demander des informations, puis poser un tag, envoyer un bloc, lancer un scénario…',
    'Several actions in the order you choose: ask for details, then set a tag, send a block, start a scenario…',
  ] as Bilingue,
  quand: [
    'Appelle cet outil dès que le contact [décrivez la situation], avec les informations qu’il a déjà données.',
    'Call this tool as soon as the contact [describe the situation], with the details they already gave.',
  ] as Bilingue,
  pasQuand: [
    'N’appelle pas cet outil tant que le contact n’est pas dans cette situation.',
    'Do not call this tool until the contact is in this situation.',
  ] as Bilingue,
} as const;

/**
 * Le code d'un champ, tiré de son libellé : la clé du champ dans `fields` du webhook, et le paramètre que le modèle
 * remplit. Même alphabet que le serveur (`CODE_CHAMP_ACTION_RE`) : une lettre d'abord. Chaîne vide si rien n'en reste.
 * `enFrappe` : le code se TAPE dans son propre champ, et le tiret bas final se garde, sinon « ref_ » redevient « ref »
 * avant qu'on ait tapé « client » (le serveur accepte un tiret bas final).
 */
export function normaliserCodeChamp(brut: string, enFrappe = false): string {
  const coupe = brut
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[^a-z]+/, '')
    .slice(0, BORNES_ACTION.code);
  const propre = enFrappe ? coupe : coupe.replace(/_+$/, '');
  return CODE_CHAMP_ACTION_RE.test(propre) ? propre : '';
}

/** Un code libre dans la liste : `motif`, puis `motif_2`, `motif_3`… */
export function codeLibre(base: string, pris: readonly string[]): string {
  const racine = base === '' ? 'champ' : base;
  if (!pris.includes(racine)) return racine;
  for (let i = 2; ; i += 1) {
    const suffixe = `_${i}`;
    const candidat = `${racine.slice(0, BORNES_ACTION.code - suffixe.length)}${suffixe}`;
    if (!pris.includes(candidat)) return candidat;
  }
}

type Bilingue = readonly [string, string];

/**
 * Ce qui manque à une action pour partir, dit avant que le serveur ne la refuse en 400 ; `null` = elle est prête. Les
 * bornes sont celles du serveur. Tous les champs restent facultatifs pour l'agent : seul ce qui les DÉCRIT est exigé.
 */
export function manqueDeLAction(c: CibleActionSaisie): Bilingue | null {
  if (c.nom.trim() === '') return ['Donnez un nom à l’action.', 'Name the action.'];
  if (c.nom.trim().length > BORNES_ACTION.nom || c.consigne.trim().length > BORNES_ACTION.consigne) {
    return [`Trop long : un nom fait ${BORNES_ACTION.nom} caractères au plus, une consigne ${BORNES_ACTION.consigne}.`,
      `Too long: a name is at most ${BORNES_ACTION.nom} characters, an instruction ${BORNES_ACTION.consigne}.`];
  }
  if (c.champs.length > BORNES_ACTION.champs) {
    return [`Au plus ${BORNES_ACTION.champs} champs.`, `At most ${BORNES_ACTION.champs} fields.`];
  }
  for (const ch of c.champs) {
    if (ch.libelle.trim() === '') return ['Chaque champ a un libellé.', 'Each field has a label.'];
    if (ch.libelle.trim().length > BORNES_ACTION.libelle) {
      return [`Un libellé fait ${BORNES_ACTION.libelle} caractères au plus.`, `A label is at most ${BORNES_ACTION.libelle} characters.`];
    }
    if (!CODE_CHAMP_ACTION_RE.test(ch.code)) {
      return [`Le code « ${ch.code} » : une lettre minuscule d’abord, puis lettres, chiffres ou tirets bas.`,
        `The code “${ch.code}”: a lowercase letter first, then letters, digits or underscores.`];
    }
    const valeurs = ch.valeurs.map((v) => v.trim()).filter((v) => v !== '');
    if (ch.type === 'liste' && valeurs.length === 0) return ['Une liste porte ses valeurs.', 'A list carries its values.'];
    if (valeurs.length > BORNES_ACTION.valeurs || valeurs.some((v) => v.length > BORNES_ACTION.valeur)) {
      return [`Une liste : ${BORNES_ACTION.valeurs} valeurs de ${BORNES_ACTION.valeur} caractères au plus.`,
        `A list: at most ${BORNES_ACTION.valeurs} values of ${BORNES_ACTION.valeur} characters.`];
    }
  }
  const codes = c.champs.map((ch) => ch.code);
  if (new Set(codes).size !== codes.length) return ['Deux champs portent le même code.', 'Two fields share the same code.'];
  return null;
}

/** Les mots de la carte « Déclencher une action », propre à l'agent IA (l'agent de Meta n'a pas cet outil). */
export const TEXTES_ACTION = {
  titre: ['Déclencher une action', 'Trigger an action'] as Bilingue,
  aide: [
    'Envoie une demande du client (résiliation, rappel, réclamation…) à votre application, par webhook, avec ce que l’agent a recueilli',
    'Sends a customer request (cancellation, callback, complaint…) to your application, by webhook, with what the agent collected',
  ] as Bilingue,
  quand: [
    'Appelle cet outil dès que le contact exprime la demande décrite dans la consigne de l’action, avec ce qu’il a déjà donné.',
    'Call this tool as soon as the contact expresses the request described in the action’s instruction, with what they already gave.',
  ] as Bilingue,
  pasQuand: [
    'N’appelle pas cet outil tant que le contact n’a pas clairement exprimé cette demande.',
    'Do not call this tool until the contact has clearly expressed this request.',
  ] as Bilingue,
} as const;

const texte = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Un champ d'action relu défensivement : un type inconnu devient « texte », une liste sans tableau n'a pas de valeurs. */
function champLu(c: unknown): ChampActionSaisi[] {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return [];
  const o = c as Record<string, unknown>;
  const type = (TYPES_CHAMP_ACTION as readonly string[]).includes(texte(o.type)) ? (o.type as TypeChampAction) : 'texte';
  const valeurs = Array.isArray(o.valeurs) ? o.valeurs.filter((v): v is string => typeof v === 'string') : [];
  return [{ code: texte(o.code), libelle: texte(o.libelle), type, valeurs }];
}

/**
 * La cible d'un outil posé, lue DÉFENSIVEMENT dans son `binding` (un jsonb opaque) : un champ absent devient vide, et
 * l'écran le montre comme une cible à refaire plutôt que de planter. `null` = handler sans cible.
 */
export function cibleDeLOutil(binding: Record<string, unknown>): CibleSaisieAgent | null {
  switch (typeDuHandler(texte(binding.handler))) {
    case 'tag': return { type: 'tag', tag: texte(binding.tag) };
    case 'champ': return {
      type: 'champ', champ: texte(binding.champ),
      valeurs: Array.isArray(binding.valeurs) ? binding.valeurs.filter((v): v is string => typeof v === 'string') : [],
    };
    case 'bloc': return { type: 'bloc', workflowId: texte(binding.workflowId), code: texte(binding.code) };
    case 'scenario': return { type: 'scenario', workflowId: texte(binding.workflowId) };
    case 'action': return {
      type: 'action', nom: texte(binding.nom), consigne: texte(binding.consigne),
      champs: Array.isArray(binding.champs) ? binding.champs.flatMap(champLu) : [],
    };
    case 'enchainement': return {
      type: 'enchainement', etapes: Array.isArray(binding.etapes) ? binding.etapes.flatMap(etapeLue) : [],
    };
    // Les questions se relisent comme des étapes « demander » : le même éditeur les montre.
    case 'qualification': return {
      type: 'qualification',
      etapes: Array.isArray(binding.questions) ? binding.questions.flatMap((q) => etapeLue({ ...asObjet(q), type: 'demander' })) : [],
    };
    case null: return null;
  }
}

function asObjet(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Une étape relue défensivement : un type inconnu est écarté (une console plus ancienne que l'API). */
function etapeLue(e: unknown): EtapeSaisie[] {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return [];
  const o = e as Record<string, unknown>;
  const type = TYPES_ETAPE.find((x) => x === o.type);
  if (!type) return [];
  return [{
    ...etapeVide(type),
    champ: texte(o.champ), question: texte(o.question), valeur: texte(o.valeur), tag: texte(o.tag),
    workflowId: texte(o.workflowId), code: texte(o.code),
    valeurs: Array.isArray(o.valeurs) ? o.valeurs.filter((v): v is string => typeof v === 'string') : [],
  }];
}

/** Une étape telle que le serveur la lit : seulement les champs de son type. */
function corpsDeLEtape(e: EtapeSaisie): Record<string, unknown> {
  switch (e.type) {
    case 'demander': return { type: e.type, champ: e.champ, question: e.question.trim(), valeurs: e.valeurs.map((v) => v.trim()).filter((v) => v !== '') };
    case 'valeur': return { type: e.type, champ: e.champ, valeur: e.valeur.trim() };
    case 'tag': return { type: e.type, tag: e.tag.trim() };
    case 'urgent': return { type: e.type };
    case 'bloc': return { type: e.type, workflowId: e.workflowId, code: e.code };
    case 'scenario': return { type: e.type, workflowId: e.workflowId };
    case 'transferer': return { type: e.type };
  }
}

/** Le corps `cible` des routes de l'agent IA : sans `type` ni `handler`, que le serveur tire de l'outil. */
export function corpsDeLaCible(c: CibleSaisieAgent): Record<string, unknown> {
  switch (c.type) {
    case 'tag': return { tag: c.tag.trim() };
    case 'champ': return { champ: c.champ, valeurs: c.valeurs };
    case 'bloc': return { workflowId: c.workflowId, code: c.code };
    case 'scenario': return { workflowId: c.workflowId };
    // Une valeur de liste vide (une virgule de trop) ne part pas ; les valeurs ne partent que pour une liste.
    case 'action': return {
      nom: c.nom.trim(), consigne: c.consigne.trim(),
      champs: c.champs.map((ch) => ({
        code: ch.code, libelle: ch.libelle.trim(), type: ch.type,
        ...(ch.type === 'liste' ? { valeurs: ch.valeurs.map((v) => v.trim()).filter((v) => v !== '') } : {}),
      })),
    };
    case 'enchainement': return { etapes: c.etapes.map(corpsDeLEtape) };
    // Une question sans son `type` : le serveur n'accepte que des questions ici.
    case 'qualification': return {
      questions: c.etapes.map((e) => {
        const { type: _type, ...q } = corpsDeLEtape({ ...e, type: 'demander' });
        return q;
      }),
    };
  }
}

/** La cible est-elle assez remplie pour partir ? (le serveur refuse le reste en 400, l'écran le dit avant). */
export function cibleComplete(c: CibleSaisieAgent): boolean {
  switch (c.type) {
    case 'tag': return c.tag.trim() !== '';
    case 'champ': return c.champ !== '';
    case 'bloc': return c.workflowId !== '' && c.code !== '';
    case 'scenario': return c.workflowId !== '';
    case 'action': return manqueDeLAction(c) === null;
    case 'enchainement': return manqueDeLEnchainement(c) === null;
    case 'qualification': return manqueDeLaQualification(c) === null;
  }
}
