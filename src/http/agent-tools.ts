import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resumeEnvoi, type RequeteConnecteur } from '../agent/requetes';
import type { Guard } from '../auth/middleware';
import type { OutilComplet, PatchOutil } from '../agent/catalog';
import { NomOutilDejaPris } from '../agent/catalog';
import { OUTILS_MAISON, outilExpose, outilMaison, paramsInitiaux, type OutilExpose } from '../agent/outils-maison';
import { risqueAuMoins, risqueSelonMethode, type MethodeConnecteur } from '../agent/http-cible';
import type { SortieAgent } from '../agent/agent-store';
import { scopeTenant, estUuid } from './scope';
import { OutilNonActivable } from '../agent/catalog';
import { gestesSchema } from '../agent/gestes';

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
  /**
   * Déclare un outil de CONNECTEUR sur une source du tenant (lot L2).
   *
   * Séparée de `ajouter` exprès : l'ajout maison prend son `handler` dans le catalogue et refuse tout le
   * reste, c'est sa garde. Les fusionner ferait une route dont la moitié des gardes ne s'appliquent qu'à la
   * moitié des corps, et c'est ainsi qu'on finit par accepter un `handler` inventé.
   */
  ajouterConnecteur?(tenantId: string, agentId: string, outil: {
    sourceId: string; requestId: string; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; risk: OutilComplet['risk'];
    /** Ce que CET agent fait de la réponse, et les champs qu'il lit quand il l'intègre (migration 0150). */
    nature: OutilComplet['nature']; outputPaths: readonly string[];
  }): Promise<OutilComplet | null>;
  /**
   * La REQUÊTE que l'outil va désigner (migration 0105), ou `null` si elle n'est pas de ce tenant.
   *
   * 🔴 C'est elle qui porte la méthode, le chemin, le corps et les variables : l'outil ne les redécrit plus.
   * On la LIT ici plutôt que de faire confiance au corps de la requête HTTP, parce que le risque plancher et
   * le résumé de ce qui sera envoyé en dérivent, et qu'ils doivent décrire l'appel RÉEL.
   */
  requetePourOutil?(tenantId: string, requeteId: string): Promise<RequeteConnecteur | null>;
  patch(tenantId: string, agentId: string, outilId: string, patch: PatchOutil): Promise<OutilComplet | null>;
  activer(tenantId: string, agentId: string, outilId: string, actif: boolean, parUtilisateur: string): Promise<OutilComplet | null>;
  autonomie(tenantId: string, agentId: string, outilId: string, autonome: boolean, parUtilisateur: string): Promise<OutilComplet | null>;
  /**
   * Retire l'outil de CET agent. La définition reste tant qu'un autre consommateur s'en sert ; une action ou
   * un connecteur HTTP qui perd son dernier consommateur part avec lui, un outil MCP reste (2026-09-21).
   *
   * 🔴 ELLE S'APPELAIT `retirer` ET ELLE SUPPRIMAIT POUR TOUT LE MONDE. Le renommage n'est pas cosmétique :
   * après 0127 les deux gestes existent, et un nom qui ne dit pas lequel il fait finirait par faire le
   * mauvais, depuis l'écran d'un seul agent, en rendant muets ceux qu'on ne regardait pas.
   */
  detacher(tenantId: string, agentId: string, outilId: string): Promise<boolean>;
  /** Rend un outil de la bibliothèque de l'espace disponible pour cet agent, INACTIF. */
  rattacher(tenantId: string, agentId: string, outilId: string): Promise<boolean>;
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
  /**
   * LES GESTES DU MOMENT (migration 0158) : ce que NOUS faisons quand il se produit, sans le demander au
   * modèle. Un tableau VIDE est un effacement volontaire, l'absence du champ ne touche à rien.
   *
   * ⚠️ LE MÊME SCHÉMA QUE LE RUNTIME, importé et non recopié : deux descriptions de la même forme
   * finiraient par diverger, et c'est l'écriture qui gagnerait, donc une ligne que la lecture jetterait.
   */
  gestes: gestesSchema.optional(),
});
const drapeauSchema = z.object({ valeur: z.boolean() });

/**
 * Brancher une REQUÊTE de la bibliothèque sur cet agent (migration 0105).
 *
 * 🔴 L'APPEL N'EST PLUS DÉCRIT ICI. Avant, la méthode, le chemin, les paramètres et les champs à lire étaient
 * dans ce corps, donc redécrits pour chaque agent qui se servait du même appel, et le corriger quelque part
 * ne le corrigeait pas ailleurs. On ne saisit plus que les MOTS : le nom exposé au modèle, à quoi ça sert, et
 * quand ne pas l'appeler. Le reste vient de la requête, qui a déjà été éprouvée avec son bouton Test.
 */
const ajoutConnecteurSchema = z.object({
  requeteId: z.string().uuid(),
  /**
   * Ce que CET agent fait de la réponse, et les champs qu'il lit (migration 0150).
   *
   * 🔴 OBLIGATOIRES DEPUIS QUE L'ÉCRAN LES POSE. Ils ont été optionnels le temps d'un déploiement, parce que
   * l'API et la console partent séparément : l'ordre est donc CONSOLE D'ABORD (Vercel, automatique au push),
   * API ENSUITE. L'inverse rendrait 400 à chaque rattachement tant que la console n'a pas suivi.
   *
   * ⚠️ `nature` N'A PAS DE DÉFAUT, ET C'EST LE POINT. Un défaut ferait retomber un appelant distrait sur
   * `integre`, c'est-à-dire sur la question qu'on a précisément décidé de POSER plutôt que de deviner.
   */
  nature: z.enum(['pousse', 'integre']),
  outputPaths: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  name: NOM,
  title: TEXTE(120).min(1),
  description: TEXTE(2000).min(1),
  nePasUtiliser: TEXTE(2000).min(1),
  risk: z.enum(['read', 'write', 'irreversible']).optional(),
});

export function registerAgentTools(app: FastifyInstance, deps: AgentToolsRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const base = '/tenants/:tenantId/agents/:agentId/tools';

  function contexte(req: { params: unknown; auth?: { tenantId: string; userId: string } }):
  { tenant: string; agentId: string; userId: string } | { code: 403 | 404; error: string } {
    const tenant = scopeTenant(req);
    if (tenant === null) return { code: 403, error: 'tenant interdit' };
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) return { code: 404, error: 'agent introuvable' };
    // L'identité de l'activateur vient du JETON. Sans jeton, il n'y a personne à nommer et l'activation est
    // refusée plus bas : la contrainte de la base dit la même chose.
    // ⚠️ Ce commentaire citait « montage sans garde » comme cause possible : ce n'est plus une cause depuis
    // le lot 2 du plan 2026-09-14, la garde est requise. Le repli reste juste pour les tests qui montent avec
    // `gardeOuverte` et n'ont donc pas de `req.auth`.
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

  /**
   * Déclarer un outil de CONNECTEUR sur une source (lot L2).
   *
   * Trois gardes, et elles sont toutes ici :
   *  1. la SOURCE appartient au tenant (sinon 404), sans quoi la clé étrangère lèverait en 500 ;
   *  2. le RISQUE dérive de la méthode et ne peut être que MONTÉ (décision D-L2-1) : un client qui déclare
   *     `read` un `DELETE` désarmerait la garde d'autonomie sur une action irréversible ;
   *  3. l'outil naît INACTIF, comme un outil maison : l'activation est un geste humain séparé, et la
   *     migration 0086 refuse un actif sans activateur.
   */
  app.post(`${base}/connecteur`, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    if (!deps.ajouterConnecteur || !deps.requetePourOutil) {
      return reply.code(503).send({ error: 'les connecteurs ne sont pas disponibles sur cette instance' });
    }
    const parse = ajoutConnecteurSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply.code(400).send({ error: 'requête, nom et mots requis' });
    }
    const d = parse.data;
    // La requête est LUE, pas crue sur parole : le risque plancher et le résumé de ce qui sera envoyé en
    // dérivent, et ils doivent décrire l'appel RÉEL, pas ce que le corps de la requête HTTP prétend.
    const requete = await deps.requetePourOutil(ctx.tenant, d.requeteId);
    if (!requete) return reply.code(404).send({ error: 'requête introuvable' });

    /**
     * 🔴 UNE GARDE DE COHÉRENCE, PAS DEUX CHAMPS INDÉPENDANTS. « Intègre » sans champ produirait un outil qui
     * refuse chaque appel en pleine conversation (`resolvers/http.ts` le refuse alors proprement, mais loin
     * de l'écran où le geste a été fait). Le refuser ICI, c'est le dire là où le client peut corriger.
     *
     * ⚠️ L'INVERSE AUSSI, ET IL EST MOINS ÉVIDENT : des champs cochés sur un « pousse » seraient ignorés en
     * silence par le résolveur, donc l'écran promettrait une lecture qui n'a pas lieu. Le magasin les force
     * déjà à vide ; refuser ici en plus fait qu'aucun des deux ne porte seul la cohérence.
     */
    if (d.nature === 'integre' && d.outputPaths.length === 0) {
      return reply.code(400).send({
        error: 'choisissez au moins une information à récupérer, ou déclarez que cet appel pousse seulement',
      });
    }
    if (d.nature === 'pousse' && d.outputPaths.length > 0) {
      return reply.code(400).send({ error: 'un appel qui pousse ne lit aucun champ' });
    }

    const plancher = risqueSelonMethode(requete.methode as MethodeConnecteur);
    const risk = d.risk ?? plancher;
    if (!risqueAuMoins(plancher, risk)) {
      return reply.code(400).send({ error: `un appel ${requete.methode} vaut au moins « ${plancher} » : le risque ne peut pas être abaissé` });
    }
    // Ce que le MODÈLE voit, DÉRIVÉ des variables de la requête dont l'origine est `modele`. Les autres
    // (champ du contact, valeur système, constante) sont résolues par le serveur : les exposer au modèle
    // l'inviterait à les fournir lui-même, donc à désigner la ressource d'un autre.
    const params = requete.variables
      .filter((v) => v.origine.type === 'modele')
      .map((v) => ({
        name: v.nom, type: v.type, source: 'modele' as const,
        ...(v.description ? { description: v.description } : {}),
        ...(v.requis ? { required: true } : {}),
        ...(v.enum && v.enum.length > 0 ? { enum: v.enum } : {}),
      }));
    try {
      const outil = await deps.ajouterConnecteur(ctx.tenant, ctx.agentId, {
        sourceId: requete.sourceId,
        requestId: requete.id,
        name: d.name,
        title: d.title,
        description: d.description,
        nePasUtiliser: d.nePasUtiliser,
        nature: d.nature,
        outputPaths: d.outputPaths,
        params,
        risk,
      });
      if (!outil) return reply.code(404).send({ error: 'agent introuvable' });
      const sorties = (await deps.sortiesDeLAgent(ctx.tenant, ctx.agentId)) ?? [];
      // 🔴 CE QUI PARTIRA, rendu avec l'outil pour que l'écran le fasse confirmer. C'est le seul moment où le
      // client peut s'apercevoir qu'un connecteur enverra le dernier message de ses contacts à un tiers.
      return reply.code(201).send({ outil: vue(outil, sorties), envoi: resumeEnvoi(requete) });
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
    /**
     * ⚠️ LE REFUS PORTE SA RAISON, ET ELLE VIENT DU SERVEUR DISTANT. Un outil importé dont le schéma n'est
     * pas représentable, ou qui a disparu du serveur, ne s'active pas : le client ne peut pas corriger ça
     * lui-même, mais il doit pouvoir le dire à son fournisseur. Un 404 « outil introuvable » l'enverrait
     * chercher une ligne qui existe.
     */
    let outil: OutilComplet | null;
    try {
      outil = await ecrire(ctx.tenant, ctx.agentId, outilId, parse.data.valeur, ctx.userId);
    } catch (err) {
      if (err instanceof OutilNonActivable) return reply.code(409).send({ error: err.raison });
      throw err;
    }
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
    // DÉTACHE un CONNECTEUR, SUPPRIME une ACTION, et c'est le store qui tranche sur `agent_id` (0157).
    // Un connecteur appartient à l'espace et se partage, donc on ne retire que le consentement ; une action
    // n'appartient qu'à cet agent, et la laisser derrière ferait un orphelin qu'aucun écran ne montre et
    // qu'aucun geste n'efface, dont le nom resterait pris. Voir `PgToolCatalog.detacher`.
    const detache = await deps.detacher(ctx.tenant, ctx.agentId, outilId);
    if (!detache) return reply.code(404).send({ error: 'outil introuvable' });
    return reply.code(204).send();
  });

  /**
   * Rattacher ou détacher un outil de la bibliothèque, pour cet agent.
   *
   * ⚠️ SÉPARÉE DE `activation`, et pas fondue dedans : rattacher rend l'outil DISPONIBLE, activer l'expose
   * au modèle. Un seul geste qui ferait les deux exposerait au modèle un outil dont personne n'a relu les
   * mots, ce que la migration 0086 existe précisément pour empêcher.
   */
  app.put(`${base}/:outilId/rattachement`, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const { outilId } = req.params as { outilId: string };
    if (!estUuid(outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    const parse = drapeauSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'valeur booléenne requise' });
    const fait = parse.data.valeur
      ? await deps.rattacher(ctx.tenant, ctx.agentId, outilId)
      : await deps.detacher(ctx.tenant, ctx.agentId, outilId);
    if (!fait) return reply.code(404).send({ error: 'outil introuvable' });
    return reply.code(200).send({ rattache: parse.data.valeur });
  });
}
