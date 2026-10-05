import { z } from 'zod';

/**
 * LE CLIENT DIDWW DES NUMÉROS FOURNIS (lot 3a, spec `docs/superpowers/specs/2026-10-05-pont-du-code-design.md`).
 *
 * Il ne sait que DEUX gestes : retrouver un numéro de notre inventaire, et le brancher sur le trunk de l'Asterisk. Il
 * n'achète rien et ne résilie rien, délibérément : c'est Julien qui achète (décision du 2026-10-05), et la clé, qui le
 * pourrait, est limitée à l'adresse du VPS.
 *
 * Mesuré sur le compte réel (`docs/prive/2026-10-02-engageme-claude-code.md`, « DIDWW : ce qui est vérifié ») : l'API
 * parle JSON:API, version `2026-04-16`, et ses chemins prennent des SOULIGNÉS là où la documentation écrit des tirets
 * (recopier un chemin de la documentation rend 404). Le branchement est le `PATCH` joué à la main le 2026-10-02.
 */

const VERSION_API = '2026-04-16';
const TYPE_JSON_API = 'application/vnd.api+json';
/** Une API ordinaire répond en moins d'une seconde : ce plafond ne coupe qu'un silence. */
const DELAI_MS = 15_000;

export interface ConfigDidww {
  cle: string;
  /** `https://api.didww.com/v3`, ou le bac à sable. */
  url: string;
}

/** Un refus ou une réponse illisible de DIDWW. `statut` : le code HTTP, `null` = aucune réponse (réseau, délai). */
export class ErreurDidww extends Error {
  constructor(readonly statut: number | null, message: string) {
    super(message);
    this.name = 'ErreurDidww';
  }
}

const didSchema = z.object({
  id: z.string().min(1),
  attributes: z.object({ number: z.string().min(1) }),
});
const listeSchema = z.object({ data: z.array(didSchema) });
/** Le corps d'un refus, au format JSON:API. */
const erreursSchema = z.object({ errors: z.array(z.object({ detail: z.string().optional(), title: z.string().optional() })).optional() });
const unSchema = z.object({ data: didSchema });

export interface DidDidww {
  id: string;
  numero: string;
}

export interface ClientDidww {
  /** Le numéro de notre inventaire (chiffres seuls), ou `null` s'il n'y est pas. */
  trouverDid(numero: string): Promise<DidDidww | null>;
  /** Branche le numéro sur le trunk : les appels qu'il reçoit vont désormais à l'Asterisk. */
  brancher(didId: string, trunkId: string): Promise<void>;
}

export function creerClientDidww(config: ConfigDidww, fetchImpl: typeof fetch = fetch): ClientDidww {
  const entetes = { 'Api-Key': config.cle, 'X-DIDWW-API-Version': VERSION_API, Accept: TYPE_JSON_API };

  const appeler = async (chemin: string, init: { method: 'GET' | 'PATCH'; body?: string }): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetchImpl(`${config.url}${chemin}`, {
        method: init.method,
        headers: init.body === undefined ? entetes : { ...entetes, 'Content-Type': TYPE_JSON_API },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.timeout(DELAI_MS),
      });
    } catch (err) {
      throw new ErreurDidww(null, `DIDWW injoignable : ${err instanceof Error ? err.name : 'erreur réseau'}`);
    }
    const texte = await res.text();
    if (!res.ok) {
      // Le premier détail JSON:API, borné : il dit ce qui est refusé, et ne porte aucun secret.
      let detail = '';
      try {
        const e = erreursSchema.safeParse(JSON.parse(texte));
        const premiere = e.success ? e.data.errors?.[0] : undefined;
        detail = (premiere?.detail ?? premiere?.title ?? '').slice(0, 200);
      } catch { /* corps non JSON : le statut suffit */ }
      throw new ErreurDidww(res.status, `DIDWW a refusé (${res.status})${detail ? ` : ${detail}` : ''}`);
    }
    try {
      return texte === '' ? null : JSON.parse(texte);
    } catch {
      throw new ErreurDidww(res.status, 'réponse de DIDWW illisible');
    }
  };

  return {
    async trouverDid(numero) {
      const lu = listeSchema.safeParse(await appeler(`/dids?filter[number]=${encodeURIComponent(numero)}`, { method: 'GET' }));
      if (!lu.success) throw new ErreurDidww(200, 'liste de numéros DIDWW illisible');
      // Le filtre de DIDWW est une égalité, mais on ne s'y fie pas : seul le numéro exact est rendu.
      const d = lu.data.data.find((x) => x.attributes.number === numero);
      return d ? { id: d.id, numero: d.attributes.number } : null;
    },

    async brancher(didId, trunkId) {
      const corps = JSON.stringify({
        data: { id: didId, type: 'dids', relationships: { voice_in_trunk: { data: { type: 'voice_in_trunks', id: trunkId } } } },
      });
      const lu = unSchema.safeParse(await appeler(`/dids/${encodeURIComponent(didId)}`, { method: 'PATCH', body: corps }));
      if (!lu.success || lu.data.data.id !== didId) throw new ErreurDidww(200, 'réponse de branchement DIDWW illisible');
    },
  };
}
