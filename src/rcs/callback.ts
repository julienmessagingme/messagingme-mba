import { z } from 'zod';

/**
 * Rapports de livraison (DLR) et messages entrants (MO) du canal RCS smsmode. Module pur : il traduit un
 * corps HTTP non fiable en fait métier, écrit contre leur spec (`dev.smsmode.com/rcs/openapi/rest-rcs.yml`).
 *
 * Trois traits de leur contrat commandent ce fichier :
 * 1. 🔴 aucune signature (ni HMAC, ni jeton d'en-tête) : ce qui authentifie l'appel est le code opaque de
 *    l'URL (`rcs_agents.webhook_code`), doublé du contrôle que le `channelId` du corps est celui de l'agent
 *    du workspace. Ce fichier ne fait que lire ; ces deux gardes, tenues par la route, autorisent ;
 * 2. rejeux garantis (six fois, jusqu'à 24 h, tant qu'ils n'ont pas un 2xx) : tout traitement en aval doit
 *    être idempotent ;
 * 3. énumération incomplète (`READ` existe hors de la liste documentée) : un statut inconnu rend `null` et
 *    n'est jamais un échec, sinon le contact basculerait en repli WhatsApp et recevrait deux fois le message.
 */

/**
 * Adresse publique des rappels d'un workspace. `baseApi` est `adressesPubliques(...).avecPrefixe`, jamais
 * `APP_URL` : cette route est servie par l'API, et le front sur Vercel ne la relaie pas. Une adresse morte
 * ici coupe tous les rapports de livraison et toutes les réponses RCS.
 */
export function urlRappelRcs(baseApi: string, code: string): string {
  return `${baseApi.replace(/\/+$/, '')}/rcs/callback/${code}`;
}

/** Statut de livraison dans notre modèle : la même échelle que les accusés Meta, une seule dans le produit. */
export type RcsDeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface RcsDlr {
  /** Identifiant smsmode du message sortant. C'est la clé qui recolle l'accusé au destinataire de campagne. */
  messageId: string;
  /** Canal (= agent) émetteur. Deuxième garde d'isolation : il doit être celui du workspace porté par le code. */
  channelId: string | null;
  /** Destinataire en chiffres nus, tel qu'ils l'envoient. */
  to: string;
  /** null = statut hors énumération connue : on n'écrit rien plutôt que d'inventer. */
  status: RcsDeliveryStatus | null;
  /**
   * Le message n'atteindra jamais ce numéro (UNDELIVERABLE / UNDELIVERED) : le signal qui alimente la sortie
   * « non joignable » du bloc, la joignabilité se constatant après l'envoi chez smsmode.
   */
  echecDefinitif: boolean;
  /** Motif d'échec (`INVALID_PHONE_NUMBER`, `BLACKLISTED`, `SPAM`…), tel quel. */
  detail: string | null;
  /** Notre référence, posée à l'envoi (`refClient`). Utile au débogage, jamais à l'autorisation. */
  refClient: string | null;
}

export interface RcsMo {
  messageId: string;
  channelId: string | null;
  /** Expéditeur en chiffres nus : c'est le contact. */
  from: string;
  /** Message sortant auquel il répond, quand ils le fournissent. */
  originMessageId: string | null;
  kind: 'text' | 'suggestion' | 'location' | 'file';
  /** Texte du message, ou libellé du bouton tapé. null pour une position ou un fichier. */
  text: string | null;
  /** Charge utile du bouton tapé (`kind === 'suggestion'`). C'est elle qui choisit la branche du scénario. */
  postbackData: string | null;
  /**
   * Position partagée (`kind === 'location'`). Elle arrive sans texte ni charge utile : un bouton « Demander la
   * position » ne peut donc pas ouvrir une branche, et sans ces coordonnées la réponse serait une bulle vide.
   */
  latitude: number | null;
  longitude: number | null;
  /** Fichier envoyé par le contact (`kind === 'file'`). Même raison : sans l'adresse, la pièce est perdue. */
  fileUrl: string | null;
  filename: string | null;
}

/** Enveloppe commune aux deux rappels. `passthrough` : leur corps porte bien plus que ce qu'on lit, et une
 *  clé inattendue ne doit pas faire échouer la lecture d'un rappel par ailleurs valide. */
const enveloppe = z.object({
  messageId: z.string().min(1),
  direction: z.string().optional(),
  channel: z.object({ channelId: z.string().optional() }).partial().passthrough().optional(),
  recipient: z.object({ to: z.string().optional() }).partial().passthrough().optional(),
  from: z.string().optional(),
  refClient: z.string().optional(),
  originMessageId: z.string().optional(),
}).passthrough();

const corpsDlr = z.object({
  status: z.object({
    value: z.string().optional(),
    detail: z.string().optional(),
  }).partial().passthrough(),
}).passthrough();

const corpsMo = z.object({
  body: z.object({
    type: z.string().optional(),
    text: z.string().optional(),
    postbackData: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    fileUrl: z.string().optional(),
    filename: z.string().optional(),
  }).partial().passthrough(),
}).passthrough();

/**
 * Statut smsmode -> statut du produit. `SCHEDULED`/`ENROUTE` = accepté mais pas encore remis, c'est notre
 * `sent`. Le reste est explicite. Inconnu -> null (cf. point 3 de l'en-tête).
 */
export function statutDepuisSmsmode(v: string): RcsDeliveryStatus | null {
  switch (v.toUpperCase()) {
    case 'SCHEDULED':
    case 'ENROUTE':
      return 'sent';
    case 'DELIVERED':
      return 'delivered';
    case 'READ':
      return 'read';
    case 'UNDELIVERABLE':
    case 'UNDELIVERED':
      return 'failed';
    default:
      return null;
  }
}

/** Chiffres nus d'un numéro, quelle que soit la forme reçue (`+33…`, espaces). */
export function chiffresNus(s: string): string {
  return s.replace(/[^0-9]/g, '');
}

/**
 * Le numéro du contact, parmi les champs d'identité d'un rappel. Leur documentation met le contact dans
 * `from` ; la production garde l'orientation du message sortant même sur un entrant (`from` = l'agent,
 * `recipient.to` = le contact). On se fie donc à la forme, pas à la position : le premier candidat qui porte
 * au moins 7 chiffres.
 */
export function numeroDuContact(...candidats: Array<string | undefined>): string | null {
  for (const brut of candidats) {
    const chiffres = chiffresNus(brut ?? '');
    if (chiffres.length >= 7) return chiffres;
  }
  return null;
}

/**
 * Ce corps est-il un rapport de livraison ? Le discriminant est la présence d'un `status.value`, pas
 * `direction` : un vrai DLR sans `direction: 'MT'` tomberait sinon dans le lecteur de MO et finirait « non
 * exploitable ». Un `direction: 'MO'` explicite tranche en sens inverse.
 */
export function estDlr(raw: unknown): boolean {
  const e = enveloppe.safeParse(raw);
  if (e.success && (e.data.direction ?? '').toUpperCase() === 'MO') return false;
  const d = corpsDlr.safeParse(raw);
  return d.success && typeof d.data.status.value === 'string' && d.data.status.value !== '';
}

/** Rapport de livraison, ou null si le corps n'en est pas un exploitable. Ne lève jamais. */
export function parseRcsDlr(raw: unknown): RcsDlr | null {
  const e = enveloppe.safeParse(raw);
  if (!e.success) return null;
  const d = corpsDlr.safeParse(raw);
  if (!d.success) return null;
  const valeur = d.data.status.value ?? '';
  const statut = valeur === '' ? null : statutDepuisSmsmode(valeur);
  return {
    messageId: e.data.messageId,
    channelId: e.data.channel?.channelId ?? null,
    to: chiffresNus(e.data.recipient?.to ?? ''),
    status: statut,
    // Seulement sur les deux valeurs d'échec connues : un statut inconnu n'est pas un échec.
    echecDefinitif: statut === 'failed',
    detail: d.data.status.detail ?? null,
    refClient: e.data.refClient ?? null,
  };
}

/** Message entrant, ou null si le corps n'en est pas un exploitable. Ne lève jamais. */
export function parseRcsMo(raw: unknown): RcsMo | null {
  const e = enveloppe.safeParse(raw);
  if (!e.success) return null;
  const m = corpsMo.safeParse(raw);
  if (!m.success) return null;
  // Le contact est `from` ou `recipient.to` selon l'orientation du corps : c'est la forme qui tranche.
  const from = numeroDuContact(e.data.from, e.data.recipient?.to);
  if (from === null) return null; // aucun numéro : rien à rattacher, ni contact, ni parcours
  const type = (m.data.body.type ?? '').toUpperCase();
  const kind = type === 'SUGGESTION' ? 'suggestion'
    : type === 'LOCATION' ? 'location'
      : type === 'FILE' ? 'file'
        : 'text';
  return {
    messageId: e.data.messageId,
    channelId: e.data.channel?.channelId ?? null,
    from,
    originMessageId: e.data.originMessageId ?? null,
    kind,
    text: m.data.body.text ?? null,
    postbackData: kind === 'suggestion' ? (m.data.body.postbackData ?? null) : null,
    latitude: kind === 'location' ? (m.data.body.latitude ?? null) : null,
    longitude: kind === 'location' ? (m.data.body.longitude ?? null) : null,
    fileUrl: kind === 'file' ? (m.data.body.fileUrl ?? null) : null,
    filename: kind === 'file' ? (m.data.body.filename ?? null) : null,
  };
}

/**
 * Ce qui s'affiche dans le fil d'inbox pour un message entrant : une position ou un fichier n'ont pas de
 * texte, et sans cette mise en forme les coordonnées ou l'adresse du fichier seraient perdues.
 */
export function apercuMo(mo: RcsMo): string {
  if (mo.kind === 'location') {
    return mo.latitude !== null && mo.longitude !== null
      ? `📍 ${mo.latitude}, ${mo.longitude}`
      : '📍 position partagée';
  }
  if (mo.kind === 'file') {
    return [mo.filename, mo.fileUrl].filter((x) => x !== null && x !== '').join(' ') || '📎 fichier reçu';
  }
  return mo.text ?? `[${mo.kind}]`;
}

// 🔴 `estDemandeArret` vit dans `src/crm/consentement.ts` : le prédicat du STOP appartient au consentement,
// pas au canal, pour que WhatsApp et RCS désabonnent pareil.
