import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import { LabelSourceDejaPris, type SourceVue } from '../agent/sources';
import { construireCible } from '../agent/http-cible';
import { scopeTenant, estUuid } from './scope';

/**
 * Les SOURCES externes d'outils : déclarer le système du client, et savoir qu'il répond encore.
 *
 * 🔴 CE QUE CES ROUTES ACCORDENT VRAIMENT. Une source, c'est une adresse réseau que le serveur ira appeler
 * depuis l'intérieur du réseau Docker du VPS, et un secret. Trois gardes vivent ici :
 *
 *  1. **L'adresse est validée À L'ÉCRITURE**, pas seulement à l'appel : la refuser au moment de l'appel
 *     reviendrait à la découvrir en pleine conversation avec un contact. `construireCible` est la MÊME
 *     fonction que celle du résolveur, donc il n'existe pas deux définitions de « adresse acceptable ».
 *  2. **Le secret ne se relit jamais.** Aucune route ne le rend ; un champ vide dans un patch veut dire
 *     « inchangé », parce que l'écran ne peut pas renvoyer ce qu'il n'a jamais eu.
 *  3. **Supprimer une source dont des outils ACTIFS dépendent est refusé** (409). La cascade ferait
 *     disparaître les outils sans bruit, et l'agent deviendrait muet sur ces gestes-là, en production,
 *     sans que personne ne l'ait décidé.
 */

export interface AgentSourcesRouteDeps {
  lister(tenantId: string): Promise<SourceVue[]>;
  parId(tenantId: string, id: string): Promise<SourceVue | null>;
  creer(tenantId: string, input: { kind: 'http'; label: string; baseUrl: string; authKind: 'none' | 'bearer' | 'header'; authHeaderName?: string; authSecret?: string }): Promise<SourceVue>;
  patch(tenantId: string, id: string, patch: Record<string, unknown>): Promise<SourceVue | null>;
  supprimer(tenantId: string, id: string): Promise<boolean>;
  /**
   * Éprouve la source pour de vrai : un appel, et le résultat écrit sur la ligne.
   *
   * 🔴 C'est le seul moyen de voir un jeton mort AVANT qu'un contact ne le découvre. Un jeton expiré ne
   * produit aucune erreur applicative côté client : l'agent dégrade en silence, au milieu d'une conversation.
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

/** L'adresse est-elle acceptable ? MÊME fonction que le résolveur : une seconde définition finirait par
 *  accepter à l'écriture ce que l'appel refuse, donc par promettre un connecteur qui ne marchera jamais. */
function adresseAcceptable(baseUrl: string): boolean {
  return construireCible({ baseUrl, binding: { methode: 'GET', chemin: '/' }, args: {} }).ok;
}

/** L'authentification déclarée tient-elle debout ? Rejoué ici parce que la contrainte de la 0088 refuserait
 *  de toute façon, mais en 500, dont Cloudflare remplace le corps. */
function authCoherente(authKind: string, secret: string | undefined, entete: string | null | undefined): string | null {
  if (authKind === 'none') return null;
  if (!secret) return 'un secret est requis pour ce mode d’authentification';
  if (authKind === 'header' && !entete) return 'le nom de l’en-tête est requis';
  return null;
}

export function registerAgentSources(app: FastifyInstance, deps: AgentSourcesRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};
  const base = '/tenants/:tenantId/agent-sources';

  app.get(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ sources: await deps.lister(tenant) });
  });

  app.post(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const parse = creationSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'libellé, adresse et mode d’authentification requis' });
    const { label, baseUrl, authKind, authHeaderName, authSecret } = parse.data;
    if (!adresseAcceptable(baseUrl)) {
      return reply.code(400).send({ error: 'adresse refusée : elle doit être publique et en HTTPS' });
    }
    const pb = authCoherente(authKind, authSecret, authHeaderName);
    if (pb) return reply.code(400).send({ error: pb });
    try {
      const source = await deps.creer(tenant, {
        kind: 'http', label, baseUrl, authKind,
        ...(authHeaderName ? { authHeaderName } : {}),
        ...(authSecret ? { authSecret } : {}),
      });
      return reply.code(201).send({ source });
    } catch (err) {
      if (err instanceof LabelSourceDejaPris) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.patch(`${base}/:id`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'source introuvable' });
    const parse = patchSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'corps invalide' });
    const p = parse.data;
    if (p.baseUrl !== undefined && !adresseAcceptable(p.baseUrl)) {
      return reply.code(400).send({ error: 'adresse refusée : elle doit être publique et en HTTPS' });
    }
    // L'état EFFECTIF après écriture, jamais le seul corps : sans ça, passer en `bearer` sans renvoyer le
    // secret (qui existe déjà) serait refusé à tort, et le refus ne fermerait le trou que dans un sens.
    const actuelle = await deps.parId(tenant, id);
    if (!actuelle) return reply.code(404).send({ error: 'source introuvable' });
    const authKind = p.authKind ?? actuelle.authKind;
    const entete = p.authHeaderName !== undefined ? p.authHeaderName : actuelle.authHeaderName;
    const aSecret = p.authSecret !== undefined ? p.authSecret : (actuelle.aAuthentification ? 'inchange' : undefined);
    const pb = authCoherente(authKind, aSecret, entete);
    if (pb) return reply.code(400).send({ error: pb });
    try {
      const source = await deps.patch(tenant, id, p);
      if (!source) return reply.code(404).send({ error: 'source introuvable' });
      return reply.code(200).send({ source });
    } catch (err) {
      if (err instanceof LabelSourceDejaPris) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.delete(`${base}/:id`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'source introuvable' });
    const actuelle = await deps.parId(tenant, id);
    if (!actuelle) return reply.code(404).send({ error: 'source introuvable' });
    // 🔴 La cascade emporterait les outils SANS BRUIT, et l'agent deviendrait muet sur ces gestes-là, en
    // production. On refuse et on nomme le nombre : le client désactive d'abord, il supprime ensuite.
    if (actuelle.outilsActifs > 0) {
      return reply.code(409).send({ error: `${actuelle.outilsActifs} outil(s) actif(s) utilisent cette source : désactivez-les d’abord` });
    }
    return reply.code(200).send({ id, deleted: await deps.supprimer(tenant, id) });
  });

  app.post(`${base}/:id/epreuve`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'source introuvable' });
    const parse = epreuveSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'chemin invalide' });
    if (!(await deps.parId(tenant, id))) return reply.code(404).send({ error: 'source introuvable' });
    // Le résultat d'une épreuve est une INFORMATION, pas une erreur de la console : un connecteur qui ne
    // répond pas rend 200 avec `ok: false`, sinon Cloudflare remplacerait le corps et le client ne saurait
    // même pas ce qui a échoué.
    return reply.code(200).send(await deps.eprouver(tenant, id, parse.data.chemin));
  });
}
