import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import type { OutilComplet, PatchOutil } from '../agent/catalog';
import { NomOutilDejaPris } from '../agent/catalog';
import { OUTILS_MAISON, outilExpose, outilMaison, paramsInitiaux, type OutilExpose } from '../agent/outils-maison';
import type { SortieAgent } from '../agent/agent-store';
import { scopeTenant, estUuid } from './scope';

/**
 * Les outils d'un agent IA : les lui donner, et ne les lui donner que quand un humain l'a dit.
 *
 * 🔴 CE QUE CES ROUTES ACCORDENT VRAIMENT. Un outil actif est exposé au modèle et exécutable par lui, donc
 * par un texte qu'un contact influence. Trois gardes vivent ici et nulle part ailleurs :
 *
 *  1. **Le `handler` vient du CATALOGUE, jamais du corps.** Les seuls comportements qui existent sont ceux de
 *     `resolvers/mba.ts` ; un handler inventé ferait un outil actif qui refuse à chaque appel, donc un agent
 *     qui « ne fait rien » sans trace lisible pour le client.
 *  2. **L'activation et l'autonomie portent le nom de qui les a posées, pris sur le JETON.** La spec MCP
 *     exige un consentement humain avant l'invocation d'un outil ; notre agent n'a pas d'humain au runtime,
 *     le consentement est donc déplacé vers la configuration, et la migration 0086 le rend incontournable
 *     en base. Lire cette identité dans le corps ferait désigner à l'appelant qui a consenti à sa place.
 *  3. **Le risque n'est PAS modifiable.** Il vient du catalogue : le client règle l'autonomie, pas la
 *     dangerosité.
 */

export interface AgentToolsRouteDeps {
  listToutes(tenantId: string, agentId: string): Promise<OutilComplet[]>;
  ajouter(tenantId: string, agentId: string, outil: {
    handler: string; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; risk: OutilComplet['risk'];
  }): Promise<OutilComplet | null>;
  patch(tenantId: string, agentId: string, outilId: string, patch: PatchOutil): Promise<OutilComplet | null>;
  activer(tenantId: string, agentId: string, outilId: string, actif: boolean, parUtilisateur: string): Promise<OutilComplet | null>;
  autonomie(tenantId: string, agentId: string, outilId: string, autonome: boolean, parUtilisateur: string): Promise<OutilComplet | null>;
  retirer(tenantId: string, agentId: string, outilId: string): Promise<boolean>;
  /** Les règles d'arrêt de la fiche : c'est d'elles que dérive l'énumération de l'outil « terminer ». */
  sortiesDeLAgent(tenantId: string, agentId: string): Promise<SortieAgent[] | null>;
}

/** Nom EXPOSÉ au modèle. Charset commun OpenAI et Gemini, rejoué depuis le `check` de la migration 0086 :
 *  la base refuserait de toute façon, mais en 500, dont Cloudflare remplace le corps. */
const NOM = z.string().trim().regex(/^[a-z0-9_]{1,64}$/, 'minuscules, chiffres et tirets bas, 64 au plus');
const TEXTE = (max: number) => z.string().trim().max(max);
const ajoutSchema = z.object({ handler: z.string().trim().min(1).max(64), name: NOM.optional() });
const patchSchema = z.object({
  name: NOM.optional(),
  title: TEXTE(120).min(1).optional(),
  description: TEXTE(2000).min(1).optional(),
  nePasUtiliser: TEXTE(2000).optional(),
  /** Valeurs autorisées par paramètre. Une liste vide est un effacement volontaire, pas une absence. */
  enums: z.record(z.string(), z.array(z.string().trim().min(1).max(120)).max(50)).optional(),
});
const drapeauSchema = z.object({ valeur: z.boolean() });

export function registerAgentTools(app: FastifyInstance, deps: AgentToolsRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};
  const base = '/tenants/:tenantId/agents/:agentId/tools';

  function contexte(req: { params: unknown; auth?: { tenantId: string; userId: string } }):
  { tenant: string; agentId: string; userId: string } | { code: 403 | 404; error: string } {
    const tenant = scopeTenant(req);
    if (tenant === null) return { code: 403, error: 'tenant interdit' };
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) return { code: 404, error: 'agent introuvable' };
    // L'identité de l'activateur vient du JETON. Sans jeton (montage sans garde), il n'y a personne à nommer
    // et l'activation est refusée plus bas : la contrainte de la base dit la même chose.
    return { tenant, agentId, userId: req.auth?.userId ?? '' };
  }

  /**
   * L'outil, plus ce que le MODÈLE en voit. Le client règle des mots qui pilotent un appel de fonction : lui
   * montrer le schéma réel est le seul moyen honnête de lui faire vérifier ce qu'il a écrit.
   *
   * `expose: null` a un sens précis et l'écran doit le dire : l'outil est déclaré et actif, mais le modèle
   * n'en voit RIEN. C'est le cas de « terminer » tant qu'aucune règle d'arrêt n'existe sur la fiche.
   */
  function vue(outil: OutilComplet, sorties: SortieAgent[]): OutilComplet & { expose: OutilExpose | null } {
    return { ...outil, expose: outilExpose(outil, sorties) };
  }

  /** Le catalogue, tel que l'écran le propose. Rendu par la route de liste : le client ne devine pas ce qui
   *  existe, et le front n'a pas à recopier une liste qui vit côté serveur. */
  const CATALOGUE = OUTILS_MAISON.map((o) => ({
    handler: o.handler, nomDefaut: o.nomDefaut, titre: o.titre, description: o.description,
    nePasUtiliser: o.nePasUtiliser, risk: o.risk,
    params: o.params.map((p) => ({ name: p.name, edition: p.edition, ...(p.aideEnum ? { aideEnum: p.aideEnum } : {}) })),
  }));

  app.get(base, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const sorties = await deps.sortiesDeLAgent(ctx.tenant, ctx.agentId);
    if (sorties === null) return reply.code(404).send({ error: 'agent introuvable' });
    const outils = await deps.listToutes(ctx.tenant, ctx.agentId);
    return reply.code(200).send({ outils: outils.map((o) => vue(o, sorties)), catalogue: CATALOGUE });
  });

  app.post(base, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const parse = ajoutSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'handler requis, nom au format [a-z0-9_]' });
    // 🔴 Le modèle d'outil vient du catalogue, jamais du corps : titre, mots, paramètres et RISQUE avec lui.
    const modele = outilMaison(parse.data.handler);
    if (!modele) return reply.code(400).send({ error: 'outil inconnu' });
    try {
      const outil = await deps.ajouter(ctx.tenant, ctx.agentId, {
        handler: modele.handler,
        name: parse.data.name ?? modele.nomDefaut,
        title: modele.titre.fr,
        description: modele.description.fr,
        nePasUtiliser: modele.nePasUtiliser.fr,
        params: paramsInitiaux(modele),
        risk: modele.risk,
      });
      if (!outil) return reply.code(404).send({ error: 'agent introuvable' });
      const sorties = (await deps.sortiesDeLAgent(ctx.tenant, ctx.agentId)) ?? [];
      return reply.code(201).send({ outil: vue(outil, sorties) });
    } catch (err) {
      if (err instanceof NomOutilDejaPris) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.patch(`${base}/:outilId`, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const { outilId } = req.params as { outilId: string };
    if (!estUuid(outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    const parse = patchSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      const detail = parse.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');
      return reply.code(400).send({ error: `champs invalides : ${detail}` });
    }
    if (Object.keys(parse.data).length === 0) return reply.code(400).send({ error: 'aucun champ à modifier' });
    // 🔴 Une énumération ne se pose QUE sur un paramètre que le catalogue ouvre. Sans ce contrôle, un appel
    // direct pourrait restreindre `requete` ou `valeur`, que rien n'a prévu comme restreignables : l'outil
    // deviendrait inappelable sur des valeurs légitimes, et le client n'aurait aucun écran pour le défaire.
    if (parse.data.enums) {
      const outils = await deps.listToutes(ctx.tenant, ctx.agentId);
      const cible = outils.find((o) => o.id === outilId);
      if (!cible) return reply.code(404).send({ error: 'outil introuvable' });
      const modele = outilMaison(String(cible.binding.handler ?? ''));
      const ouverts = new Set((modele?.params ?? []).filter((p) => p.edition === 'enum').map((p) => p.name));
      const refuses = Object.keys(parse.data.enums).filter((n) => !ouverts.has(n));
      if (refuses.length > 0) {
        return reply.code(400).send({ error: `paramètre sans liste de valeurs : ${refuses.join(', ')}` });
      }
    }
    try {
      const outil = await deps.patch(ctx.tenant, ctx.agentId, outilId, parse.data);
      if (!outil) return reply.code(404).send({ error: 'outil introuvable' });
      const sorties = (await deps.sortiesDeLAgent(ctx.tenant, ctx.agentId)) ?? [];
      return reply.code(200).send({ outil: vue(outil, sorties) });
    } catch (err) {
      if (err instanceof NomOutilDejaPris) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  /**
   * Mise en service, et autonomie sur une action irréversible. Deux gestes, une seule mécanique : un drapeau
   * qui porte le NOM de celui qui l'a posé, pris sur le jeton.
   */
  async function poserDrapeau(
    req: Parameters<typeof contexte>[0], reply: { code(n: number): { send(b: unknown): unknown } },
    outilId: string, corps: unknown,
    ecrire: (tenant: string, agentId: string, id: string, valeur: boolean, par: string) => Promise<OutilComplet | null>,
  ) {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    if (!estUuid(outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    const parse = drapeauSchema.safeParse(corps ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'valeur booléenne requise' });
    // Poser le drapeau exige de savoir QUI : la migration 0086 l'exige en base, et une route qui écrirait un
    // actif sans activateur remonterait un 500 illisible au lieu d'un refus explicable.
    if (parse.data.valeur && ctx.userId === '') {
      return reply.code(403).send({ error: 'activation impossible sans utilisateur identifié' });
    }
    const outil = await ecrire(ctx.tenant, ctx.agentId, outilId, parse.data.valeur, ctx.userId);
    if (!outil) return reply.code(404).send({ error: 'outil introuvable' });
    const sorties = (await deps.sortiesDeLAgent(ctx.tenant, ctx.agentId)) ?? [];
    return reply.code(200).send({ outil: vue(outil, sorties) });
  }

  app.put(`${base}/:outilId/activation`, opts, async (req, reply) => {
    const { outilId } = req.params as { outilId: string };
    return poserDrapeau(req, reply, outilId, req.body, (t, a, i, v, par) => deps.activer(t, a, i, v, par));
  });

  app.put(`${base}/:outilId/autonomie`, opts, async (req, reply) => {
    const { outilId } = req.params as { outilId: string };
    return poserDrapeau(req, reply, outilId, req.body, (t, a, i, v, par) => deps.autonomie(t, a, i, v, par));
  });

  app.delete(`${base}/:outilId`, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const { outilId } = req.params as { outilId: string };
    if (!estUuid(outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    const retire = await deps.retirer(ctx.tenant, ctx.agentId, outilId);
    if (!retire) return reply.code(404).send({ error: 'outil introuvable' });
    return reply.code(204).send();
  });
}
