import { z } from 'zod';
import type { OutilDefini, RisqueOutil } from './catalog';
import type { SortieAgent } from './agent-store';
import { paramsOutil, toolParamsToJsonSchema, type ParamOutil, type SchemaObjet } from './llm/tool-schema';
import { LONGUEUR_MAX_ETIQUETTE } from '../crm/poser-etiquette';
import { CODE_BLOC_RE } from '../workflow/node-list';
import {
  PARAM_MESSAGE, cibleEnchainementSchema, cibleQualificationSchema, etapesDeLaQualification, motsDeLEnchainement,
  paramsDeLEnchainement, type EtapeEnchainement,
} from './enchainement';

/**
 * Le catalogue des outils maison, et ce que le modèle voit d'un outil.
 *
 * Un catalogue plutôt qu'un formulaire libre : le comportement vient de `binding.handler`, et seuls existent
 * les handlers de `resolvers/mba.ts`. Un handler libre produirait un outil actif qui refuse à chaque appel.
 * Le client compose le nom, les mots et, pour sept d'entre eux, la cible (`cibleOutilAgentSchema`). Miroir de `HANDLERS`, tenu par
 * `tests/agent-outils-maison.test.ts`.
 */

/** Ce que le client peut composer sur un paramètre, en plus de rien. */
export type EditionParam =
  /** Rien : le paramètre est ce qu'il est. */
  | 'aucune'
  /**
   * Le client liste les valeurs autorisées. Aucune entrée du catalogue ne l'emploie depuis RC4 (les tags, champs et
   * blocs sont des cibles fixes, `cibleOutilAgentSchema`) : la route refuse donc toute liste (`PATCH`, `enums`).
   */
  | 'enum'
  /** L'énumération dérive de la fiche de l'agent et n'est jamais stockée (voir `outilsExposes`). */
  | 'derive_des_sorties';

export interface ParamCatalogue extends ParamOutil {
  edition: EditionParam;
  /** Ce qu'on dit au client à propos de cette liste, dans sa langue à lui. */
  aideEnum?: { fr: string; en: string };
}

export interface OutilCatalogue {
  /** Clé de `binding.handler`, et identifiant du modèle de cet outil dans la console. */
  handler: string;
  /** Nom exposé au modèle par défaut. Le client peut le changer : un nom parlant fait un meilleur agent. */
  nomDefaut: string;
  titre: { fr: string; en: string };
  description: { fr: string; en: string };
  nePasUtiliser: { fr: string; en: string };
  risk: RisqueOutil;
  params: ParamCatalogue[];
  /**
   * Les paramètres que le catalogue IMPOSE à chaque outil de ce modèle, déjà posés compris. Jamais stockés :
   * `agent_tools.params` garde la copie écrite à la pose, donc un ajout à `params` n'atteindrait aucun outil
   * existant. Ni `paramsInitiaux` ni le catalogue rendu à la console ne les lisent ; `paramsEffectifs` les
   * ajoute. Tolérés absents à la validation, annoncés requis au modèle (`outilExpose`) : annoncer plus strict
   * que ce qu'on applique ne crée aucune panne, l'inverse en crée.
   */
  paramsImposes?: readonly ParamOutil[];
}

const P = (
  name: string, description: string, edition: EditionParam = 'aucune', aideEnum?: { fr: string; en: string },
): ParamCatalogue => ({
  name, type: 'string', source: 'modele', required: true, description, edition, ...(aideEnum ? { aideEnum } : {}),
});

/**
 * Les douze outils maison. `envoyer_bloc` et `lancer_scenario` sont déclarés irréversibles : un message parti ne se
 * rappelle pas et il est facturé, donc le tronc commun les refuse tant que le client n'a pas coché l'autonomie sur
 * l'outil. `enchainer` l'est selon ses étapes (`risqueDeLEnchainement`).
 *
 * 🔴 SEPT D'ENTRE EUX AGISSENT SUR UNE CIBLE FIXÉE PAR L'ADMINISTRATEUR (RC4, alignés sur l'agent de Meta) : un tag,
 * un champ, un bloc, un scénario, une action, des étapes ou des questions par outil, dans `binding`
 * (`cibleOutilAgentSchema`). Le modèle ne décide que du moment et, pour un champ, de la valeur ; il ne désigne jamais la
 * cible.
 */
export const OUTILS_MAISON: readonly OutilCatalogue[] = [
  {
    handler: 'terminer',
    nomDefaut: 'mba_terminer',
    titre: { fr: 'Terminer par une règle d’arrêt', en: 'Finish through a stop rule' },
    // Le texte nomme l'onglet des règles d'arrêt : le paramètre `sortie` en dérive son énumération. C'est le
    // défaut d'un outil neuf ; les outils déjà posés gardent leur copie, que le client peut réécrire.
    description: {
      fr: 'À appeler quand la conversation a atteint un de ses aboutissements, c’est-à-dire une des règles d’arrêt de l’onglet « Objectif et transferts ». Rend la main au scénario par la sortie choisie.',
      en: 'Call when the conversation has reached one of its outcomes, that is one of the stop rules from the “Objective and handovers” tab. Hands back to the scenario through the chosen output.',
    },
    nePasUtiliser: {
      fr: 'Ne pas appeler pour passer la main à un humain : il y a un outil pour ça.',
      en: 'Do not call to hand over to a human: there is a dedicated tool.',
    },
    risk: 'read',
    params: [{
      ...P('sortie', 'Le code de la règle d’arrêt atteinte.'),
      edition: 'derive_des_sorties',
    }],
    // Un modèle peut appeler cet outil sans rien écrire à côté : le tour s'arrête sur l'appel, et le contact ne
    // recevrait rien. Le cerveau envoie ce message quand la réponse qui porte l'appel n'a pas de texte.
    paramsImposes: [{
      name: 'message', type: 'string', source: 'modele',
      description: 'Ton dernier message au contact avant de rendre la main : récapitulatif, confirmation ou au revoir, dans le ton de la conversation. Toujours rempli.',
    }],
  },
  {
    handler: 'escalader',
    nomDefaut: 'mba_escalader_humain',
    titre: { fr: 'Passer la main à un humain', en: 'Hand over to a human' },
    description: {
      fr: 'À appeler dès que la demande sort du périmètre, ou que le contact le demande. La conversation arrive dans l’inbox.',
      en: 'Call as soon as the request is out of scope, or the contact asks for it. The conversation lands in the inbox.',
    },
    nePasUtiliser: {
      fr: 'Ne pas appeler par prudence sur une question à laquelle les sources répondent.',
      en: 'Do not call out of caution on a question the sources answer.',
    },
    risk: 'write',
    params: [],
    // Même défaut que `terminer`, mesuré le 2026-10-05 sur la même demande de conseiller : Mistral Small escalade sans
    // un mot 10 fois sur 10, Claude Sonnet 4.5 9 sur 10, Gemini 2.5 Flash Lite 7 sur 8. Le cerveau envoie ce message
    // quand la réponse qui porte l'appel n'a pas de texte, là où la phrase de l'agent est dite (`brain.gateway.ts`).
    paramsImposes: [{
      name: 'message', type: 'string', source: 'modele',
      description: 'Ta phrase au contact avant de passer la main, dans le ton de la conversation : qui prend le relais, ou quand l’équipe reprend si elle n’est pas joignable. Toujours rempli.',
    }],
  },
  {
    // RC2 (migration 0216) : la conversation passe dans le dossier « Urgent » (et en tête de « À traiter » dès que
    // l'équipe la tient : tant que l'agent répond, le fil est `app_workflow`, que « À traiter » exclut), et l'agent
    // CONTINUE de répondre (urgent n'est pas un transfert). Posé sur aucun agent à la livraison, et absent des outils
    // qu'un agent tiers peut poser par MCP (`OUTILS_SURS`) : le client l'ajoute à la main.
    handler: 'marquer_urgent',
    nomDefaut: 'mba_marquer_urgent',
    titre: { fr: 'Marquer la conversation urgente', en: 'Mark the conversation as urgent' },
    description: {
      fr: 'À appeler quand la demande du contact presse vraiment : un problème qui le bloque, une réclamation, un délai qui expire. La conversation apparaît dans le dossier « Urgent » de l’équipe ; tu continues de lui répondre.',
      en: 'Call when the contact’s request is truly pressing: a blocking problem, a complaint, a deadline about to expire. The conversation shows up in the team’s “Urgent” folder; you keep answering them.',
    },
    nePasUtiliser: {
      fr: 'Ne pas l’appeler pour une simple demande d’information.',
      en: 'Do not call it for a mere request for information.',
    },
    risk: 'write',
    params: [],
  },
  {
    handler: 'chercher_connaissance',
    nomDefaut: 'mba_chercher_connaissance',
    titre: { fr: 'Chercher dans la base de connaissance', en: 'Search the knowledge base' },
    description: {
      fr: 'À appeler AVANT de répondre à toute question de fond. Rend les fiches qui traitent le sujet, ou rien.',
      en: 'Call BEFORE answering any substantive question. Returns the entries covering the topic, or nothing.',
    },
    nePasUtiliser: {
      fr: 'Ne pas répondre de mémoire quand cet outil ne rend rien.',
      en: 'Do not answer from memory when this tool returns nothing.',
    },
    risk: 'read',
    params: [P('requete', 'La question, dans les mots du contact.')],
  },
  {
    handler: 'lire_contact',
    nomDefaut: 'mba_lire_contact',
    titre: { fr: 'Lire la fiche du contact', en: 'Read the contact record' },
    description: {
      fr: 'Rend ce que l’on sait déjà du contact : son nom, ses champs, et ce que la dernière analyse de ses conversations a constaté (intention, sentiment, satisfaction et urgence sur 10, résolue ou non, sujet), avec son résumé s’il existe. Aucun identifiant à fournir.',
      en: 'Returns what is already known about the contact: name, custom fields, and what the latest analysis of their conversations found (intent, sentiment, satisfaction and urgency out of 10, resolved or not, topic), with its summary if any. No identifier to provide.',
    },
    nePasUtiliser: {
      fr: 'Ne rend jamais la fiche de quelqu’un d’autre : inutile de le demander.',
      en: 'Never returns anyone else’s record: no point asking.',
    },
    risk: 'read',
    params: [],
  },
  {
    // RC4 : le tag est FIXÉ à la pose (`binding.tag`), un outil par tag. Aucun paramètre : le modèle ne choisit que
    // le moment, jamais l'étiquette.
    handler: 'poser_tag',
    nomDefaut: 'mba_poser_tag',
    titre: { fr: 'Poser un tag sur le contact', en: 'Tag the contact' },
    description: {
      fr: 'Pose sur le contact le tag prévu pour cet outil, pour le retrouver ensuite dans le mini-CRM ou déclencher une automation.',
      en: 'Sets the tag planned for this tool on the contact, to find them later in the mini-CRM or trigger an automation.',
    },
    nePasUtiliser: {
      fr: 'Ne pas l’appeler tant que la situation qui justifie ce tag n’est pas arrivée.',
      en: 'Do not call it until the situation that warrants this tag has happened.',
    },
    risk: 'write',
    params: [],
  },
  {
    // RC4 : le champ est FIXÉ à la pose (`binding.champ`) ; la valeur vient du modèle, bornée à `binding.valeurs`
    // quand l'administrateur en donne (`paramsEffectifs` l'annonce et la validation l'applique).
    handler: 'ecrire_variable',
    nomDefaut: 'mba_ecrire_variable',
    titre: { fr: 'Enregistrer une information sur le contact', en: 'Record information about the contact' },
    description: {
      fr: 'Enregistre sur la fiche du contact l’information prévue pour cet outil, pour qu’un bloc plus loin dans le scénario la réutilise.',
      en: 'Records on the contact record the information planned for this tool, so a later block in the scenario can reuse it.',
    },
    nePasUtiliser: {
      fr: 'Ne pas l’appeler tant que le contact n’a pas donné cette information.',
      en: 'Do not call it until the contact has given this information.',
    },
    risk: 'write',
    params: [P('valeur', 'La valeur à enregistrer, telle que le contact l’a donnée.')],
  },
  {
    // RC4 : le bloc est FIXÉ à la pose (`binding.workflowId` et `binding.code`), et part SEUL, comme chez l'agent de
    // Meta (`blocSeul`) : ce qui le suit dans son scénario ne part pas.
    handler: 'envoyer_bloc',
    nomDefaut: 'mba_envoyer_bloc',
    titre: { fr: 'Envoyer un bloc de votre scénario', en: 'Send a block from your scenario' },
    description: {
      fr: 'Envoie au contact le bloc prévu pour cet outil : une photo, un message, un modèle. Tu gardes la main ensuite.',
      en: 'Sends the contact the block planned for this tool: a photo, a message, a template. You keep the floor afterwards.',
    },
    nePasUtiliser: {
      fr: 'Ne pas appeler pour dire ce qu’un message écrit dirait aussi bien.',
      en: 'Do not call for something a written message would say just as well.',
    },
    // Irréversible : un message parti ne se rappelle pas, et il est facturé.
    risk: 'irreversible',
    params: [],
  },
  {
    // RC4 : le scénario est FIXÉ à la pose (`binding.workflowId`). TERMINAL : le scénario prend la conversation, la
    // session de l'agent se clôt, et le modèle n'est plus rappelé (`scenarioLance`, `brain.gateway.ts`).
    handler: 'lancer_scenario',
    nomDefaut: 'mba_lancer_scenario',
    titre: { fr: 'Lancer un scénario', en: 'Start a scenario' },
    description: {
      fr: 'Lance le scénario prévu pour cet outil : il prend la conversation et tu te retires. N’écris rien à côté, c’est le scénario qui parle au contact.',
      en: 'Starts the scenario planned for this tool: it takes over the conversation and you step back. Write nothing alongside, the scenario talks to the contact.',
    },
    nePasUtiliser: {
      fr: 'Ne pas l’appeler tant que le contact n’a pas exprimé le besoin que ce scénario traite.',
      en: 'Do not call it until the contact has expressed the need this scenario handles.',
    },
    // Irréversible : le scénario envoie des messages, qui ne se rappellent pas et sont facturés.
    risk: 'irreversible',
    params: [],
  },
  {
    // Les actions (plan docs/superpowers/plans/2026-10-13-actions-agent.md) : l'action est FIXÉE à la pose (`binding` :
    // son nom, sa consigne, ses champs) ; le modèle ne décide que du moment et des valeurs recueillies, toutes
    // facultatives. Une écriture : elle fait partir le webhook `agent.action` vers l'application du client
    // (`src/agent/actions.ts`), et le tour CONTINUE (aucun drapeau d'arrêt).
    handler: 'declencher_action',
    nomDefaut: 'mba_declencher_action',
    titre: { fr: 'Déclencher une action', en: 'Trigger an action' },
    description: {
      fr: 'Déclenche l’action prévue pour cet outil vers l’application de l’entreprise, avec les informations recueillies auprès du contact. Tu continues la conversation ensuite.',
      en: 'Triggers the action planned for this tool towards the business’s application, with the information collected from the contact. You carry on the conversation afterwards.',
    },
    nePasUtiliser: {
      fr: 'Ne pas l’appeler tant que le contact n’a pas clairement exprimé cette demande.',
      en: 'Do not call it until the contact has clearly expressed this request.',
    },
    risk: 'write',
    params: [],
  },
  {
    // L'outil enchaîné (`src/agent/enchainement.ts`, demande de Julien du 2026-10-20) : des étapes que l'administrateur
    // range dans l'ordre qu'il veut, FIXÉES à la pose (`binding.etapes`) ; le modèle ne fournit que les informations
    // demandées et `deja_demande`. Le risque déclaré ici est celui d'un outil neuf qu'on ne connaît pas encore ; la pose
    // et la modification le recalculent sur les étapes (`risqueDeLEnchainement`) : irréversible dès qu'un bloc ou un
    // scénario part chez le contact, donc l'autonomie à cocher.
    handler: 'enchainer',
    nomDefaut: 'mba_enchainer',
    titre: { fr: 'Enchaîner des étapes', en: 'Chain steps' },
    description: {
      fr: 'Exécute dans l’ordre les étapes prévues pour cet outil : recueillir des informations sur le contact, puis agir (étiquette, message, scénario, passage à l’équipe).',
      en: 'Runs the steps planned for this tool in order: collect information about the contact, then act (tag, message, scenario, handover to the team).',
    },
    nePasUtiliser: {
      fr: 'Ne pas l’appeler tant que le contact n’est pas dans la situation que cet outil traite.',
      en: 'Do not call it until the contact is in the situation this tool handles.',
    },
    risk: 'write',
    params: [],
  },
  {
    // « Qualifier et transférer » (demande de Julien du 2026-10-20) : des questions FIXÉES à la pose (`binding.questions`),
    // posées une seule fois, puis la conversation passe à l'équipe (« À traiter »), toujours en dernier. Le moteur est
    // celui de l'outil enchaîné (`etapesDeLaQualification`). Il exclut « Passer la main à un humain » et toute règle
    // d'arrêt qui passe à un humain : l'un ou l'autre, jamais les deux (`src/agent/camp.ts`).
    handler: 'qualifier_transferer',
    nomDefaut: 'mba_qualifier_transferer',
    titre: { fr: 'Qualifier et transférer', en: 'Qualify and hand over' },
    description: {
      fr: 'Recueille les informations prévues sur le contact, puis passe la conversation à l’équipe, dans le dossier « À traiter ».',
      en: 'Collects the planned information about the contact, then hands the conversation over to the team, in the “To handle” folder.',
    },
    nePasUtiliser: {
      fr: 'Ne pas l’appeler par prudence sur une question à laquelle les sources répondent.',
      en: 'Do not call it out of caution on a question the sources answer.',
    },
    risk: 'write',
    params: [],
  },
];

/**
 * 🔴 LA CIBLE D'UN OUTIL MAISON QUI AGIT SUR QUELQUE CHOSE (RC4), dans `binding`, à côté du `handler`. Calquée sur
 * celle de l'agent de Meta (`cibleMaisonSchema`, `src/mba/outils-maison.ts`) sans en partager les noms : un outil
 * d'un agent qui atteindrait l'autre tomberait sur un handler inconnu (disjonction tenue par
 * `tests/mba-outils-maison.test.ts`). `.strict()` : le `binding` est un jsonb que rien d'autre ne contraint, une clé
 * en trop veut dire qu'une autre écriture l'a produit, et un outil qu'on ne comprend pas ne s'exécute pas.
 */
export const BORNES_CIBLE = { tag: LONGUEUR_MAX_ETIQUETTE, champ: 64, valeur: 120, valeurs: 50 } as const;

/** Les types d'un champ d'action (décision de Julien du 2026-10-13) ; tous facultatifs. */
export const TYPES_CHAMP_ACTION = ['texte', 'nombre', 'date', 'email', 'liste'] as const;
export type TypeChampAction = (typeof TYPES_CHAMP_ACTION)[number];
/** Les bornes d'une action. `parAgent` : au plus 10 actions par agent (décision de Julien), tenu à la pose. */
export const BORNES_ACTION = {
  nom: 60, consigne: 600, champs: 10, code: 40, libelle: 80, valeurs: 20, valeur: 60, parAgent: 10,
  /** La longueur d'une valeur que le modèle remplit, annoncée dans la description du champ (`FORMAT_DU_CHAMP`). */
  texte: 1000,
} as const;
/** Le code d'un champ : le nom du paramètre que le modèle remplit, et la clé de `fields` dans le webhook. */
export const CODE_CHAMP_ACTION_RE = /^[a-z][a-z0-9_]{0,39}$/;

const champActionSchema = z.object({
  code: z.string().regex(CODE_CHAMP_ACTION_RE),
  libelle: z.string().trim().min(1).max(BORNES_ACTION.libelle),
  type: z.enum(TYPES_CHAMP_ACTION),
  valeurs: z.array(z.string().trim().min(1).max(BORNES_ACTION.valeur)).min(1).max(BORNES_ACTION.valeurs).optional(),
}).strict().refine((c) => (c.type === 'liste') === (c.valeurs !== undefined), {
  message: 'une liste porte ses valeurs, et seule une liste en porte',
});
export type ChampAction = z.infer<typeof champActionSchema>;
export const cibleOutilAgentSchema = z.discriminatedUnion('handler', [
  z.object({ handler: z.literal('poser_tag'), tag: z.string().trim().min(1).max(BORNES_CIBLE.tag) }).strict(),
  z.object({
    handler: z.literal('ecrire_variable'),
    champ: z.string().trim().min(1).max(BORNES_CIBLE.champ),
    valeurs: z.array(z.string().trim().min(1).max(BORNES_CIBLE.valeur)).max(BORNES_CIBLE.valeurs),
  }).strict(),
  // Un bloc se désigne par son code public (`nod_…`), pas par l'identifiant du nœud : le code survit à la réécriture
  // du graphe par l'éditeur.
  z.object({ handler: z.literal('envoyer_bloc'), workflowId: z.string().uuid(), code: z.string().regex(CODE_BLOC_RE) }).strict(),
  z.object({ handler: z.literal('lancer_scenario'), workflowId: z.string().uuid() }).strict(),
  z.object({
    handler: z.literal('declencher_action'),
    nom: z.string().trim().min(1).max(BORNES_ACTION.nom),
    consigne: z.string().trim().max(BORNES_ACTION.consigne),
    champs: z.array(champActionSchema).max(BORNES_ACTION.champs)
      .refine((cs) => new Set(cs.map((c) => c.code)).size === cs.length, { message: 'deux champs portent le même code' }),
  }).strict(),
  cibleEnchainementSchema,
  cibleQualificationSchema,
]);
export type CibleOutilAgent = z.infer<typeof cibleOutilAgentSchema>;
export type HandlerACible = CibleOutilAgent['handler'];

/** Les handlers dont la pose EXIGE une cible, lus sur le schéma : une cible ajoutée plus haut entre ici seule. */
export const HANDLERS_A_CIBLE: readonly HandlerACible[] = cibleOutilAgentSchema.options.map((o) => o.shape.handler.value);

export function exigeUneCible(handler: string): handler is HandlerACible {
  return (HANDLERS_A_CIBLE as readonly string[]).includes(handler);
}

/**
 * La cible d'un outil relu en base, ou `null` : un outil sans cible lisible n'est ni exposé au modèle ni exécuté.
 * Le `handler` fait partie de la cible : l'appelant le compare à celui qu'il sert.
 */
export function lireCibleOutilAgent(binding: unknown): CibleOutilAgent | null {
  const r = cibleOutilAgentSchema.safeParse(binding);
  return r.success ? r.data : null;
}

const PAR_HANDLER = new Map(OUTILS_MAISON.map((o) => [o.handler, o]));

/**
 * Le `handler` d'un outil maison, ou la chaîne vide pour un outil qui n'en est pas un. En un seul endroit :
 * une lecture de travers du jsonb `binding` rendrait une chaîne vide, donc un outil qu'on croit absent.
 */
export function handlerMaison(outil: { origin: string; binding: Record<string, unknown> }): string {
  return outil.origin === 'mba' ? String(outil.binding.handler ?? '').trim() : '';
}

export function outilMaison(handler: string): OutilCatalogue | undefined {
  return PAR_HANDLER.get(handler.trim());
}

/**
 * Les paramètres à écrire en base pour un outil maison neuf. Une énumération dérivée n'est jamais stockée :
 * une copie divergerait au premier ajout de règle d'arrêt.
 */
export function paramsInitiaux(modele: OutilCatalogue): ParamOutil[] {
  return modele.params.map(({ edition, aideEnum: _aide, enum: valeurs, ...p }) => (
    edition !== 'derive_des_sorties' && valeurs && valeurs.length > 0 ? { ...p, enum: valeurs } : p
  ));
}

/** Ce qu'un outil expose au modèle : son nom, ses mots, et son schéma. */
export interface OutilExpose {
  name: string;
  description: string;
  parameters: SchemaObjet;
}

/**
 * Ce que le modèle voit d'un outil, ou `null` quand il ne doit rien en voir.
 *
 * L'énumération de `terminer` est posée ici, depuis `fiche.sorties` seule : la fiche fait autorité, et une
 * copie dans `agent_tools.params` divergerait. Une dérivation vide retire l'outil au lieu de l'exposer sans
 * énumération, sinon le modèle inventerait un code que le bloc ne dessine pas. À distinguer d'une liste vide
 * remplie par le client (les valeurs permises d'un champ fixé), qui veut dire « aucune restriction ». Un outil à cible
 * sans cible lisible est retiré de même.
 */
export function outilExpose(outil: OutilDefini, sorties: readonly SortieAgent[]): OutilExpose | null {
  const params = paramsAvecDerivations(outil, sorties.map((s) => s.code));
  if (params === null) return null;
  return { name: outil.name, description: motsExposes(outil), parameters: toolParamsToJsonSchema(params) };
}

/**
 * La description et la clause « quand ne pas l'appeler », réunies parce que la surface d'appel n'accepte
 * qu'un texte. La clause est séparée par une ligne et annoncée : collée, elle se lirait comme une consigne
 * d'usage. Vide, rien n'est écrit (du contexte payé à chaque aller-retour pour rien).
 */
function motsExposes(outil: OutilDefini): string {
  const refus = outil.nePasUtiliser.trim();
  const base = refus === '' ? outil.description : `${outil.description}\n\nNE PAS l’appeler : ${refus}`;
  return base + consigneDeLAction(outil) + champDeLOutil(outil) + etapesDeLEnchainement(outil);
}

/**
 * Les étapes d'un outil enchaîné ou de qualification (le même moteur), ou `null` pour un autre outil. Lues sur la
 * cible : c'est elle qui fait foi, à l'exposition comme à l'exécution.
 */
export function etapesDeLaCible(cible: CibleOutilAgent | null): EtapeEnchainement[] | null {
  if (cible?.handler === 'enchainer') return cible.etapes;
  if (cible?.handler === 'qualifier_transferer') return etapesDeLaQualification(cible);
  return null;
}

/** Les étapes d'un outil enchaîné, dites au modèle dans l'ordre (`motsDeLEnchainement`) : elles viennent de la cible. */
function etapesDeLEnchainement(outil: OutilDefini): string {
  const handler = handlerMaison(outil);
  if (handler !== 'enchainer' && handler !== 'qualifier_transferer') return '';
  const etapes = etapesDeLaCible(lireCibleOutilAgent(outil.binding));
  return etapes ? motsDeLEnchainement(etapes) : '';
}

/**
 * 🔴 LE CHAMP QUE REMPLIT « Enregistrer une information » (demande de Julien du 2026-10-20) : sans lui, le modèle lisait
 * « l'information prévue pour cet outil » et devinait laquelle. La clé vient de la cible, donc elle suit un changement
 * de champ sans que personne réécrive la description. Le modèle ne la répète pas au contact : un nom interne.
 */
function champDeLOutil(outil: OutilDefini): string {
  if (handlerMaison(outil) !== 'ecrire_variable') return '';
  const cible = lireCibleOutilAgent(outil.binding);
  if (cible?.handler !== 'ecrire_variable') return '';
  return `\n\nCe qu’il enregistre : le champ « ${cible.champ} » de la fiche du contact (un nom interne : ne le cite pas au contact).`;
}

/**
 * Le nom et la consigne d'une action (quand l'utiliser, quoi dire au contact ensuite), dits au modèle avec l'outil :
 * ils viennent de la cible, que l'administrateur écrit, pas de la description du catalogue.
 */
function consigneDeLAction(outil: OutilDefini): string {
  if (handlerMaison(outil) !== 'declencher_action') return '';
  const cible = lireCibleOutilAgent(outil.binding);
  if (cible?.handler !== 'declencher_action') return '';
  const consigne = cible.consigne.trim();
  return `\n\nAction : ${cible.nom}.${consigne === '' ? '' : ` ${consigne}`}`
    + '\nAprès l’appel, dis au contact ce que la consigne prévoit, puis continue la conversation.';
}

/** Les outils qu'on envoie au modèle. Ceux qui n'ont aucune valeur possible sont retirés, pas offerts vides. */
export function outilsExposes(outils: readonly OutilDefini[], sorties: readonly SortieAgent[]): OutilExpose[] {
  return outils.map((o) => outilExpose(o, sorties)).filter((o): o is OutilExpose => o !== null);
}

/**
 * Les paramètres effectifs d'un outil : sa liste (`OutilDefini.params`, la copie en base d'un outil maison ou MCP,
 * les variables de sa requête pour un connecteur), plus ceux que le catalogue impose et que la liste ne déclare pas
 * (`paramsImposes`). 🔴 L'exposition au modèle ET la validation des arguments (`executeTool`, étape 3)
 * les lisent ici : lu d'un seul côté, un paramètre imposé serait annoncé au modèle puis retiré de ses arguments
 * par Zod, sans erreur. Passe par `paramsOutil`, le point de passage unique de la séparation des sources, et par
 * `handlerMaison` : un outil qui n'est pas maison (connecteur, MCP, agent de Meta) ne reçoit rien.
 */
export function paramsEffectifs(outil: Pick<OutilDefini, 'origin' | 'binding' | 'params'>): ParamOutil[] {
  const liste: unknown[] = Array.isArray(outil.params) ? outil.params : [];
  const handler = handlerMaison(outil);
  const imposes = outilMaison(handler)?.paramsImposes ?? [];
  if (imposes.length === 0) return avecValeursDuChamp(outil.binding, handler, paramsOutil(liste));
  // « Déclaré » se lit sur le brut, comme les noms réservés de `paramsOutil` : une entrée de la liste
  // inutilisable garde son nom, et un imposé du même nom ne prend pas sa place.
  const declares = new Set(liste.map((b) => {
    const nom = b && typeof b === 'object' ? (b as { name?: unknown }).name : undefined;
    return typeof nom === 'string' ? nom.trim() : '';
  }));
  return avecValeursDuChamp(outil.binding, handler, paramsOutil([...liste, ...imposes.filter((p) => !declares.has(p.name))]));
}

/**
 * 🔴 LES VALEURS PERMISES D'UN CHAMP FIXÉ (RC4), dérivées de la cible et jamais recopiées dans `params` : une copie
 * divergerait à la première modification de la liste. Posées ici, donc annoncées au modèle ET appliquées par la
 * validation de `executeTool` (règle « toute borne appliquée est annoncée »). Une liste vide = toute valeur.
 */
function avecValeursDuChamp(binding: unknown, handler: string, params: ParamOutil[]): ParamOutil[] {
  if (handler === 'declencher_action') return paramsDeLAction(binding);
  if (handler === 'enchainer' || handler === 'qualifier_transferer') {
    const etapes = etapesDeLaCible(lireCibleOutilAgent(binding));
    return etapes ? paramsDeLEnchainement(etapes) : [];
  }
  if (handler !== 'ecrire_variable') return params;
  const cible = lireCibleOutilAgent(binding);
  if (cible?.handler !== 'ecrire_variable' || cible.valeurs.length === 0) return params;
  return params.map((p) => (p.name === 'valeur' ? { ...p, enum: [...cible.valeurs] } : p));
}

/** Ce que le format d'un champ ajoute à son libellé, pour le modèle : le handler refuse ce qui ne le respecte pas. */
const FORMAT_DU_CHAMP: Readonly<Record<TypeChampAction, string>> = {
  texte: ` (${BORNES_ACTION.texte} caractères au plus)`, nombre: ' (un nombre)', date: ' (une date au format AAAA-MM-JJ)',
  email: ' (une adresse e-mail)', liste: '',
};

/**
 * 🔴 LES PARAMÈTRES D'UNE ACTION, dérivés de sa cible et jamais stockés (comme les valeurs d'un champ fixé) : un par
 * champ, TOUS facultatifs (décision de Julien), nombre en nombre, liste en énumération, et le format d'une date ou d'un
 * e-mail dit dans la description. Une cible illisible ne donne aucun paramètre, et l'outil est retiré
 * (`paramsAvecDerivations`).
 */
function paramsDeLAction(binding: unknown): ParamOutil[] {
  const cible = lireCibleOutilAgent(binding);
  if (cible?.handler !== 'declencher_action') return [];
  return cible.champs.map((c): ParamOutil => ({
    name: c.code,
    type: c.type === 'nombre' ? 'number' : 'string',
    source: 'modele',
    required: false,
    description: `${c.libelle}${FORMAT_DU_CHAMP[c.type]}`,
    ...(c.type === 'liste' && c.valeurs ? { enum: [...c.valeurs] } : {}),
  }));
}

/** Les paramètres d'un outil, énumérations dérivées appliquées et imposés annoncés requis, ou `null` si une
 *  dérivation est vide. Passe par `paramsEffectifs`, la lecture que la validation fait aussi. */
function paramsAvecDerivations(outil: OutilDefini, codesSortie: string[]): ParamOutil[] | null {
  // `handlerMaison`, comme `paramsEffectifs` : une liaison de connecteur ou d'outil MCP qui porterait un `handler`
  // ne doit recevoir ni énumération dérivée ni obligation annoncée.
  const modele = outilMaison(handlerMaison(outil));
  const params = paramsEffectifs(outil);
  // Un handler sorti du catalogue (ligne ancienne) garde ses paramètres tels quels : il ne doit pas faire
  // tomber la construction du schéma de tout un tour.
  if (!modele) return params;
  // 🔴 Un outil à cible sans cible lisible (ligne d'avant RC4, binding réécrit) est RETIRÉ, pas offert : il refuserait
  // à chaque appel, et le modèle croirait pouvoir poser un tag qui ne partira jamais.
  if (exigeUneCible(modele.handler) && lireCibleOutilAgent(outil.binding)?.handler !== modele.handler) return null;
  const derives = new Set(modele.params.filter((p) => p.edition === 'derive_des_sorties').map((p) => p.name));
  // Annoncé requis, toléré absent : c'est l'obligation qui fait poser la question à un modèle de raisonnement,
  // et la validation, plus souple, ne refuse pas un appel qui l'oublie (il bouclerait jusqu'au plafond).
  const imposes = new Set((modele.paramsImposes ?? []).map((p) => p.name));
  // La phrase d'un outil enchaîné qui passe à l'équipe suit la même règle que celle de « Passer la main » : annoncée
  // requise, tolérée absente. Elle n'est dans `params` que quand les étapes finissent par le transfert.
  if (modele.handler === 'enchainer' || modele.handler === 'qualifier_transferer') imposes.add(PARAM_MESSAGE);
  if (derives.size === 0 && imposes.size === 0) return params;
  if (codesSortie.length === 0 && params.some((p) => derives.has(p.name))) return null;
  return params.map((p) => ({
    ...p,
    ...(derives.has(p.name) ? { enum: codesSortie } : {}),
    ...(imposes.has(p.name) ? { required: true } : {}),
  }));
}
