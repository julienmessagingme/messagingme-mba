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
  /** Clé du CANAL RCS (pas celle du compte ni celle d'un canal SMS). Secret : côté serveur uniquement. */
  apiKey: string;
  /** URL publique qui recevra les rapports de livraison. Absente -> aucun rapport, la sortie
   *  « non joignable » du bloc restera donc muette. */
  callbackUrlStatus?: string;
  /** URL publique qui recevra les réponses entrantes (MO). */
  callbackUrlMo?: string;
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

/** Suggestion interne -> suggestion smsmode. Leurs trois types correspondent un pour un aux nôtres. */
function toSuggestion(s: RcsSuggestion): Record<string, unknown> {
  if (s.kind === 'reply') return { type: 'REPLY', text: s.text, postbackData: s.postbackData };
  if (s.kind === 'openUrl') return { type: 'OPEN_URL', text: s.text, url: s.url, postbackData: s.postbackData };
  return { type: 'DIAL_PHONE', text: s.text, phoneNumber: s.phoneNumber, postbackData: s.postbackData };
}

function toCard(c: RcsCard): Record<string, unknown> {
  return {
    title: c.title,
    ...(c.description ? { description: c.description } : {}),
    ...(c.mediaUrl ? { media: { url: c.mediaUrl } } : {}),
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
  if (msg.kind === 'card') return { type: 'CARD', card: toCard(msg.card) };
  return { type: 'CAROUSEL', cards: msg.cards.map(toCard) };
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
  async capabilities(_agentId: string, _e164: string): Promise<RcsCapabilities | null> {
    return { features: [] };
  }

  async send(_agentId: string, e164: string, msg: RcsOutbound, messageId: string): Promise<SendResult> {
    const to = e164.replace(/[^0-9]/g, ''); // chiffres nus, sans '+' : format exigé par leur API
    const body = {
      recipient: { to },
      body: toSmsmodeBody(msg),
      // `refClient` = NOTRE identifiant, pour recoller le rapport de livraison au destinataire de campagne.
      // ⚠️ Ce n'est PAS une clé d'idempotence : contrairement à RBM, smsmode ne rejette pas un doublon.
      // La protection contre le double envoi reste le claim atomique de `campaign_recipients`.
      refClient: messageId,
      ...(this.o.callbackUrlStatus ? { callbackUrlStatus: this.o.callbackUrlStatus } : {}),
      ...(this.o.callbackUrlMo ? { callbackUrlMo: this.o.callbackUrlMo } : {}),
    };

    const res = await this.o.transport.post(`${this.o.baseUrl ?? BASE}/messages`, body, {
      'X-Api-Key': this.o.apiKey,
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
