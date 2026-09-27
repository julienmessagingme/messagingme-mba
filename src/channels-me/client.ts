import { z } from 'zod';
import { corpsASigner, corpsCanonique, signer } from './signature';
import { organisationSchema, messageChannelSchema, messageSchema } from './types';
import type { Connexion, Organisation, MessageChannel, Message } from './types';
import { estAbandon } from '../meta/http';

/**
 * Client HTTP de Channels Me. Hôte fixe et de confiance : pas de vérification d'adresse privée (comme les
 * clients Meta et Zadarma), le nom ne vient pas d'une saisie client.
 */

/**
 * L'hôte déclaré par la spec OpenAPI du fournisseur, vérifié par un appel réel. `api.channels.me` redirige
 * (302) au lieu d'échouer franchement.
 */
const BASE = 'https://channels-me.com/api/v1';

const JSON_MIME = 'application/json';

/** L'en-tête qui porte la clé d'API du tenant, `Bearer <cle>` : le schéma de sécurité de leur spec, vérifié
 *  par un appel réel. */
const ENTETE_AUTORISATION = 'Authorization';

/** L'en-tete qui porte la signature. */
const ENTETE_SIGNATURE = 'X-Signature';

/**
 * Le seul `kind` que nous publions (enum du fournisseur : `text_and_media` ou `poll`). Il couvre le texte
 * seul comme le texte avec image : c'est la présence de `media_url` qui décide, jamais le `kind`. Une autre
 * valeur rend un 500 Rails générique, sans dire quel champ est en cause.
 */
const KIND_TEXTE_ET_MEDIA = 'text_and_media';

/**
 * Delai maximum d'un appel. Sans plafond, un fournisseur qui accepte la connexion et ne repond jamais
 * immobilise le slot d'ou l'appel part, jusqu'au defaut d'undici, de l'ordre de cinq minutes.
 */
const DELAI_MS = 15_000;

/** Longueur maximale du seul fragment de corps distant qu'on garde. */
const DETAIL_MAX = 200;

/**
 * Échec d'un appel Channels Me ; `status` vaut 0 quand aucune réponse n'est arrivée. Le corps distant ne
 * voyage pas dans cette erreur : seul le champ `error.message` d'un JSON valide, tronqué (sans `Accept`,
 * l'API rend une page HTML entière, et un corps distant peut porter des données d'un autre espace).
 */
export class ChannelsMeApiError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`channels me HTTP ${status}${detail === '' ? '' : ` : ${detail}`}`);
    this.name = 'ChannelsMeApiError';
  }
}

/** La seule forme d'erreur distante qu'on accepte de lire. safeParse, donc aucun `as` sur un corps externe. */
const erreurDistanteSchema = z.object({ error: z.object({ message: z.string() }) });

function detailDistant(json: unknown): string {
  const p = erreurDistanteSchema.safeParse(json);
  return p.success ? p.data.error.message.slice(0, DETAIL_MAX) : '';
}

function cheminOrg(cx: Connexion): string {
  return `/organisations/${encodeURIComponent(cx.orgId)}`;
}

function cheminMessages(cx: Connexion): string {
  return `${cheminOrg(cx)}/message_channels/${encodeURIComponent(cx.channelId)}/messages`;
}

export class ChannelsMeClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(deps?: { fetch?: typeof fetch; timeoutMs?: number }) {
    this.fetchImpl = deps?.fetch ?? fetch;
    this.timeoutMs = deps?.timeoutMs ?? DELAI_MS;
  }

  async getOrganisation(cx: Connexion): Promise<Organisation> {
    return this.appel(cx, 'GET', cheminOrg(cx), organisationSchema);
  }

  async listChannels(cx: Connexion): Promise<MessageChannel[]> {
    return this.appel(cx, 'GET', `${cheminOrg(cx)}/message_channels`, z.array(messageChannelSchema));
  }

  async getMessages(cx: Connexion): Promise<Message[]> {
    return this.appel(cx, 'GET', cheminMessages(cx), z.array(messageSchema));
  }

  /**
   * Publie tout de suite : `publish_now` est en dur, on ne planifie pas. `kind` vaut toujours
   * `text_and_media` (voir `KIND_TEXTE_ET_MEDIA`).
   */
  async createMessage(cx: Connexion, m: { text: string; mediaUrl?: string }): Promise<Message> {
    const corps = {
      message: {
        kind: KIND_TEXTE_ET_MEDIA,
        publish_now: true,
        text: m.text,
        ...(m.mediaUrl === undefined ? {} : { media_url: m.mediaUrl }),
      },
    };
    return this.appel(cx, 'POST', cheminMessages(cx), messageSchema, corps);
  }

  /**
   * Ce qu'on envoie et ce qu'on signe viennent du même objet, et ne diffèrent que par `corpsASigner`, qui
   * retire les champs que le fournisseur ne signe pas (`CHAMPS_HORS_SIGNATURE`). Sans cette règle, toute
   * publication avec image recevait un 401.
   *
   * Deux autres contraintes mesurées : `Accept: application/json` sur tous les appels, GET compris (sinon une
   * page HTML d'erreur en 500) ; la signature seulement sur les écritures (en poser une sur un GET obligerait
   * à inventer une canonicalisation de query string).
   */
  private async appel<S extends z.ZodType>(
    cx: Connexion,
    methode: 'GET' | 'POST',
    chemin: string,
    interieur: S,
    corps?: unknown,
  ): Promise<z.infer<S>> {
    const canonique = corps === undefined ? null : corpsCanonique(corps);
    const aSigner = corps === undefined ? null : corpsCanonique(corpsASigner(corps));
    const entetes: Record<string, string> = { Accept: JSON_MIME, [ENTETE_AUTORISATION]: `Bearer ${cx.apiKey}` };
    if (canonique !== null) {
      entetes['Content-Type'] = JSON_MIME;
      entetes[ENTETE_SIGNATURE] = signer(aSigner!, cx.secret);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${BASE}${chemin}`, {
        method: methode,
        headers: entetes,
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(canonique === null ? {} : { body: canonique }),
      });
    } catch (err) {
      // Le message de l'exception reseau ne remonte pas : il porte l'hote, parfois l'URL complete.
      throw new ChannelsMeApiError(0, estAbandon(err) ? 'delai depasse' : 'aucune reponse');
    }

    const brut = await res.text().catch(() => '');
    let json: unknown = null;
    try {
      json = brut === '' ? null : JSON.parse(brut);
    } catch {
      json = null;
    }

    if (!res.ok) throw new ChannelsMeApiError(res.status, detailDistant(json));

    // L'enveloppe est `{data: ...}`, sans second niveau (les listes ne paginent pas). Dépliée avant de valider
    // l'intérieur : un schéma d'enveloppe générique ne s'infère pas correctement.
    const enveloppe = z.object({ data: z.unknown() }).safeParse(json);
    if (!enveloppe.success) throw new ChannelsMeApiError(res.status, 'reponse inattendue');
    const lu = interieur.safeParse(enveloppe.data.data);
    if (!lu.success) throw new ChannelsMeApiError(res.status, 'reponse inattendue');
    return lu.data;
  }
}
