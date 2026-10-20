import { z } from 'zod';
import type { ParamOutil } from './llm/tool-schema';
import { LONGUEUR_MAX_ETIQUETTE } from '../crm/poser-etiquette';
import { CODE_BLOC_RE } from '../workflow/node-list';

/**
 * L'OUTIL ENCHAÎNÉ (« Enchaîner des étapes », demande de Julien du 2026-10-20) : un seul outil, plusieurs étapes que
 * l'administrateur range DANS L'ORDRE QU'IL VEUT, exécutées dans cet ordre. Cas d'origine : l'agent Pigier qualifie le
 * candidat (prénom, nom, campus, formation), puis lance le scénario qui le passe à l'équipe.
 *
 * Une étape « demander » est une information que le modèle tire de la conversation et que l'outil écrit sur la fiche ;
 * les autres sont fixées par l'administrateur, comme les cibles des outils simples (RC4) : le modèle ne choisit ni le
 * tag, ni le bloc, ni le scénario.
 *
 * 🔴 DEMANDER UNE SEULE FOIS. S'il manque une information, le premier appel n'agit PAS : il rend les questions, que
 * l'agent pose en un message, puis il rappelle l'outil avec `deja_demande: true`, et l'outil exécute alors tout avec ce
 * qu'il a, réponse complète, partielle ou refus. Un candidat qui veut parler à quelqu'un ne doit jamais rester bloqué
 * derrière un formulaire.
 *
 * 🔴 DEUX RÈGLES D'ORDRE, tenues par le schéma et non par l'écran seul. (1) Un scénario ferme la marche : l'agent se
 * retire, rien de ce qui suivrait ne partirait. (2) Rien de ce qui PART CHEZ LE CONTACT (bloc, scénario) ne vient avant
 * une question. Tant qu'une réponse manque, l'outil n'exécute RIEN : les questions passent donc toujours avant toutes
 * les étapes, et un bloc rangé avant une question partirait en réalité APRÈS la réponse, à rebours de l'ordre que
 * l'écran affiche. Pour un tag, une valeur fixe ou l'urgence, l'écart ne se voit pas : leur place est libre.
 */

/** `texte` : la longueur d'une réponse que le modèle écrit sur la fiche, annoncée dans sa description et appliquée. */
export const BORNES_ENCHAINEMENT = { etapes: 12, question: 120, champ: 64, valeur: 120, valeurs: 50, valeurFixe: 500, texte: 1000 } as const;

/** Le nom du paramètre qui dit à l'outil que la question a déjà été posée. Interdit comme clé de champ. */
export const PARAM_DEJA_DEMANDE = 'deja_demande';

/**
 * La clé d'un champ « demander » devient le NOM du paramètre que le modèle remplit : l'alphabet commun des fournisseurs,
 * une lettre d'abord. Les clés du mini-CRM sont déjà de cette forme (`prenom`, `nom_de_famille`).
 */
export const CLE_CHAMP_DEMANDE_RE = /^[a-z][a-z0-9_]{0,63}$/;

const champ = z.string().trim().min(1).max(BORNES_ENCHAINEMENT.champ);

const etapeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('demander'),
    champ: z.string().trim().regex(CLE_CHAMP_DEMANDE_RE).refine((c) => c !== PARAM_DEJA_DEMANDE, { message: 'clé réservée' }),
    /** Ce que l'agent demande, dans les mots de l'administrateur (« ton prénom »). */
    question: z.string().trim().min(1).max(BORNES_ENCHAINEMENT.question),
    /** Les valeurs permises ; vide = toute valeur. Annoncées au modèle et appliquées par la validation. */
    valeurs: z.array(z.string().trim().min(1).max(BORNES_ENCHAINEMENT.valeur)).max(BORNES_ENCHAINEMENT.valeurs),
  }).strict(),
  z.object({ type: z.literal('valeur'), champ, valeur: z.string().trim().min(1).max(BORNES_ENCHAINEMENT.valeurFixe) }).strict(),
  z.object({ type: z.literal('tag'), tag: z.string().trim().min(1).max(LONGUEUR_MAX_ETIQUETTE) }).strict(),
  z.object({ type: z.literal('urgent') }).strict(),
  z.object({ type: z.literal('bloc'), workflowId: z.string().uuid(), code: z.string().regex(CODE_BLOC_RE) }).strict(),
  z.object({ type: z.literal('scenario'), workflowId: z.string().uuid() }).strict(),
]);
export type EtapeEnchainement = z.infer<typeof etapeSchema>;
export type TypeEtape = EtapeEnchainement['type'];

/** Les étapes qui partent chez le contact : jamais avant une question (règle 2). */
const PART_CHEZ_LE_CONTACT: ReadonlySet<TypeEtape> = new Set(['bloc', 'scenario']);

/** La raison pour laquelle cet ordre d'étapes est refusé, ou `null`. Partagée avec l'écran par le message du 400. */
export function fauteDOrdre(etapes: readonly EtapeEnchainement[]): string | null {
  const iScenario = etapes.findIndex((e) => e.type === 'scenario');
  if (iScenario !== -1 && iScenario !== etapes.length - 1) return 'le scénario ferme la marche : rien ne peut venir après lui';
  const derniereQuestion = etapes.map((e) => e.type).lastIndexOf('demander');
  const premierEnvoi = etapes.findIndex((e) => PART_CHEZ_LE_CONTACT.has(e.type));
  if (premierEnvoi !== -1 && premierEnvoi < derniereQuestion) {
    return 'un bloc ou un scénario vient après toutes les questions : les questions passent toujours en premier, il partirait après la réponse';
  }
  const cles = etapes.flatMap((e) => (e.type === 'demander' ? [e.champ] : []));
  if (new Set(cles).size !== cles.length) return 'deux questions remplissent le même champ';
  return null;
}

export const cibleEnchainementSchema = z.object({
  handler: z.literal('enchainer'),
  etapes: z.array(etapeSchema).min(1).max(BORNES_ENCHAINEMENT.etapes),
}).strict().superRefine((c, ctx) => {
  const faute = fauteDOrdre(c.etapes);
  if (faute !== null) ctx.addIssue({ code: 'custom', message: faute, path: ['etapes'] });
});
export type CibleEnchainement = z.infer<typeof cibleEnchainementSchema>;

/** Un outil qui lance un scénario ou envoie un bloc est irréversible : il faut cocher l'autonomie pour qu'il agisse. */
export function risqueDeLEnchainement(etapes: readonly EtapeEnchainement[]): 'write' | 'irreversible' {
  return etapes.some((e) => PART_CHEZ_LE_CONTACT.has(e.type)) ? 'irreversible' : 'write';
}

/** Les scénarios que l'outil vise (blocs et lancement), pour la garde d'isolation de l'écriture. */
export function scenariosDeLEnchainement(etapes: readonly EtapeEnchainement[]): string[] {
  return [...new Set(etapes.flatMap((e) => (e.type === 'bloc' || e.type === 'scenario' ? [e.workflowId] : [])))];
}

/** L'outil finit-il par lancer un scénario ? (un dépassement de délai le traite alors comme un lancement abouti). */
export function lanceUnScenario(etapes: readonly EtapeEnchainement[]): boolean {
  return etapes.some((e) => e.type === 'scenario');
}

/**
 * 🔴 LES PARAMÈTRES QUE LE MODÈLE REMPLIT, dérivés des étapes et jamais stockés : un par question, facultatif, borné à
 * ses valeurs permises ; plus `deja_demande`, requis, dès qu'il y a une question. Annoncés au modèle ET appliqués par la
 * validation de `executeTool` (`paramsEffectifs`) : toute borne appliquée est annoncée.
 */
export function paramsDeLEnchainement(etapes: readonly EtapeEnchainement[]): ParamOutil[] {
  const questions = etapes.flatMap((e) => (e.type === 'demander' ? [e] : []));
  if (questions.length === 0) return [];
  return [
    ...questions.map((q): ParamOutil => ({
      name: q.champ, type: 'string', source: 'modele', required: false,
      description: `${q.question}${q.valeurs.length > 0 ? '' : ` (${BORNES_ENCHAINEMENT.texte} caractères au plus)`}. Omets ce paramètre si le contact ne l'a pas donné : n'invente jamais une valeur.`,
      ...(q.valeurs.length > 0 ? { enum: [...q.valeurs] } : {}),
    })),
    {
      name: PARAM_DEJA_DEMANDE, type: 'boolean', source: 'modele', required: true,
      description: 'true si tu as déjà demandé au contact les informations qui manquent (il a répondu, en partie ou pas, refusé ou insisté) ; false au premier appel.',
    },
  ];
}

const DIT_DE_L_ETAPE: Readonly<Record<TypeEtape, (e: EtapeEnchainement) => string>> = {
  demander: (e) => (e.type === 'demander' ? `enregistre « ${e.question} »` : ''),
  valeur: () => 'met à jour la fiche du contact',
  tag: () => 'pose une étiquette sur le contact',
  urgent: () => 'marque la conversation urgente pour l’équipe',
  bloc: () => 'envoie un message prévu au contact',
  scenario: () => 'lance un scénario qui prend la conversation : tu te retires et n’écris plus rien',
};

/**
 * Ce que le modèle lit de l'outil en plus de « quand l'appeler » : les étapes dans l'ordre, et la règle de la question
 * unique. Les noms internes (tag, scénario) ne sont jamais dits : le modèle les répéterait au contact.
 */
export function motsDeLEnchainement(etapes: readonly EtapeEnchainement[]): string {
  const liste = etapes.map((e, i) => `${i + 1}) ${DIT_DE_L_ETAPE[e.type](e)}`).join(' ; ');
  const aDesQuestions = etapes.some((e) => e.type === 'demander');
  return `\n\nCet outil fait, dans l’ordre : ${liste}.`
    + (aDesQuestions
      ? '\nPasse les informations que le contact a DÉJÀ données dans la conversation. S’il en manque, l’outil te dit lesquelles : demande-les en UN seul message, puis rappelle l’outil avec ses réponses et deja_demande à true. Ne demande jamais deux fois : s’il refuse, répond en partie ou insiste, rappelle l’outil tout de suite avec deja_demande à true.'
      : '');
}

/** Ce que l'outil décide de faire de cet appel. */
export type PlanEnchainement =
  /** Rien n'est exécuté : l'agent pose ces questions au contact, en un message. */
  | { quoi: 'demander'; questions: string[] }
  /** Tout s'exécute dans l'ordre, avec les valeurs disponibles (une question restée sans réponse est sautée). */
  | { quoi: 'executer'; valeurs: ReadonlyMap<string, string> };

function texte(args: Record<string, unknown>, cle: string): string {
  const v = args[cle];
  return typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim();
}

/**
 * LA DÉCISION, pure, partagée par la production et le bac à sable (un bac à sable qui jugerait autrement ne prouverait
 * rien). Une valeur hors liste ne compte pas comme donnée : la validation l'a déjà refusée en amont, et la recompter ici
 * ne dépend d'aucun câblage.
 */
export function planEnchainement(etapes: readonly EtapeEnchainement[], args: Record<string, unknown>): PlanEnchainement {
  const valeurs = new Map<string, string>();
  const manquantes: string[] = [];
  for (const e of etapes) {
    if (e.type !== 'demander') continue;
    // Trop long, ramené à la borne annoncée (de l'hygiène, pas une frontière : on garde la réponse du contact).
    const v = texte(args, e.champ).slice(0, BORNES_ENCHAINEMENT.texte);
    if (v !== '' && (e.valeurs.length === 0 || e.valeurs.includes(v))) valeurs.set(e.champ, v);
    else manquantes.push(e.question);
  }
  if (manquantes.length > 0 && args[PARAM_DEJA_DEMANDE] !== true) return { quoi: 'demander', questions: manquantes };
  return { quoi: 'executer', valeurs };
}

/** Ce que le modèle lit quand l'outil lui rend des questions. */
export function consigneDeQuestions(questions: readonly string[]): Record<string, unknown> {
  return {
    a_demander: questions,
    consigne: 'Rien n’est encore fait. Demande ces informations au contact en UN seul message, dans tes mots, puis rappelle cet outil avec ses réponses et deja_demande à true, même s’il refuse ou n’en donne qu’une partie.',
  };
}
