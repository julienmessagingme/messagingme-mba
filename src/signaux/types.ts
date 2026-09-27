import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAX_RAISONS, NIVEAUX_RISQUE, RAISONS_RISQUE, SCORE_MAX, type NiveauRisque, type RaisonRisque } from '../engagement/risque';

/**
 * Le dictionnaire des signaux : ce que la console remonte vers l'outil d'un client (orchestration, CRM, outil
 * marketing) quand il se passe quelque chose sur une fiche.
 *
 * Indépendant de tout outil cible : ce fichier dit ce qui s'est passé et sous quels noms ça part. Un adaptateur
 * par outil le traduit sans l'étendre ni le renommer, et rien ici n'importe un adaptateur. La documentation
 * publique le décrit sans nommer d'outil (`web/lib/signaux-dictionnaire.ts`, parité par
 * `tests/web-signaux-parite.test.ts`).
 */

/** Préfixe `em_`, 30 caractères au plus, `[a-z0-9_]` : la règle de nom la plus stricte des outils connus. */
export const NOM_DICTIONNAIRE_RE = /^em_[a-z0-9_]{1,27}$/;
/** La clé d'un champ d'événement : la même règle, sans le préfixe. */
export const CHAMP_RE = /^[a-z0-9_]{1,30}$/;

export const NOMS_EVENEMENTS = [
  'em_message_delivered',
  'em_message_read',
  'em_message_failed',
  'em_replied',
  'em_link_clicked',
  'em_opted_out',
  'em_conversation_analyzed',
  'em_risk_changed',
] as const;
export type NomEvenement = (typeof NOMS_EVENEMENTS)[number];

/** L'état courant d'une fiche, poussé avec les événements. */
export const NOMS_ATTRIBUTS = [
  'em_contact_id',
  'em_last_intent',
  'em_last_sentiment',
  'em_satisfaction',
  'em_urgency',
  'em_last_resolved',
  'em_last_reply_at',
  'em_whatsapp_optout',
  'em_rcs_optout',
  'em_rcs_reachable',
  'em_risk_level',
  'em_risk_score',
  'em_risk_reasons',
] as const;

export const CANAUX_SIGNAL = ['whatsapp', 'rcs'] as const;
export type CanalSignal = (typeof CANAUX_SIGNAL)[number];

/** La source d'un désabonnement dit STOP sur le canal RCS, pendant de `SOURCE_STOP_WHATSAPP`. */
export const SOURCE_STOP_RCS = 'rcs_stop';

/**
 * Un texte de signal tient en 300 caractères et n'est jamais vide : la borne la plus stricte des outils connus,
 * appliquée au dictionnaire pour que tout adaptateur le transporte tel quel.
 */
export const TEXTE_SIGNAL_MAX = 300;

/**
 * Le résumé d'une conversation (jusqu'à 800 caractères, `llmOutputSchema.summary`) voyage en morceaux consécutifs,
 * à recoller sans séparateur : borné à 300 il perdrait sa fin, entier il serait refusé par l'outil en silence.
 * Le nombre de morceaux est tenu par un test qui le dérive de la borne de l'analyse.
 */
export const MORCEAUX_RESUME = ['summary_1', 'summary_2', 'summary_3'] as const;

/** L'identifiant stable d'un événement (`idSignal`), présent sur chaque événement. */
export const CHAMP_ID_EVENEMENT = 'em_event_id';

/**
 * Les noms des champs de chaque événement, tels qu'ils partent chez l'outil, quel qu'il soit : la documentation
 * promet qu'ils restent les mêmes, donc ils vivent ici et pas dans un adaptateur. Un adaptateur les consomme par
 * leur type (`ChampEvenement`) : un nom hors liste ne compile pas. Parité avec la documentation par
 * `tests/web-signaux-parite.test.ts`. `CHAMP_ID_EVENEMENT` s'ajoute à chacun.
 */
export const CHAMPS_EVENEMENT = {
  em_message_delivered: ['canal', 'origine', 'send_id'],
  em_message_read: ['canal', 'origine', 'send_id'],
  em_message_failed: ['canal', 'origine', 'send_id', 'motif', 'code_meta'],
  em_replied: ['canal', 'bouton'],
  em_link_clicked: ['lien', 'template', 'destination'],
  em_opted_out: ['canal', 'source'],
  em_conversation_analyzed: [
    'intent', 'sentiment', 'satisfaction', 'urgence', 'resolved', 'topic', 'action_suggestion', 'handled_by',
    'exchanges_count', ...MORCEAUX_RESUME,
  ],
  em_risk_changed: ['niveau', 'ancien_niveau', 'score', 'raisons'],
} as const satisfies Record<NomEvenement, readonly string[]>;
export type ChampEvenement<N extends NomEvenement> = (typeof CHAMPS_EVENEMENT)[N][number];

/**
 * Le libellé d'une poussée ratée dans le journal des erreurs, le même pour tout adaptateur. Il ne nomme aucun
 * outil : ce journal est lu par la marque, le nom de l'outil est réservé à l'écran de réglage de son adaptateur.
 */
export const NOM_APPEL_SIGNAUX = 'Outil branché (Paramètres > Intégrations) : mise à jour des profils';

/**
 * Au plus autant de signaux par job : une action en masse (désabonnement de milliers de fiches) s'enfile en
 * quelques jobs, et non en un enfilement par fiche.
 */
export const SIGNAUX_PAR_JOB = 200;

/** Borne un texte sans couper une paire de substitution : un emoji coupé en deux serait un caractère invalide. */
export function borneTexte(v: string, max: number = TEXTE_SIGNAL_MAX): string {
  if (v.length <= max) return v;
  const c = v.charCodeAt(max - 1);
  return v.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}

/** Le résumé en morceaux consécutifs de `TEXTE_SIGNAL_MAX` au plus, recollables bout à bout. */
export function morceauxDuResume(texte: string): string[] {
  const morceaux: string[] = [];
  let reste = texte;
  while (reste !== '' && morceaux.length < MORCEAUX_RESUME.length) {
    const m = borneTexte(reste);
    morceaux.push(m);
    reste = reste.slice(m.length);
  }
  return morceaux;
}

/**
 * L'identifiant stable d'un signal, qui voyage comme `em_event_id`.
 *
 * Figé à l'émission, dans le job : une poussée rejouée porte le même, et l'outil peut dédupliquer. Avec une clé
 * naturelle (l'identifiant du message chez Meta ou le fournisseur RCS), il survit aussi à un webhook redélivré.
 * Opaque, et pas la clé elle-même : un identifiant de message WhatsApp encode le numéro du destinataire.
 */
export function idSignal(nom: NomEvenement, cleNaturelle?: string): string {
  if (cleNaturelle === undefined) return randomUUID();
  return createHash('sha256').update(`${nom}:${cleNaturelle}`).digest('hex').slice(0, 32);
}

const id = z.string().regex(/^[0-9a-f-]{32,36}$/);
const le = z.string().min(1).max(40).refine((v) => !Number.isNaN(Date.parse(v)), { message: 'date illisible' });
const canal = z.enum(CANAUX_SIGNAL);
const waId = z.string().trim().min(1).max(64);
const messageId = z.string().min(1).max(200);

/**
 * Ce que le chemin chaud émet : ce qu'il sait déjà. La fiche, l'origine du message et l'analyse se relisent au
 * moment de pousser (`completerSignal`), jamais sur un accusé de livraison.
 * `.strict()` partout : le job se relit depuis la file comme une entrée externe, et une clé en trop dit que
 * l'émetteur et le lecteur ne parlent plus du même contrat.
 */
export const schemaSignal = z.discriminatedUnion('nom', [
  z.object({ nom: z.literal('em_message_delivered'), id, le, waId, canal, messageId }).strict(),
  z.object({ nom: z.literal('em_message_read'), id, le, waId, canal, messageId }).strict(),
  z.object({
    nom: z.literal('em_message_failed'), id, le, waId, canal, messageId,
    motif: z.string().max(500).nullable(),
    codeMeta: z.number().int().nullable(),
  }).strict(),
  z.object({ nom: z.literal('em_replied'), id, le, waId, canal, bouton: z.string().max(300).nullable() }).strict(),
  z.object({ nom: z.literal('em_link_clicked'), id, le, contactId: z.string().uuid(), lien: z.string().min(1).max(64) }).strict(),
  /**
   * Ici, `canal` dit quel consentement l'écriture a retiré (`whatsapp` pour `opt_in_status`, `rcs` pour
   * `rcs_optout_at`), pas le canal où la personne a parlé : celui-là se déduit de la source au moment de pousser.
   */
  z.object({ nom: z.literal('em_opted_out'), id, le, waId, canal }).strict(),
  z.object({ nom: z.literal('em_conversation_analyzed'), id, le, conversationId: z.string().uuid() }).strict(),
  /**
   * Le risque de désengagement a changé de niveau (balayage de nuit). Le calcul voyage dans le job : c'est ce que
   * le balayage a constaté à sa date. `ancienNiveau` à `null` = premier calcul.
   */
  z.object({
    nom: z.literal('em_risk_changed'), id, le, contactId: z.string().uuid(),
    niveau: z.enum(NIVEAUX_RISQUE),
    ancienNiveau: z.enum(NIVEAUX_RISQUE).nullable(),
    score: z.number().int().min(0).max(SCORE_MAX).nullable(),
    raisons: z.array(z.enum(RAISONS_RISQUE)).max(MAX_RAISONS),
  }).strict(),
]);
export type Signal = z.infer<typeof schemaSignal>;

/** Un job : un espace, de 1 à `SIGNAUX_PAR_JOB` signaux. */
export const schemaJobSignaux = z.object({
  tenantId: z.string().uuid(),
  signaux: z.array(schemaSignal).min(1).max(SIGNAUX_PAR_JOB),
}).strict();
export type JobSignaux = z.infer<typeof schemaJobSignaux>;

/** La fiche d'un signal, telle qu'un adaptateur la voit : identifiants et consentement courant. */
export interface ContactDuSignal {
  contactId: string;
  /** L'identifiant de l'outil du client (`contacts.external_id`). `null` = la fiche ne peut pas être poussée. */
  externalId: string | null;
  optOutWhatsapp: boolean;
  optOutRcs: boolean;
}

/**
 * L'identifiant sous lequel une fiche se pousse chez l'outil, ou `null` si elle ne peut pas l'être. Une seule
 * règle pour le complément (`completerSignal`) et l'adaptateur : écrite deux fois, elle divergerait sur un
 * identifiant fait d'espaces.
 */
export function identifiantPoussable(c: Pick<ContactDuSignal, 'externalId'>): string | null {
  const v = c.externalId?.trim() ?? '';
  return v === '' ? null : v;
}

/** Une analyse de conversation. `null` sur une note veut dire « pas de mesure », jamais 0. */
export interface AnalyseDuSignal {
  intent: string;
  sentiment: string;
  satisfaction: number | null;
  urgence: number | null;
  resolved: boolean;
  topic: string;
  actionSuggestion: string;
  handledBy: string;
  exchangesCount: number;
  /** Présent en base, mais un adaptateur ne l'envoie que si l'espace a coché l'option, et en morceaux (`morceauxDuResume`). */
  summary: string | null;
}

export type ContenuSignal =
  | { nom: 'em_message_delivered' | 'em_message_read'; canal: CanalSignal; origine: string | null; sendId: string | null }
  | { nom: 'em_message_failed'; canal: CanalSignal; origine: string | null; sendId: string | null; motif: string | null; codeMeta: number | null }
  | { nom: 'em_replied'; canal: CanalSignal; bouton: string | null }
  | { nom: 'em_link_clicked'; lien: string; template: string | null; destination: string | null }
  /**
   * `canal` : le canal sur lequel la personne a dit STOP, et seulement celui-là. Un refus posé par la console, une
   * action en masse ou l'API n'en a pas (`null`). `source` dit toujours d'où vient le refus.
   */
  | { nom: 'em_opted_out'; canal: CanalSignal | null; source: string | null }
  | { nom: 'em_conversation_analyzed'; analyse: AnalyseDuSignal }
  /** `score` à `null` et `raisons` vides veulent dire « aucun » : l'adaptateur efface alors l'attribut chez l'outil. */
  | { nom: 'em_risk_changed'; niveau: NiveauRisque; ancienNiveau: NiveauRisque | null; score: number | null; raisons: RaisonRisque[] };

/** Ce qu'un adaptateur reçoit : le signal émis, complété de ce que le chemin chaud ne savait pas. */
export interface SignalComplet {
  id: string;
  le: string;
  contact: ContactDuSignal;
  contenu: ContenuSignal;
}
