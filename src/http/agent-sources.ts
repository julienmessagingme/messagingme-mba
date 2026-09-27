import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import { LabelSourceDejaPris, type SourceVue } from '../agent/sources';
import { construireCible } from '../agent/http-cible';
import { espaceVerifie, estUuid } from './scope';
import { makeJournal, type AuditSink } from '../audit/journal';

/**
 * Les sources externes d'outils : déclarer le système du client, et savoir qu'il répond encore. Une source est
 * une adresse que le serveur appellera depuis le réseau Docker du VPS, et un secret. Trois gardes :
 *  1. 🔴 l'adresse est validée à l'écriture, par la même fonction que le résolveur (`construireCible`) ;
 *  2. le secret ne se relit jamais ; un champ vide dans un patch veut dire « inchangé » ;
 *  3. supprimer une source dont des outils actifs dépendent est refusé (409) : la cascade rendrait l'agent muet
 *     sur ces gestes, sans que personne l'ait décidé.
 */

export interface AgentSourcesRouteDeps {
  /**
   * Journal d'audit (les fixtures qui ne l'observent pas passent `journalMuet`). Un connecteur est la sortie de
   * l'espace : changer son adresse change la destination de tout ce qui part.
   * 🔴 Le `detail` ne porte jamais le secret ni l'adresse complète : seulement le mode d'authentification et
   * l'hôte (le chemin et le secret permettraient de rejouer l'appel depuis une table jamais purgée).
   */
  audit: AuditSink;
  sources: {
    lister(tenantId: string): Promise<SourceVue[]>;
    parId(tenantId: string, id: string): Promise<SourceVue | null>;
    creer(tenantId: string, input: { kind: 'http'; label: string; baseUrl: string; authKind: 'none' | 'bearer' | 'header'; authHeaderName?: string; authSecret?: string }): Promise<SourceVue>;
    patch(tenantId: string, id: string, patch: Record<string, unknown>): Promise<SourceVue | null>;
    supprimer(tenantId: string, id: string): Promise<boolean>;
  };
  /**
   * Éprouve la source pour de vrai : un appel, et le résultat écrit sur la ligne. Seul moyen de voir un jeton
   * mort avant qu'un contact ne le découvre (l'agent dégrade en silence).
   */
  eprouver(tenantId: string, id: string, chemin: string): Promise<{ ok: boolean; httpStatus?: number; erreur?: string }>;
}

const LABEL = z.string().trim().min(1).max(80);
const URL_BASE = z.string().trim().min(1).max(500);
const SECRET = z.string().trim().min(1).max(500);
const NOM_ENTETE = z.string().trim().regex(/^[A-Za-z0-9-]{1,64}$/, 'nom d’en-tête invalide');

const creationSchema = z.object({
  label: LABEL,
  baseUrl: URL_BASE,
  authKind: z.enum(['none', 'bearer', 'header']),
  authHeaderName: NOM_ENTETE.optional(),
  authSecret: SECRET.optional(),
});
const patchSchema = z.object({
  label: LABEL.optional(),
  baseUrl: URL_BASE.optional(),
  authKind: z.enum(['none', 'bearer', 'header']).optional(),
  authHeaderName: NOM_ENTETE.nullable().optional(),
  authSecret: SECRET.optional(),
  status: z.enum(['draft', 'active', 'disabled']).optional(),
});
const epreuveSchema = z.object({ chemin: z.string().trim().min(1).max(500).default('/') });

/**
 * L'adresse est-elle acceptable ? Même fonction que le résolveur, exportée pour les connecteurs MCP : une seconde
 * définition accepterait à l'écriture ce que l'appel refuse, et promettrait un connecteur qui ne marchera jamais.
 */
export function adresseAcceptable(baseUrl: string): boolean {
  return construireCible({ baseUrl, binding: { methode: 'GET', chemin: '/' }, args: {} }).ok;
}

/** L'authentification déclarée tient-elle debout ? Rejoué ici parce que la contrainte de la 0088 refuserait
 *  de toute façon, mais en 500, dont Cloudflare remplace le corps. */
export function authCoherente(authKind: string, secret: string | undefined, entete: string | null | undefined): string | null {
  if (authKind === 'none') return null;
  if (!secret) return 'un secret est requis pour ce mode d’authentification';
  if (authKind === 'header' && !entete) return 'le nom de l’en-tête est requis';
  return null;
}

/**
 * L'hôte d'une adresse, ou `null` si elle est illisible. Ne lève jamais : il sert un journal, et une adresse mal
 * formée ne doit pas faire échouer l'action observée.
 */
export function hoteDe(url: string): string | null {
  try { return new URL(url).host; } catch { return null; }
}

export function registerAgentSources(app: FastifyInstance, deps: AgentSourcesRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const journal = makeJournal(deps.audit);
  const base = '/tenants/:tenantId/agent-sources';

  app.get(base, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    /**
     * Seulement les connecteurs HTTP : cet écran compose des chemins sous une adresse de base et éprouve par un
     * GET, gestes sans objet pour un serveur MCP. Filtré ici et non dans `lister` : l'inventaire de l'assistant de
     * configuration compte les serveurs MCP (`src/agent/setup/couverture.ts`).
     */
    const sources = await deps.sources.lister(tenant);
    return reply.code(200).send({ sources: sources.filter((s) => s.kind === 'http') });
  });

  /**
   * 🔴 La source de cette route, à condition qu'elle soit un connecteur HTTP (miroir de la garde côté MCP) : `parId`
   * ne filtre pas le `kind`, et l'identifiant d'un serveur MCP ferait sinon envoyer une requête HTTP sur son point
   * MCP avec son secret, réécrire son adresse, ou le supprimer sans la garde du store MCP.
   * `tests/sources-kind.test.ts` tient l'inventaire des lecteurs. 404 : pour cet écran, un serveur MCP n'existe pas.
   */
  async function connecteurHttp(tenant: string, id: string): Promise<SourceVue | null> {
    const s = await deps.sources.parId(tenant, id);
    return s && s.kind === 'http' ? s : null;
  }

  app.post(base, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const parse = creationSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'libellé, adresse et mode d’authentification requis' });
    const { label, baseUrl, authKind, authHeaderName, authSecret } = parse.data;
    if (!adresseAcceptable(baseUrl)) {
      return reply.code(400).send({ error: 'adresse refusée : elle doit être publique et en HTTPS' });
    }
    const pb = authCoherente(authKind, authSecret, authHeaderName);
    if (pb) return reply.code(400).send({ error: pb });
    try {
      const source = await deps.sources.creer(tenant, {
        kind: 'http', label, baseUrl, authKind,
        ...(authHeaderName ? { authHeaderName } : {}),
        ...(authSecret ? { authSecret } : {}),
      });
      // L'hôte, pas l'adresse complète : il répond à « où partent les données » sans graver le chemin.
      await journal(tenant, req, 'connecteur.cree', { kind: 'connecteur', id: source.id }, { authKind, hote: hoteDe(baseUrl) });
      return reply.code(201).send({ source });
    } catch (err) {
      if (err instanceof LabelSourceDejaPris) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.patch(`${base}/:id`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'source introuvable' });
    const parse = patchSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'corps invalide' });
    const p = parse.data;
    if (p.baseUrl !== undefined && !adresseAcceptable(p.baseUrl)) {
      return reply.code(400).send({ error: 'adresse refusée : elle doit être publique et en HTTPS' });
    }
    // L'état effectif après écriture, jamais le seul corps : sans ça, passer en `bearer` sans renvoyer le
    // secret (qui existe déjà) serait refusé à tort, et le refus ne fermerait le trou que dans un sens.
    const actuelle = await connecteurHttp(tenant, id);
    if (!actuelle) return reply.code(404).send({ error: 'source introuvable' });
    const authKind = p.authKind ?? actuelle.authKind;
    const entete = p.authHeaderName !== undefined ? p.authHeaderName : actuelle.authHeaderName;
    const aSecret = p.authSecret !== undefined ? p.authSecret : (actuelle.aAuthentification ? 'inchange' : undefined);
    const pb = authCoherente(authKind, aSecret, entete);
    if (pb) return reply.code(400).send({ error: pb });
    try {
      const source = await deps.sources.patch(tenant, id, p);
      if (!source) return reply.code(404).send({ error: 'source introuvable' });
      // `adresseChangee` est le fait qui compte : c'est le seul geste qui redirige tout ce qui part.
      await journal(tenant, req, 'connecteur.modifie', { kind: 'connecteur', id }, {
        authKind, adresseChangee: p.baseUrl !== undefined && p.baseUrl !== actuelle.baseUrl,
        ...(p.baseUrl !== undefined ? { hote: hoteDe(p.baseUrl) } : {}),
      });
      return reply.code(200).send({ source });
    } catch (err) {
      if (err instanceof LabelSourceDejaPris) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.delete(`${base}/:id`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'source introuvable' });
    const actuelle = await connecteurHttp(tenant, id);
    if (!actuelle) return reply.code(404).send({ error: 'source introuvable' });
    // La cascade emporterait les outils sans bruit : on refuse et on nomme le nombre (le client désactive d'abord,
    // il supprime ensuite).
    if (actuelle.outilsActifs > 0) {
      return reply.code(409).send({ error: `${actuelle.outilsActifs} outil(s) actif(s) utilisent cette source : désactivez-les d’abord` });
    }
    const supprime = await deps.sources.supprimer(tenant, id);
    if (supprime) await journal(tenant, req, 'connecteur.supprime', { kind: 'connecteur', id });
    return reply.code(200).send({ id, deleted: supprime });
  });

  app.post(`${base}/:id/epreuve`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'source introuvable' });
    const parse = epreuveSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'chemin invalide' });
    if (!(await connecteurHttp(tenant, id))) return reply.code(404).send({ error: 'source introuvable' });
    // Le résultat d'une épreuve est une information, pas une erreur de la console : un connecteur qui ne répond
    // pas rend 200 avec `ok: false`.
    return reply.code(200).send(await deps.eprouver(tenant, id, parse.data.chemin));
  });
}
