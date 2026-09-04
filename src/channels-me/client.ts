import { z } from 'zod';
import { corpsCanonique, signer } from './signature';
import { organisationSchema, messageChannelSchema, messageSchema } from './types';
import type { Connexion, Organisation, MessageChannel, Message } from './types';

/**
 * Client HTTP de Channels Me.
 *
 * Hote FIXE et de confiance : aucune verification d'adresse privee ici (meme traitement que les clients
 * Meta et Zadarma), le nom ne vient pas d'une saisie client.
 */

/** 🔴 A CONFIRMER contre le journal de mesure avant le premier appel reel. Une seule ligne a changer. */
const BASE = 'https://api.channels.me/v1';

const JSON_MIME = 'application/json';

/** L'en-tete qui porte la cle d'API du tenant. 🔴 Nom a confirmer, comme BASE. */
const ENTETE_CLE = 'X-Api-Key';

/** L'en-tete qui porte la signature. */
const ENTETE_SIGNATURE = 'X-Signature';

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

/** Notre plafond a-t-il coupe l'appel ? `AbortSignal.timeout` fait rejeter `fetch` avec un `TimeoutError`. */
function estAbandon(err: unknown): boolean {
  const nom = err instanceof Error ? err.name : '';
  return nom === 'TimeoutError' || nom === 'AbortError';
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
  async createMessage(cx: Connexion, m: { text: string; mediaUrl?: string }): Promise<Message> {
    const corps = {
      message: {
        kind: m.mediaUrl === undefined ? 'text' : 'image',
        publish_now: true,
        text: m.text,
        ...(m.mediaUrl === undefined ? {} : { media_url: m.mediaUrl }),
      },
    };
    return this.appel(cx, 'POST', cheminMessages(cx), messageSchema, corps);
  }

  /**
   * 🔴 UNE SEULE DERIVATION DE LA CHAINE CANONIQUE. `canonique` est SIGNEE et ENVOYEE comme corps : il
   * n'existe aucun endroit ou ce qu'on signe pourrait differer de ce qu'on transmet. Deriver deux fois
   * (signer l'objet, puis `JSON.stringify` le meme objet pour le corps) est le moyen le plus sur de
   * produire une signature qui ne correspond pas au corps, et l'API repond alors 401 sans dire pourquoi,
   * ce qui fait accuser les cles alors qu'elles sont bonnes.
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
    const entetes: Record<string, string> = { Accept: JSON_MIME, [ENTETE_CLE]: cx.apiKey };
    if (canonique !== null) {
      entetes['Content-Type'] = JSON_MIME;
      entetes[ENTETE_SIGNATURE] = signer(canonique, cx.secret);
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
