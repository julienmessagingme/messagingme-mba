import { z } from 'zod';
import { MetaApiError, type MetaErrorBody } from './errors';
import { HOTE_360DIALOG } from './client';
import { HTTP_TIMEOUT_DEFAUT_MS } from './http';
import {
  buildComponents, resumeDuModele,
  type ClientModeles, type CreateTemplateInput, type FetchLike, type StatutModele, type TemplateSummary,
} from './templates';

/**
 * Les modèles d'un numéro porté par 360dialog (lot 2, livraison B), derrière le contrat `ClientModeles` : les appelants
 * (envois de modèle, console, `/v1`, MCP) ne savent pas qu'ils parlent à 360dialog. Mesuré le 2026-10-15 :
 * `GET /v1/configs/templates?limit&offset` rend `{waba_templates, total, count}` (le filtre par nom est refusé : on
 * filtre ici) ; un modèle porte les `components` de Meta, `status` en MINUSCULES et l'identifiant de Meta dans
 * `external_id` ; `POST` rend 201 ; `DELETE /v1/configs/templates/{name}` ; un modèle supprimé n'est plus listé.
 * Les statuts n'arrivent PAS par le webhook du numéro : ils se lisent ici, à chaque liste.
 */

/** 100 par page, 20 pages au plus : le plafond de `MetaTemplateClient.list`. */
const PAR_PAGE = 100;
const PAGES_MAX = 20;

const pageSchema = z.object({
  waba_templates: z.array(z.unknown()),
  total: z.number().optional(),
}).passthrough();

const modeleSchema = z.object({
  name: z.string(),
  language: z.string(),
  status: z.string(),
  category: z.string().optional(),
  external_id: z.string().optional(),
  components: z.unknown().optional(),
  rejected_reason: z.string().nullable().optional(),
}).passthrough();
type Modele360 = z.infer<typeof modeleSchema>;

/** La création : seuls les champs lus, le reste ignoré. */
const creeSchema = z.object({
  external_id: z.string().optional(),
  status: z.string().optional(),
  category: z.string().optional(),
}).passthrough();

/** Les deux formes d'erreur rencontrées : celle de Meta relayée (`error`), et celle de 360dialog (`meta`). */
const erreurSchema = z.object({
  error: z.object({
    code: z.number().optional(),
    error_subcode: z.number().optional(),
    type: z.string().optional(),
    message: z.string().optional(),
    error_user_title: z.string().optional(),
    error_user_msg: z.string().optional(),
  }).optional().catch(undefined),
  meta: z.object({ developer_message: z.string().optional() }).optional().catch(undefined),
});

/** La forme d'erreur de 360dialog (`meta.developer_message`), ramenée à celle de Meta pour `MetaApiError`. */
function erreurDe(json: unknown): MetaErrorBody | null {
  const lu = erreurSchema.safeParse(json);
  if (!lu.success) return null;
  if (lu.data.error) return lu.data.error;
  if (lu.data.meta?.developer_message !== undefined) return { message: lu.data.meta.developer_message };
  return null;
}

export class Template360dialogClient implements ClientModeles {
  constructor(
    private readonly cle: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly delaiMs: number = HTTP_TIMEOUT_DEFAUT_MS,
  ) {}

  private async appel(chemin: string, init: RequestInit = {}): Promise<unknown> {
    const res = await this.fetchImpl(`${HOTE_360DIALOG}/v1/configs/templates${chemin}`, {
      ...init,
      headers: { 'D360-API-KEY': this.cle, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
      signal: AbortSignal.timeout(this.delaiMs),
      // Comme `Media360dialogClient` : une redirection emporterait la clé chez un autre hôte.
      redirect: 'error',
    });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) throw new MetaApiError(res.status, erreurDe(json));
    return json;
  }

  /** Toutes les lignes, page par page. Une ligne illisible est écartée sans faire échouer la liste. */
  private async lignes(): Promise<Modele360[]> {
    const out: Modele360[] = [];
    for (let page = 0; page < PAGES_MAX; page++) {
      const lu = pageSchema.safeParse(await this.appel(`?limit=${PAR_PAGE}&offset=${page * PAR_PAGE}`));
      if (!lu.success) break;
      for (const brut of lu.data.waba_templates) {
        const m = modeleSchema.safeParse(brut);
        if (m.success) out.push(m.data);
      }
      const lus = (page + 1) * PAR_PAGE;
      if (lu.data.waba_templates.length < PAR_PAGE || (lu.data.total !== undefined && lus >= lu.data.total)) break;
    }
    return out;
  }

  /**
   * Même résumé que chez Meta (`resumeDuModele`) : l'identifiant de Meta (`external_id`), le statut en MAJUSCULES (tous
   * les envois exigent `APPROVED`), et jamais modifiable : aucune modification n'est mesurée chez 360dialog.
   */
  async list(_wabaId: string): Promise<TemplateSummary[]> {
    return (await this.lignes()).map((m) => ({
      ...resumeDuModele({
        id: m.external_id ?? '', name: m.name, status: m.status.toUpperCase(), category: m.category ?? '',
        language: m.language, components: m.components,
      }),
      editable: false,
    }));
  }

  async statutsDuNom(_wabaId: string, name: string): Promise<StatutModele[]> {
    return (await this.lignes()).filter((m) => m.name === name).map((m) => ({
      language: m.language,
      status: m.status.toUpperCase(),
      category: m.category ?? null,
      rejectedReason: m.rejected_reason && m.rejected_reason !== 'NONE' ? m.rejected_reason : null,
    }));
  }

  /** La création, avec les `components` de Meta (`buildComponents`) ; la forme mesurée porte `allow_category_change`. */
  async create(_wabaId: string, input: CreateTemplateInput): Promise<{ id: string; status: string; category: string }> {
    const json = await this.appel('', {
      method: 'POST',
      body: JSON.stringify({
        name: input.name,
        category: input.category,
        language: input.language,
        allow_category_change: true,
        components: buildComponents(input),
        ...(input.ttlSecondes !== undefined ? { message_send_ttl_seconds: input.ttlSecondes } : {}),
      }),
    });
    const lu = creeSchema.safeParse(json);
    const cree = lu.success ? lu.data : {};
    return {
      id: cree.external_id ?? '',
      status: cree.status?.toUpperCase() ?? 'PENDING',
      category: cree.category ?? input.category,
    };
  }

  /** Aucune modification n'est mesurée chez 360dialog : `list` rend `editable: false`, et la route la refuse avant. */
  async update(): Promise<{ success: boolean }> {
    throw Object.assign(new Error('la modification d’un modèle n’est pas disponible sur ce numéro'), { statusCode: 422 });
  }

  async remove(_wabaId: string, name: string): Promise<{ success: boolean }> {
    await this.appel(`/${encodeURIComponent(name)}`, { method: 'DELETE' });
    return { success: true };
  }
}
