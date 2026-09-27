import type { HttpTransport } from '../meta/http';
import type { RcsProvider, RcsOutbound, RcsCapabilities, RcsSuggestion, RcsCard } from './types';
import type { SendResult } from '../meta/types';

/**
 * Provider RCS smsmode (API REST RCS v1.8), contraintes mesurées sur l'API réelle :
 *
 * - l'authentification est une clé `X-Api-Key` rattachée à un canal : une clé du canal SMS répond 403
 *   « Channel type mismatch » sur l'API RCS ;
 * - `POST /rcs/v1/messages` envoie via le canal lié à la clé ; l'expéditeur est l'agent du canal
 *   (`defaultFromField`), jamais un numéro ;
 * - le destinataire est en chiffres nus, sans `+` ;
 * - le reporting est différé : juste après un 201, la fiche du message répond 404, rien ne se conclut d'un
 *   statut lu immédiatement ;
 * - le statut `READ` existe hors de l'énumération documentée : un mapping de statut doit tolérer l'inconnu.
 */
export interface SmsmodeOptions {
  transport: HttpTransport;
  /** Clé du canal RCS de repli, celle du serveur, quand le tenant n'a pas la sienne. Secret côté serveur. */
  apiKey: string;
  /**
   * Clé propre au tenant, déchiffrée à la demande : le cas normal dès qu'il y a plus d'une marque (chaque
   * marque a son agent, son canal et sa clé). `null` : repli sur la clé du serveur.
   */
  apiKeyFor?: (tenantId: string) => Promise<string | null>;
  /** URL publique qui recevra les rapports de livraison. Absente : aucun rapport, la sortie
   *  « non joignable » du bloc restera muette. */
  callbackUrlStatus?: string;
  /** URL publique qui recevra les réponses entrantes (MO). */
  callbackUrlMo?: string;
  /**
   * Adresse de rappel propre au workspace : rapports de livraison et réponses sur la même URL (leur corps porte
   * `direction`, MT ou MO). 🔴 smsmode ne signe pas ses rappels : c'est le code opaque de l'URL qui dit à qui
   * appartient l'appel. Résolue à chaque envoi, jamais mémorisée : une réactivation change le code.
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

/** Suggestion interne -> suggestion smsmode. Leurs six types correspondent un pour un aux nôtres. */
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
 * Carte interne -> `content` smsmode. Les noms comptent (`content`, `contents`, `media.fileUrl`), vérifiés
 * contre leur spec (`dev.smsmode.com/rcs/openapi/rest-rcs.yml`) : un autre nom est refusé en 400.
 */
function toCardContent(c: RcsCard): Record<string, unknown> {
  return {
    ...(c.title ? { title: c.title } : {}),
    ...(c.description ? { description: c.description } : {}),
    ...(c.mediaUrl ? { media: { fileUrl: c.mediaUrl, ...(c.mediaHeight ? { height: c.mediaHeight } : {}) } } : {}),
    ...(c.suggestions?.length ? { suggestions: c.suggestions.map(toSuggestion) } : {}),
  };
}

/** Message interne -> corps smsmode. Union fermée : un `kind` inconnu est impossible par le typage. */
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
      // Orientation verticale : l'image au-dessus du texte, pleine largeur ; HORIZONTAL colle une vignette sur le
      // côté.
      orientation: 'VERTICAL',
      ...(msg.suggestions?.length ? { suggestions: msg.suggestions.map(toSuggestion) } : {}),
    };
  }
  return { type: 'CAROUSEL', contents: msg.cards.map(toCardContent) };
}

export class SmsmodeRcsProvider implements RcsProvider {
  /**
   * smsmode n'expose aucun endpoint de joignabilité : le `lookup` de leur API arrive avec le rapport de
   * livraison, après l'envoi. Le sender saute donc la vérification préalable, et la sortie « non joignable »
   * du bloc est alimentée par le rapport.
   */
  readonly canCheckReachability = false;

  constructor(private readonly o: SmsmodeOptions) {}

  /**
   * Sans endpoint de capacité, la seule réponse honnête est « je ne sais pas » : une capacité vide mais non
   * nulle (on tente l'envoi), pas `null`, qui écarterait le destinataire à tort.
   */
  async capabilities(_tenantId: string, _agentId: string, _e164: string): Promise<RcsCapabilities | null> {
    return { features: [] };
  }

  /** Clé à utiliser pour ce tenant : sa propre clé si elle existe, sinon celle du serveur. */
  private async cleDe(tenantId: string): Promise<string> {
    const propre = this.o.apiKeyFor ? await this.o.apiKeyFor(tenantId) : null;
    return propre && propre !== '' ? propre : this.o.apiKey;
  }

  /** Adresses de rappel à poser sur cet envoi : celle du workspace si elle existe, sinon les globales. */
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
      // `refClient` = notre identifiant, pour recoller le rapport de livraison au destinataire. Ce n'est pas une
      // clé d'idempotence (smsmode ne rejette pas un doublon) : la protection reste le claim atomique de
      // `campaign_recipients`. Tronqué à 140, la borne de leur champ, dont le dépassement ferait refuser l'envoi.
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
