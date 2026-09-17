import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import { LabelSourceDejaPris, type SourceVue } from '../agent/sources';
import { construireCible } from '../agent/http-cible';
import { scopeTenant, estUuid } from './scope';
import { makeJournal, type AuditSink } from '../audit/journal';

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
  /**
   * Journal d'audit (2026-09-16). Optionnel : absent -> aucune trace (câblages de test).
   *
   * 🔴 UN CONNECTEUR EST LA SORTIE DE L'ESPACE. Il porte l'adresse du système du client et son secret : c'est
   * par lui que des données quittent le produit, et c'est lui que l'agent de Meta appelle EN DIRECT. Changer
   * son adresse change la destination de tout ce qui part, sans qu'aucun écran ne le crie.
   *
   * 🔴 LE `detail` NE PORTE JAMAIS LE SECRET, ET PAS NON PLUS L'ADRESSE COMPLÈTE : seulement le MODE
   * d'authentification et l'HÔTE. L'hôte répond à « où partent les données », qui est la question ; le chemin
   * complet et le secret donneraient de quoi rejouer l'appel depuis une table qu'on ne purge jamais.
   */
  audit?: AuditSink;
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
/**
 * ⚠️ EXPORTÉE POUR LES CONNECTEURS MCP (2026-09-17), qui doivent valider LA MÊME adresse. Une seconde
 * définition finirait par accepter ici ce que l'appel refuse là-bas, c'est-à-dire par promettre un
 * connecteur qui ne marchera jamais : le défaut que ce fichier décrit déjà pour son propre résolveur.
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
 * L'HÔTE d'une adresse, ou `null` si elle est illisible.
 *
 * ⚠️ Il ne peut pas lever : ce helper sert un JOURNAL, et une adresse mal formée ne doit pas faire échouer
 * l'action qu'on observe. Les adresses sont déjà validées par `adresseAcceptable` en amont, donc `null` ne
 * devrait jamais arriver ; il est là pour que « ne devrait jamais » n'ait pas à être vrai.
 */
export function hoteDe(url: string): string | null {
  try { return new URL(url).host; } catch { return null; }
}

export function registerAgentSources(app: FastifyInstance, deps: AgentSourcesRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const journal = makeJournal(deps.audit);
  const base = '/tenants/:tenantId/agent-sources';

  app.get(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    /**
     * 🔴 SEULEMENT LES CONNECTEURS HTTP (2026-09-17). Cet écran s'appelle « Connecteurs API », son
     * formulaire demande une adresse de BASE sous laquelle on compose des chemins, et son bouton
     * « éprouver » envoie un GET sur un chemin. Aucun de ces trois gestes n'a de sens pour un serveur MCP,
     * qui a UNE adresse unique et se parle en JSON-RPC : l'y laisser apparaître offrirait au client des
     * boutons qui ne peuvent pas marcher.
     *
     * ⚠️ LE FILTRE EST ICI ET NON DANS `lister`, délibérément : l'inventaire de l'assistant de
     * configuration COMPTE les serveurs MCP (`src/agent/setup/couverture.ts`), et filtrer à la source les
     * lui ferait disparaître.
     */
    const sources = await deps.lister(tenant);
    return reply.code(200).send({ sources: sources.filter((s) => s.kind === 'http') });
  });

  /**
   * LA SOURCE DE CETTE ROUTE, ET ELLE EST BIEN UN CONNECTEUR HTTP.
   *
   * 🔴 LE MIROIR EXACT DE LA GARDE POSÉE CÔTÉ MCP, et le poser d'un seul côté n'en aurait pas été une.
   * `parId` ne filtre pas le `kind` : passer l'identifiant d'un SERVEUR MCP à ces routes faisait
   * envoyer une requête HTTP ordinaire sur son point MCP (avec son secret dans l'en-tête et un chemin
   * choisi par l'appelant), réécrire son adresse et son authentification depuis l'écran des connecteurs
   * API, ou le supprimer par un chemin qui n'a pas la garde transactionnelle du store MCP.
   *
   * ⚠️ ET ON N'ÉCRIT PLUS ICI COMBIEN DE LECTEURS A CETTE TABLE, parce que ce compte a dérivé DEUX FOIS
   * dans la même journée : « trois » quand la garde a été posée côté MCP, puis « quatre » en découvrant
   * `parId`, et il y en avait encore d'autres (`sourcePourTest`, la publication du secret chez Meta).
   * Un inventaire écrit à la main dérive dès qu'on ajoute un appelant ; c'est `tests/sources-kind.test.ts`
   * qui le tient désormais, en énumérant les lecteurs depuis le CODE.
   *
   * ⚠️ `404` : pour cet écran, un serveur MCP n'est pas un connecteur interdit, c'est un connecteur qui
   * n'existe pas. La liste le filtre déjà (`kind === 'http'`), donc l'écran ne l'a jamais proposé.
   */
  async function connecteurHttp(tenant: string, id: string): Promise<SourceVue | null> {
    const s = await deps.parId(tenant, id);
    return s && s.kind === 'http' ? s : null;
  }

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
      // ⚠️ L'HÔTE, pas l'adresse complète : il répond à « où partent les données » sans graver le chemin.
      await journal(tenant, req, 'connecteur.cree', { kind: 'connecteur', id: source.id }, { authKind, hote: hoteDe(baseUrl) });
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
    const actuelle = await connecteurHttp(tenant, id);
    if (!actuelle) return reply.code(404).send({ error: 'source introuvable' });
    const authKind = p.authKind ?? actuelle.authKind;
    const entete = p.authHeaderName !== undefined ? p.authHeaderName : actuelle.authHeaderName;
    const aSecret = p.authSecret !== undefined ? p.authSecret : (actuelle.aAuthentification ? 'inchange' : undefined);
    const pb = authCoherente(authKind, aSecret, entete);
    if (pb) return reply.code(400).send({ error: pb });
    try {
      const source = await deps.patch(tenant, id, p);
      if (!source) return reply.code(404).send({ error: 'source introuvable' });
      // 🔴 `adresseChangee` est le fait qui compte : c'est le seul geste qui redirige TOUT ce qui part.
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
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'source introuvable' });
    const actuelle = await connecteurHttp(tenant, id);
    if (!actuelle) return reply.code(404).send({ error: 'source introuvable' });
    // 🔴 La cascade emporterait les outils SANS BRUIT, et l'agent deviendrait muet sur ces gestes-là, en
    // production. On refuse et on nomme le nombre : le client désactive d'abord, il supprime ensuite.
    if (actuelle.outilsActifs > 0) {
      return reply.code(409).send({ error: `${actuelle.outilsActifs} outil(s) actif(s) utilisent cette source : désactivez-les d’abord` });
    }
    const supprime = await deps.supprimer(tenant, id);
    if (supprime) await journal(tenant, req, 'connecteur.supprime', { kind: 'connecteur', id });
    return reply.code(200).send({ id, deleted: supprime });
  });

  app.post(`${base}/:id/epreuve`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'source introuvable' });
    const parse = epreuveSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'chemin invalide' });
    if (!(await connecteurHttp(tenant, id))) return reply.code(404).send({ error: 'source introuvable' });
    // Le résultat d'une épreuve est une INFORMATION, pas une erreur de la console : un connecteur qui ne
    // répond pas rend 200 avec `ok: false`, sinon Cloudflare remplacerait le corps et le client ne saurait
    // même pas ce qui a échoué.
    return reply.code(200).send(await deps.eprouver(tenant, id, parse.data.chemin));
  });
}
