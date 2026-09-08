import { z } from 'zod';
import { corpsASigner, corpsCanonique, signer } from './signature';
import { organisationSchema, messageChannelSchema, messageSchema } from './types';
import type { Connexion, Organisation, MessageChannel, Message } from './types';
import { estAbandon } from '../meta/http';

/**
 * Client HTTP de Channels Me.
 *
 * Hote FIXE et de confiance : aucune verification d'adresse privee ici (meme traitement que les clients
 * Meta et Zadarma), le nom ne vient pas d'une saisie client.
 */

/**
 * Mesure le 2026-09-04 : la spec OpenAPI du fournisseur (https://channels-me.com/api-docs/v1/swagger.yaml)
 * declare `servers: - url: https://channels-me.com/api/v1`, et un appel reel contre cet hote a rendu 200.
 * `api.channels.me` existe mais redirige (302) au lieu d'echouer franchement.
 */
const BASE = 'https://channels-me.com/api/v1';

const JSON_MIME = 'application/json';

/**
 * L'en-tete qui porte la cle d'API du tenant, au format standard `Bearer <cle>`. Mesure le 2026-09-04 :
 * un appel reel avec `Authorization: Bearer <cle>` a rendu 200 sur `/organisations`, et le schema de
 * securite de la spec OpenAPI du fournisseur nomme `Authorization` comme porteur de la cle.
 */
const ENTETE_AUTORISATION = 'Authorization';

/** L'en-tete qui porte la signature. */
const ENTETE_SIGNATURE = 'X-Signature';

/**
 * Le seul `kind` que nous publions. Enum du fournisseur : `text_and_media` ou `poll`. Nous ne publions pas
 * de sondage, donc il n y a rien a choisir, et surtout rien a deduire de la presence d un media.
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
 * Echec d'un appel Channels Me.
 *
 * 🔴 LE CORPS DISTANT NE VOYAGE PAS DANS CETTE ERREUR. On ne garde que le statut et, quand la reponse est
 * du JSON valide, le seul champ `error.message`, tronque. Deux raisons mesurees : sans `Accept`, l'API rend
 * une page HTML entiere, et un corps distant peut porter des donnees d'un autre espace.
 *
 * `status` vaut 0 quand aucune reponse n'est arrivee (panne reseau, ou notre plafond a coupe).
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
   * Publie tout de suite. `publish_now` est en dur parce que la V1 ne planifie pas : il n'y a donc pas
   * d'etat brouillon a piloter, et un parametre de plus serait un cas non teste.
   */
  /**
   * 🔴 `kind` NE PREND QUE DEUX VALEURS : `text_and_media` ou `poll` (spec OpenAPI du fournisseur,
   * `#/components/schemas/Message`, enum verifie le 2026-09-07). Ce code a d abord envoye `text` ou
   * `image` selon la presence d un media : DEUX valeurs qui n existent pas, inventees par le redacteur du
   * plan et jamais mesurees. Leur API repond alors **HTTP 500** avec la page d erreur generique de Rails,
   * pas un 422 : rien ne dit quel champ est en cause, et notre message d erreur accusait le texte et
   * l image de l utilisateur, qui n y etaient pour rien.
   *
   * `text_and_media` couvre le texte SEUL comme le texte avec image, et c est exactement pour ca qu il
   * s appelle ainsi : « either a text or an image or both is required ». C est la presence de `media_url`
   * qui decide s il y a une image, jamais le `kind`.
   *
   * ⚠️ Troisieme valeur inventee de ce lot, apres l hote de l API et l en-tete d authentification. La
   * lecon ne change pas : une valeur qu on ne sait pas se MESURE avant d ecrire, ou ne s ecrit pas.
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
   * 🔴 CE QU'ON ENVOIE ET CE QU'ON SIGNE VIENNENT DU MEME OBJET, et ne different que par une regle
   * NOMMEE ET MESUREE : `corpsASigner` retire les champs que le fournisseur retire de son cote avant de
   * verifier (`CHAMPS_HORS_SIGNATURE`, aujourd'hui `media_url` et `media`). C'est la seule difference
   * possible, elle est declaree en un endroit, et le reste du corps est signe tel qu'il part.
   *
   * ⚠️ Sans cette regle, toute publication AVEC IMAGE recevait `401 Bad Authorization or X-Signature
   * header`. Deriver librement deux fois (signer un objet, serialiser l'autre) reste le moyen le plus sur
   * de produire une signature qui ne correspond pas au corps, et l'API repond alors 401 sans dire pourquoi,
   * ce qui fait accuser les cles alors qu'elles sont bonnes. D'ou une fonction, pas deux constructions.
   *
   * Deux autres invariants mesures tiennent dans cette methode :
   *  - `Accept: application/json` sur TOUS les appels, GET compris, sans quoi l'API rend une page HTML
   *    d'erreur Rails en 500 ;
   *  - la signature n'est posee que sur les ECRITURES. Elle n'est pas requise sur les GET, et en poser une
   *    obligerait a inventer une canonicalisation de query string que personne n'a mesuree.
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

    // L'enveloppe est `{data: ...}`, et elle seule (mesure : les listes ne paginent pas, il n'y a pas de
    // second niveau de meta a lire). On la deplie AVANT de valider l'interieur, en deux temps, parce qu'un
    // schema d'enveloppe generique ne s'infere pas correctement.
    const enveloppe = z.object({ data: z.unknown() }).safeParse(json);
    if (!enveloppe.success) throw new ChannelsMeApiError(res.status, 'reponse inattendue');
    const lu = interieur.safeParse(enveloppe.data.data);
    if (!lu.success) throw new ChannelsMeApiError(res.status, 'reponse inattendue');
    return lu.data;
  }
}
