import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * LE DICTIONNAIRE DES SIGNAUX (spec 2026-09-24, § 8) : ce que la console remonte vers l'outil d'un client
 * (plateforme d'orchestration, CRM, outil marketing) quand il se passe quelque chose sur une fiche.
 *
 * 🔴 INDÉPENDANT DE TOUT OUTIL CIBLE, et c'est sa raison d'être. Ce fichier dit CE QUI S'EST PASSÉ et SOUS
 * QUELS NOMS ça part (événements, attributs, champs de chaque événement) : un ADAPTATEUR par outil (dans ce
 * dossier) le traduit dans le format de son outil, sans l'étendre ni le renommer. Rien ici n'importe un
 * adaptateur, et la documentation publique le décrit sans nommer aucun outil
 * (`web/lib/signaux-dictionnaire.ts`, parité tenue par `tests/web-signaux-parite.test.ts`).
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
] as const;
export type NomEvenement = (typeof NOMS_EVENEMENTS)[number];

/** L'état courant d'une fiche, poussé AVEC les événements. */
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
] as const;
export type NomAttribut = (typeof NOMS_ATTRIBUTS)[number];

export const CANAUX_SIGNAL = ['whatsapp', 'rcs'] as const;
export type CanalSignal = (typeof CANAUX_SIGNAL)[number];

/** La source d'un désabonnement dit STOP sur le canal RCS, pendant de `SOURCE_STOP_WHATSAPP`. */
export const SOURCE_STOP_RCS = 'rcs_stop';

/**
 * Un texte de signal tient en 300 caractères, et n'est jamais vide : la borne la plus stricte des outils connus,
 * appliquée au dictionnaire lui-même pour que tout adaptateur le transporte tel quel.
 */
export const TEXTE_SIGNAL_MAX = 300;

/**
 * 🔴 LE RÉSUMÉ D'UNE CONVERSATION VOYAGE EN MORCEAUX. Il fait jusqu'à 800 caractères côté analyse
 * (`llmOutputSchema.summary`), donc plus que `TEXTE_SIGNAL_MAX` : il part en morceaux CONSÉCUTIFS, à recoller
 * bout à bout, sans séparateur. Le borner à 300 aurait jeté la fin de deux résumés sur trois (« 2 à 3
 * phrases », consigne du prompt), et le laisser entier le ferait refuser par l'outil, en silence. Le nombre de
 * morceaux est tenu par un test qui le DÉRIVE de la borne de l'analyse.
 */
export const MORCEAUX_RESUME = ['summary_1', 'summary_2', 'summary_3'] as const;

/** L'identifiant stable d'un événement (`idSignal`), présent sur CHAQUE événement. */
export const CHAMP_ID_EVENEMENT = 'em_event_id';

/**
 * 🔴 LES NOMS DES CHAMPS DE CHAQUE ÉVÉNEMENT, tels qu'ils partent chez l'outil, QUEL QU'IL SOIT.
 *
 * Ils vivent ICI et pas dans un adaptateur : la documentation publique annonce qu'ils « restent les mêmes quel
 * que soit l'outil », donc un second adaptateur ne peut pas les renommer. Un adaptateur les consomme par leur
 * TYPE (`ChampEvenement`) : un nom qui n'est pas dans cette liste ne compile pas. La page de documentation est
 * tenue à cette liste par `tests/web-signaux-parite.test.ts`. `CHAMP_ID_EVENEMENT` s'ajoute à chacun.
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
} as const satisfies Record<NomEvenement, readonly string[]>;
export type ChampEvenement<N extends NomEvenement> = (typeof CHAMPS_EVENEMENT)[N][number];

/**
 * Le libellé d'une poussée ratée dans Sécurité > Journal des erreurs, LE MÊME pour tout adaptateur.
 *
 * 🔴 IL NE NOMME AUCUN OUTIL : la spec (§ 10) réserve le nom de l'outil à l'écran de réglage de son adaptateur,
 * et le journal est lu par la marque, pas seulement par l'intégrateur qui a branché l'outil.
 */
export const NOM_APPEL_SIGNAUX = 'Outil branché (Paramètres > Intégrations) : mise à jour des profils';

/**
 * Au plus autant de signaux par job. Une action en masse (un désabonnement de milliers de fiches, écrit dans la
 * requête HTTP d'un opérateur) s'enfile donc en quelques jobs, et non en un enfilement par fiche.
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
 * L'identifiant STABLE d'un signal, qui voyage comme `em_event_id`.
 *
 * 🔴 IL EST FIGÉ À L'ÉMISSION, DANS LE JOB : une poussée rejouée par la file porte donc le même, et l'outil du
 * client peut dédupliquer. Avec une CLÉ NATURELLE (l'identifiant que Meta ou le fournisseur RCS a donné au
 * message), il reste le même quand le fournisseur nous redélivre son webhook.
 *
 * ⚠️ OPAQUE, et pas la clé elle-même : un identifiant de message WhatsApp encode le numéro du destinataire,
 * qui n'a rien à faire dans un identifiant d'événement.
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
 * Ce que le CHEMIN CHAUD émet : ce qu'il sait déjà, rien de plus. La fiche, l'origine du message et l'analyse
 * se relisent au moment de pousser (`completerSignal`), jamais sur un accusé de livraison.
 *
 * `.strict()` partout : le job se relit depuis la file comme une entrée externe, et une clé en trop dit qu'un
 * émetteur et le lecteur ne parlent plus du même contrat.
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
   * ⚠️ Ici, `canal` dit QUEL CONSENTEMENT l'écriture a retiré : `whatsapp` pour `opt_in_status` (le dépôt des
   * contacts), `rcs` pour `rcs_optout_at` (le STOP RCS). Ce n'est PAS le canal sur lequel la personne a parlé :
   * celui-là se déduit de la source au moment de pousser (`completerSignal`), et reste absent quand le refus
   * vient de la console ou de l'API.
   */
  z.object({ nom: z.literal('em_opted_out'), id, le, waId, canal }).strict(),
  z.object({ nom: z.literal('em_conversation_analyzed'), id, le, conversationId: z.string().uuid() }).strict(),
]);
export type Signal = z.infer<typeof schemaSignal>;

/** Un job : UN espace, de 1 à `SIGNAUX_PAR_JOB` signaux. */
export const schemaJobSignaux = z.object({
  tenantId: z.string().uuid(),
  signaux: z.array(schemaSignal).min(1).max(SIGNAUX_PAR_JOB),
}).strict();
export type JobSignaux = z.infer<typeof schemaJobSignaux>;

/** La fiche d'un signal, telle qu'un adaptateur la voit : identifiants et consentement COURANT. */
export interface ContactDuSignal {
  contactId: string;
  /** L'identifiant de l'outil du client (`contacts.external_id`). `null` = la fiche ne peut pas être poussée. */
  externalId: string | null;
  optOutWhatsapp: boolean;
  optOutRcs: boolean;
}

/**
 * L'identifiant sous lequel une fiche se pousse chez l'outil, ou `null` : elle ne peut pas l'être.
 *
 * UNE règle pour ses deux lecteurs : le complément (`completerSignal`), qui ne relit pas ce qui ne servirait qu'à
 * une poussée qui n'aura pas lieu, et l'adaptateur, qui compte la fiche au lieu de la pousser. Écrite deux fois,
 * elle divergerait sur un identifiant fait d'espaces.
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
   * `canal` : le canal sur lequel la personne a DIT STOP, et SEULEMENT celui-là. Un refus posé par la console,
   * une action en masse ou l'API n'a pas de canal (`null`) : l'annoncer `whatsapp` ferait croire à l'intégrateur
   * que le contact a écrit STOP. `source` dit toujours d'où vient le refus (`opt_in_source`, ou `rcs_stop`).
   */
  | { nom: 'em_opted_out'; canal: CanalSignal | null; source: string | null }
  | { nom: 'em_conversation_analyzed'; analyse: AnalyseDuSignal };

/** Ce qu'un adaptateur reçoit : le signal émis, complété de ce que le chemin chaud ne savait pas. */
export interface SignalComplet {
  id: string;
  le: string;
  contact: ContactDuSignal;
  contenu: ContenuSignal;
}
