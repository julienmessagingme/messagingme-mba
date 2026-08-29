import { z } from 'zod';

/**
 * Rapports de livraison (DLR) et messages entrants (MO) du canal RCS smsmode.
 *
 * Module PUR : il traduit un corps HTTP non fiable en fait métier, sans aucune IO. Écrit contre leur spec
 * (`dev.smsmode.com/rcs/openapi/rest-rcs.yml`, lue à la source le 2026-08-24), pas de mémoire.
 *
 * Trois traits de leur contrat commandent tout ce fichier :
 *
 * 1. AUCUNE SIGNATURE. smsmode ne signe pas ses rappels : ni HMAC, ni jeton d'en-tête. Ce qui authentifie
 *    l'appel est donc le CODE opaque de l'URL (`rcs_agents.webhook_code`), doublé du contrôle que le
 *    `channelId` du corps est bien celui de l'agent de ce workspace. Ce fichier ne fait que LIRE ; ce sont
 *    ces deux gardes, tenues par la route, qui autorisent.
 * 2. REJEUX GARANTIS. Ils réessaient six fois (30 s, 2 min, 10 min, 1 h, 5 h, 24 h) tant qu'ils n'ont pas
 *    reçu un 2xx. Tout traitement en aval doit être idempotent, jamais « une fois exactement ».
 * 3. ÉNUMÉRATION INCOMPLÈTE. `READ` existe en vrai et n'est PAS dans l'énumération documentée. Un statut
 *    inconnu rend donc `null` (aucune écriture) et n'est JAMAIS traité comme un échec : croire un message
 *    perdu parce qu'on ne connaît pas son statut ferait basculer le contact en repli WhatsApp pour rien,
 *    et lui enverrait deux fois le même message.
 */

/**
 * Adresse publique des rappels d'un workspace.
 *
 * Le `/api/backend` n'est pas un détail : l'API Fastify n'a AUCUN port publié, et la seule chose que le proxy
 * public route est le front, qui réécrit ce préfixe vers elle. Une URL sans lui n'arrive nulle part. Même
 * chemin d'exposition que les webhooks entrants de Tools.
 */
export function urlRappelRcs(appUrl: string, code: string): string {
  return `${appUrl.replace(/\/+$/, '')}/api/backend/rcs/callback/${code}`;
}

/** Statut de livraison dans NOTRE modèle : la même échelle que les accusés Meta, une seule dans le produit. */
export type RcsDeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface RcsDlr {
  /** Identifiant smsmode du message sortant. C'est la clé qui recolle l'accusé au destinataire de campagne. */
  messageId: string;
  /** Canal (= agent) émetteur. Deuxième garde d'isolation : il doit être celui du workspace porté par le code. */
  channelId: string | null;
  /** Destinataire en chiffres nus, tel qu'ils l'envoient. */
  to: string;
  /** null = statut hors énumération connue -> on n'écrit rien plutôt que d'inventer. */
  status: RcsDeliveryStatus | null;
  /**
   * Le message n'atteindra JAMAIS ce numéro (UNDELIVERABLE / UNDELIVERED). C'est LE signal qui alimente la
   * sortie « non joignable » du bloc : chez smsmode la joignabilité ne se demande pas avant l'envoi, elle se
   * constate après.
   */
  echecDefinitif: boolean;
  /** Motif d'échec (`INVALID_PHONE_NUMBER`, `BLACKLISTED`, `SPAM`…), tel quel. */
  detail: string | null;
  /** NOTRE référence, posée à l'envoi (`refClient`). Utile au débogage, jamais à l'autorisation. */
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
   * Position partagée par le contact (`kind === 'location'`). Elle arrive SANS texte et SANS charge utile :
   * c'est la raison pour laquelle un bouton « Demander la position » ne peut pas ouvrir une branche de
   * scénario, et pour laquelle il faut garder ces coordonnées ici, sinon la réponse ne serait qu'une bulle
   * vide dans l'inbox.
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
 * Le NUMÉRO du contact, parmi les champs d'identité d'un rappel.
 *
 * 🔴 Pourquoi ce n'est pas simplement `from`. Leur documentation montre un message entrant avec
 * `from: "33600000000"` (le contact) et `recipient.to: "RcsAgent"`. La PRODUCTION fait l'inverse : le corps
 * réel d'un clic sur un bouton porte `from: "Messaging Me (TEST)"` (l'agent) et `recipient.to:
 * "33633921577"` (le contact). Autrement dit ils gardent l'orientation du message SORTANT même sur un
 * entrant, à l'opposé de leur propre exemple.
 *
 * Conséquence vécue le 2026-08-24 : deux clics de Julien ont été reçus, rejetés, et le scénario est resté
 * bloqué sans que rien ne le dise. On ne se fie donc plus à la POSITION du champ mais à sa FORME : on prend
 * le premier des deux qui ressemble à un numéro. Un nom d'agent n'a pas 7 chiffres, un numéro les a tous.
 */
export function numeroDuContact(...candidats: Array<string | undefined>): string | null {
  for (const brut of candidats) {
    const chiffres = chiffresNus(brut ?? '');
    if (chiffres.length >= 7) return chiffres;
  }
  return null;
}

/**
 * Ce corps est-il un rapport de livraison ?
 *
 * 🔴 Le discriminant est la PRÉSENCE d'un `status.value`, pas `direction`. Première version : `direction ===
 * 'MT'`. Un vrai rappel de production a été rejeté le 2026-08-24 par cette règle, et la conséquence était
 * silencieuse : le corps tombait dans le lecteur de messages ENTRANTS, qui exige un expéditeur numérique,
 * n'en trouvait pas (l'expéditeur d'un MT est le nom de l'agent), et le rappel finissait « non exploitable ».
 *
 * Un rapport de livraison porte toujours son statut ; un message entrant n'en a jamais. C'est donc ce que
 * l'on regarde, et un `direction: 'MO'` explicite tranche en sens inverse par sécurité.
 */
export function estDlr(raw: unknown): boolean {
  const e = enveloppe.safeParse(raw);
  if (e.success && (e.data.direction ?? '').toUpperCase() === 'MO') return false;
  const d = corpsDlr.safeParse(raw);
  return d.success && typeof d.data.status.value === 'string' && d.data.status.value !== '';
}

/** Rapport de livraison, ou null si le corps n'en est pas un exploitable. Ne lève JAMAIS. */
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
    // UNIQUEMENT sur les deux valeurs d'échec CONNUES. Un statut inconnu n'est pas un échec.
    echecDefinitif: statut === 'failed',
    detail: d.data.status.detail ?? null,
    refClient: e.data.refClient ?? null,
  };
}

/** Message entrant, ou null si le corps n'en est pas un exploitable. Ne lève JAMAIS. */
export function parseRcsMo(raw: unknown): RcsMo | null {
  const e = enveloppe.safeParse(raw);
  if (!e.success) return null;
  const m = corpsMo.safeParse(raw);
  if (!m.success) return null;
  // Le contact est `from` OU `recipient.to` selon l'orientation que le fournisseur donne au corps : les deux
  // sont acceptés, c'est la FORME qui tranche (cf. `numeroDuContact`).
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
 * Le contact demande-t-il l'arrêt ?
 *
 * Obligation légale ET condition de survie de l'agent : un opérateur suspend une marque qui continue
 * d'écrire après un STOP. On reconnaît donc le mot seul ou en tête de message, dans les deux langues, sans
 * exiger une forme exacte. Volontairement STRICT sur la position : un message qui CONTIENT « stop » au
 * milieu d'une phrase (« je ne peux pas stopper là ») n'est pas une demande d'arrêt, et désabonner un
 * contact à tort est une faute symétrique.
 */
/**
 * Ce qui s'affiche dans le fil d'inbox pour un message entrant.
 *
 * Une position et un fichier n'ont pas de texte : sans cette mise en forme, leur bulle serait vide et
 * l'information (les coordonnées, l'adresse du fichier) serait définitivement perdue, alors que c'est
 * exactement ce que l'opérateur a demandé au contact en posant le bouton.
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

// 🔴 `estDemandeArret` a DÉMÉNAGÉ le 2026-08-29 vers `src/crm/consentement.ts`. Il ne servait qu'au RCS parce
// qu'il vivait ici, et c'est exactement ce qui a produit l'asymétrie : STOP désabonnait en RCS et ne faisait
// rien en WhatsApp. Le prédicat appartient au consentement, pas au canal.
