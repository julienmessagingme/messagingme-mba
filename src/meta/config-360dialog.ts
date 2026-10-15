import { z } from 'zod';
import type { FetchLike } from './templates';
import { HOTE_360DIALOG } from './client';
import { HTTP_TIMEOUT_DEFAUT_MS } from './http';

/**
 * La configuration d'un numéro porté par 360dialog, avec la clé d'API du numéro : ce que le rattachement par `/ops`
 * (lot 2, livraison A) lit et pose. Mesuré le 2026-10-15 sur le premier numéro.
 */

/** 360dialog refuse la clé (401) : rien n'est rattaché. */
export class Cle360dialogRefusee extends Error {
  constructor() {
    super('clé 360dialog refusée');
    this.name = 'Cle360dialogRefusee';
  }
}

/** Une réponse de 360dialog qu'on ne sait pas lire, ou un refus autre que celui de la clé. */
export class Erreur360dialog extends Error {
  constructor(readonly etape: string, readonly status: number) {
    super(`360dialog : ${etape} a échoué (HTTP ${status})`);
    this.name = 'Erreur360dialog';
  }
}

const santeSchema = z.object({
  health_status: z.object({
    entities: z.array(z.object({ entity_type: z.string(), id: z.string() }).passthrough()),
  }).passthrough(),
}).passthrough();

const destinationSchema = z.object({
  name: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
}).passthrough();
const multiSchema = z.object({ enabled: z.boolean(), destinations: z.array(destinationSchema) }).passthrough();
const simpleSchema = z.object({ url: z.string().nullable().optional(), headers: z.record(z.string(), z.string()).nullable().optional() }).passthrough();

export interface Destination360 {
  name: string;
  url: string;
  headers: Record<string, string>;
}

/** Le plafond de 360dialog : trois destinations par numéro (doc des webhooks multiples). */
const MAX_DESTINATIONS = 3;

export class Config360dialogClient {
  constructor(
    private readonly cle: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly delaiMs: number = HTTP_TIMEOUT_DEFAUT_MS,
  ) {}

  private async appel(etape: string, methode: string, chemin: string, corps?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.fetchImpl(`${HOTE_360DIALOG}${chemin}`, {
      method: methode,
      headers: { 'D360-API-KEY': this.cle, ...(corps === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
      signal: AbortSignal.timeout(this.delaiMs),
      // Comme `Media360dialogClient` : une redirection emporterait la clé chez un autre hôte.
      redirect: 'error',
    });
    if (res.status === 401) throw new Cle360dialogRefusee();
    const json = (await res.json().catch(() => null)) as unknown;
    if (etape !== 'lire les webhooks multiples' && (res.status < 200 || res.status >= 300)) throw new Erreur360dialog(etape, res.status);
    return { status: res.status, json };
  }

  /** Le numéro et le compte WhatsApp que désigne la clé, lus chez 360dialog : jamais saisis à la main. */
  async lireNumero(): Promise<{ phoneNumberId: string; wabaId: string }> {
    const { json } = await this.appel('lire le numéro', 'GET', '/health_status');
    const lu = santeSchema.safeParse(json);
    if (!lu.success) throw new Erreur360dialog('lire le numéro', 200);
    const id = (type: string): string | undefined => lu.data.health_status.entities.find((e) => e.entity_type === type)?.id;
    const phoneNumberId = id('PHONE_NUMBER');
    const wabaId = id('WABA');
    if (!phoneNumberId || !wabaId) throw new Erreur360dialog('lire le numéro', 200);
    return { phoneNumberId, wabaId };
  }

  /**
   * Pose NOTRE destination de webhook en GARDANT celles qui existent (le logiciel qui exploite déjà le numéro). Webhooks
   * multiples éteints : on les allume avec le webhook simple existant recopié, puis le nôtre (fait ainsi le 2026-10-15,
   * à côté de UChat). Allumés : la nôtre est mise à jour si elle y est déjà (même nom), ajoutée sinon. Rejouer est sans
   * effet de bord.
   */
  async poserWebhook(notre: Destination360): Promise<'allume' | 'ajoute' | 'mis_a_jour'> {
    const { status, json } = await this.appel('lire les webhooks multiples', 'GET', '/multi_webhook');
    if (status === 409) {
      const simple = simpleSchema.safeParse((await this.appel('lire le webhook', 'GET', '/v1/configs/webhook')).json);
      if (!simple.success) throw new Erreur360dialog('lire le webhook', 200);
      const existant = simple.data.url && simple.data.url !== notre.url
        ? [{ name: 'existant', url: simple.data.url, headers: simple.data.headers ?? {} }]
        : [];
      await this.appel('allumer les webhooks multiples', 'POST', '/multi_webhook', { enabled: true, destinations: [...existant, notre] });
      return 'allume';
    }
    if (status < 200 || status >= 300) throw new Erreur360dialog('lire les webhooks multiples', status);
    const multi = multiSchema.safeParse(json);
    if (!multi.success) throw new Erreur360dialog('lire les webhooks multiples', status);
    if (multi.data.destinations.some((d) => d.name === notre.name)) {
      await this.appel('mettre à jour le webhook', 'PATCH', '/multi_webhook', notre);
      return 'mis_a_jour';
    }
    if (multi.data.destinations.length >= MAX_DESTINATIONS) throw new Erreur360dialog('ajouter le webhook (trois destinations déjà)', 409);
    await this.appel('ajouter le webhook', 'PUT', '/multi_webhook', { destinations: [notre] });
    return 'ajoute';
  }
}
