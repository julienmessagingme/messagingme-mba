import type { HttpTransport } from '../meta/http';
import type { RcsProvider, RcsOutbound, RcsCapabilities, RcsSuggestion, RcsCard } from './types';
import type { SendResult } from '../meta/types';

/**
 * Provider RCS smsmode (API REST RCS v1.8).
 *
 * Mesuré contre l'API réelle le 2026-08-24, avec l'agent « Messaging Me » et un envoi qui a été REÇU et LU :
 *
 * - L'authentification est une clé `X-Api-Key` RATTACHÉE À UN CANAL. Une clé liée au canal SMS répond
 *   403 « Channel type mismatch » sur l'API RCS. Il faut donc la clé du canal RCS, pas celle du compte.
 * - `POST /rcs/v1/messages` envoie via le canal lié à la clé. L'expéditeur est l'AGENT du canal
 *   (`defaultFromField`), jamais un numéro : rien à passer côté émetteur.
 * - Le destinataire est en CHIFFRES NUS, sans `+`.
 * - Le reporting est DIFFÉRÉ : juste après un 201, la fiche du message répond 404 et la liste est vide. Elle
 *   se peuple quelques minutes plus tard. On ne peut donc RIEN conclure d'un statut lu immédiatement.
 * - Le statut `READ` existe alors qu'il n'est PAS dans l'énumération documentée. Leur doc est incomplète :
 *   tout mapping de statut doit tolérer l'inconnu au lieu de le traiter comme un échec.
 */
export interface SmsmodeOptions {
  transport: HttpTransport;
  /**
   * Clé du CANAL RCS de repli, celle du serveur. Utilisée quand le tenant n'a pas la sienne. Secret : côté
   * serveur uniquement.
   */
  apiKey: string;
  /**
   * Clé PROPRE au tenant, déchiffrée à la demande. C'est le cas normal dès qu'il y a plus d'une marque :
   * chaque marque a son agent, son canal et sa clé. `null` -> repli sur la clé du serveur.
   */
  apiKeyFor?: (tenantId: string) => Promise<string | null>;
  /** URL publique qui recevra les rapports de livraison. Absente -> aucun rapport, la sortie
   *  « non joignable » du bloc restera donc muette. */
  callbackUrlStatus?: string;
  /** URL publique qui recevra les réponses entrantes (MO). */
  callbackUrlMo?: string;
  /**
   * Adresse de rappel PROPRE au workspace : rapports de livraison ET réponses sur la MÊME URL (leur corps
   * porte `direction`, MT ou MO, qui les distingue). C'est le cas normal, parce que smsmode ne signe pas ses
   * rappels : l'URL porte un code opaque par workspace, et c'est ce code qui dit à qui appartient l'appel.
   *
   * Résolue à CHAQUE envoi, jamais mémorisée : une réactivation du canal change le code, et un message parti
   * après doit porter la nouvelle adresse, sinon ses accusés reviennent frapper une porte fermée.
   */
  callbackUrlFor?: (tenantId: string) => Promise<string | null>;
  baseUrl?: string;
}

const BASE = 'https://rest.smsmode.com/rcs/v1';

/** Erreur d'API smsmode : porte le code HTTP et le code métier, pour que l'appelant décide (retry ou abandon). */
export class SmsmodeApiError extends Error {
  constructor(readonly status: number, readonly errorCode: string | null, message: string) {
    super(message);
    this.name = 'SmsmodeApiError';
  }
}

/** Suggestion interne -> suggestion smsmode. Leurs SIX types correspondent un pour un aux nôtres. */
function toSuggestion(s: RcsSuggestion): Record<string, unknown> {
  const base = { text: s.text, postbackData: s.postbackData };
  switch (s.kind) {
    case 'reply':
      return { type: 'REPLY', ...base };
    case 'openUrl':
      return { type: 'OPEN_URL', ...base, url: s.url };
    case 'dial':
      return { type: 'DIAL_PHONE', ...base, phoneNumber: s.phoneNumber };
    case 'calendar':
      return {
        type: 'CREATE_CALENDAR_EVENT', ...base,
        startTime: s.startAt, endTime: s.endAt, title: s.title,
        ...(s.description ? { description: s.description } : {}),
      };
    case 'showLocation':
      return {
        type: 'SHOW_LOCATION', ...base,
        latitude: s.latitude, longitude: s.longitude,
        ...(s.label ? { label: s.label } : {}),
      };
    default:
      return { type: 'REQUEST_LOCATION', ...base };
  }
}

/**
 * Carte interne -> `content` smsmode.
 *
 * 🔴 Les noms comptent, et ce mapping était FAUX avant d'être confronté à leur spec : on envoyait `card` au
 * lieu de `content`, `cards` au lieu de `contents`, et `media.url` au lieu de `media.fileUrl`. Aucun envoi
 * n'était concerné (l'écran ne produisait que du TEXTE), mais la première image envoyée se serait fait
 * refuser en 400. Vérifié contre `dev.smsmode.com/rcs/openapi/rest-rcs.yml` le 2026-08-24.
 */
function toCardContent(c: RcsCard): Record<string, unknown> {
  return {
    ...(c.title ? { title: c.title } : {}),
    ...(c.description ? { description: c.description } : {}),
    ...(c.mediaUrl ? { media: { fileUrl: c.mediaUrl, ...(c.mediaHeight ? { height: c.mediaHeight } : {}) } } : {}),
    ...(c.suggestions?.length ? { suggestions: c.suggestions.map(toSuggestion) } : {}),
  };
}

/** Message interne -> corps smsmode. Union FERMÉE : un `kind` inconnu est impossible par le typage. */
export function toSmsmodeBody(msg: RcsOutbound): Record<string, unknown> {
  if (msg.kind === 'text') {
    return {
      type: 'TEXT',
      text: msg.text,
      ...(msg.suggestions?.length ? { suggestions: msg.suggestions.map(toSuggestion) } : {}),
    };
  }
  if (msg.kind === 'card') {
    return {
      type: 'CARD',
      content: toCardContent(msg.card),
      // Orientation VERTICALE : l'image au-dessus du texte, pleine largeur. C'est la mise en page que tout le
      // monde a en tête en disant « une image en en-tête » ; HORIZONTAL colle une vignette sur le côté.
      orientation: 'VERTICAL',
      ...(msg.suggestions?.length ? { suggestions: msg.suggestions.map(toSuggestion) } : {}),
    };
  }
  return { type: 'CAROUSEL', contents: msg.cards.map(toCardContent) };
}

export class SmsmodeRcsProvider implements RcsProvider {
  /**
   * smsmode n'expose AUCUN endpoint de joignabilité : le `lookup` de leur API est l'opérateur du destinataire
   * renvoyé AVEC le rapport de livraison, donc après l'envoi. Vérifié dans leur spec et confirmé à l'usage.
   * Le sender saute donc la vérification préalable au lieu de faire un aller-retour en base pour une constante.
   * La sortie « non joignable » du bloc est alimentée par le rapport de livraison, pas par un test préalable.
   */
  readonly canCheckReachability = false;

  constructor(private readonly o: SmsmodeOptions) {}

  /**
   * Sans endpoint de capacité, la seule réponse honnête est « je ne sais pas ». On rend donc une capacité
   * VIDE mais non nulle (= on tente l'envoi) plutôt que `null`, qui signifierait « non joignable » et
   * écarterait le destinataire à tort. `canCheckReachability` dit à l'appelant de ne pas s'y fier.
   */
  async capabilities(_tenantId: string, _agentId: string, _e164: string): Promise<RcsCapabilities | null> {
    return { features: [] };
  }

  /** Clé à utiliser pour CE tenant. Sa propre clé si elle existe, sinon celle du serveur. */
  private async cleDe(tenantId: string): Promise<string> {
    const propre = this.o.apiKeyFor ? await this.o.apiKeyFor(tenantId) : null;
    return propre && propre !== '' ? propre : this.o.apiKey;
  }

  /** Adresses de rappel à poser sur CET envoi : celle du workspace si elle existe, sinon les globales. */
  private async rappelsDe(tenantId: string): Promise<{ callbackUrlStatus?: string; callbackUrlMo?: string }> {
    const propre = this.o.callbackUrlFor ? await this.o.callbackUrlFor(tenantId) : null;
    if (propre && propre !== '') return { callbackUrlStatus: propre, callbackUrlMo: propre };
    return {
      ...(this.o.callbackUrlStatus ? { callbackUrlStatus: this.o.callbackUrlStatus } : {}),
      ...(this.o.callbackUrlMo ? { callbackUrlMo: this.o.callbackUrlMo } : {}),
    };
  }

  async send(tenantId: string, _agentId: string, e164: string, msg: RcsOutbound, messageId: string): Promise<SendResult> {
    const to = e164.replace(/[^0-9]/g, ''); // chiffres nus, sans '+' : format exigé par leur API
    const body = {
      recipient: { to },
      body: toSmsmodeBody(msg),
      // `refClient` = NOTRE identifiant, pour recoller le rapport de livraison au destinataire de campagne.
      // ⚠️ Ce n'est PAS une clé d'idempotence : contrairement à RBM, smsmode ne rejette pas un doublon.
      // La protection contre le double envoi reste le claim atomique de `campaign_recipients`.
      // Tronqué à 140 : leur champ est borné là, et un dépassement ferait refuser l'ENVOI ENTIER pour une
      // référence de débogage. Nos identifiants (uuid, uuid:bloc) tiennent largement dessous.
      refClient: messageId.slice(0, 140),
      ...(await this.rappelsDe(tenantId)),
    };

    const cle = await this.cleDe(tenantId);
    if (!cle) throw new SmsmodeApiError(0, null, 'aucune clé RCS pour ce workspace');
    const res = await this.o.transport.post(`${this.o.baseUrl ?? BASE}/messages`, body, {
      'X-Api-Key': cle,
      accept: 'application/json',
    });

    if (res.status < 200 || res.status >= 300) {
      const j = (res.json ?? {}) as { errorCode?: unknown; message?: unknown; detail?: unknown };
      const code = typeof j.errorCode === 'string' ? j.errorCode : null;
      const detail = [j.message, j.detail].filter((x) => typeof x === 'string').join(' : ') || 'envoi RCS refusé';
      throw new SmsmodeApiError(res.status, code, detail);
    }

    // Leur identifiant fait foi pour tout suivi ultérieur (rapport de livraison, fiche du message).
    const j = (res.json ?? {}) as { messageId?: unknown };
    if (typeof j.messageId !== 'string' || j.messageId === '') {
      throw new SmsmodeApiError(res.status, null, 'réponse smsmode sans messageId');
    }
    return { messageId: j.messageId };
  }
}
