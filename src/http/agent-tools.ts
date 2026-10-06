import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resumeEnvoi, type RequeteConnecteur } from '../agent/requetes';
import type { Guard } from '../auth/middleware';
import type { OutilBibliotheque, OutilComplet, PatchOutil, Rattachement } from '../agent/catalog';
import { NomOutilDejaPris, messageDuRefus, refusIntrouvable } from '../agent/catalog';
import { consommateurAgent } from '../agent/consommateur';
import {
  OUTILS_MAISON, exigeUneCible, handlerMaison, outilExpose, outilMaison, type CibleOutilAgent, type OutilExpose,
} from '../agent/outils-maison';
import { CIBLE_REQUISE, ajouterOutilMaison, lireCibleSaisie } from '../agent/reglages';
import { corpsDuRefus } from '../lib/issue';
import { risqueAuMoins, risqueSelonMethode, type MethodeConnecteur } from '../agent/http-cible';
import type { SortieAgent } from '../agent/agent-store';
import { espaceVerifie, estUuid } from './scope';
import { OutilNonActivable } from '../agent/catalog';
import { gestesSchema } from '../agent/gestes';

/**
 * Les outils d'un agent IA : les lui donner, et seulement quand un humain l'a dit. Un outil actif est exécutable
 * par le modèle, donc par un texte qu'un contact influence. Trois gardes, ici et nulle part ailleurs :
 *  1. Le `handler` vient du catalogue, jamais du corps (`resolvers/mba.ts`).
 *  2. 🔴 L'activation et l'autonomie portent le nom de qui les a posées, pris sur le jeton : c'est le
 *     consentement humain que MCP exige avant l'invocation, déplacé à la configuration et imposé en base. Le
 *     lire dans le corps ferait désigner à l'appelant qui a consenti à sa place.
 *  3. Le risque n'est pas modifiable : il vient du catalogue, le client règle l'autonomie, pas la dangerosité.
 */

/** Ce que les routes lisent et écrivent des outils d'un agent. */
export interface OutilsAgentDep {
  listToutes(tenantId: string, agentId: string): Promise<OutilComplet[]>;
  /**
   * `cible` : la cible fixée d'un outil qui en exige une (RC4), écrite comme `binding`, ou `null`. Requise : un
   * câblage qui l'oublierait poserait un outil de tag sans tag. `null` = agent inconnu de cet espace, ou scénario de
   * la cible inconnu de cet espace (404), plutôt qu'un outil qui refuserait à chaque appel.
   */
  ajouter(tenantId: string, agentId: string, outil: {
    handler: string; cible: CibleOutilAgent | null; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; risk: OutilComplet['risk'];
  }): Promise<OutilComplet | null>;
  /**
   * Déclare un outil de connecteur sur une source de l'espace. Séparée de `ajouter`, dont la garde est de prendre
   * son `handler` dans le catalogue et de refuser le reste : fusionnées, on finirait par accepter un handler inventé.
   * `null` = agent, source ou requête inconnus de cet espace (404), plutôt qu'une clé étrangère violée (500).
   */
  ajouterConnecteur(tenantId: string, agentId: string, outil: {
    sourceId: string; requestId: string; name: string; title: string; description: string; nePasUtiliser: string;
    params: unknown; risk: OutilComplet['risk'];
    /** Ce que cet agent fait de la réponse, et les champs qu'il lit quand il l'intègre. */
    nature: OutilComplet['nature']; outputPaths: readonly string[];
  }): Promise<OutilComplet | null>;
  patch(tenantId: string, agentId: string, outilId: string, patch: PatchOutil): Promise<OutilComplet | null>;
  activer(tenantId: string, agentId: string, outilId: string, actif: boolean, parUtilisateur: string): Promise<OutilComplet | null>;
  autonomie(tenantId: string, agentId: string, outilId: string, autonome: boolean, parUtilisateur: string): Promise<OutilComplet | null>;
  /**
   * Retire l'outil de cet agent. La définition reste tant qu'un autre consommateur s'en sert ; une action ou un
   * connecteur HTTP qui perd son dernier consommateur part avec lui, un outil MCP reste. Le nom dit bien qu'on
   * détache, pas qu'on supprime pour tout le monde.
   */
  detacher(tenantId: string, agentId: string, outilId: string): Promise<boolean>;
  /** Rend un outil de la bibliothèque de l'espace disponible pour cet agent, inactif. Un refus dit sa raison. */
  rattacher(tenantId: string, agentId: string, outilId: string): Promise<Rattachement>;
  /** Ce que le catalogue permet d'offrir à ce consommateur (la règle unique) : l'écran l'affiche sans filtrer. */
  offrablesPour(tenantId: string, consommateur: string): Promise<OutilBibliotheque[]>;
}

export interface AgentToolsRouteDeps {
  outils: OutilsAgentDep;
  requetes: {
    /**
     * La requête que l'outil va désigner, ou `null` si elle n'est pas de cet espace. Elle porte méthode, chemin,
     * corps et variables ; on la lit ici plutôt que de croire le corps, parce que le risque plancher et le
     * résumé de ce qui sera envoyé en dérivent.
     */
    parId(tenantId: string, requeteId: string): Promise<RequeteConnecteur | null>;
  };
  /** Les règles d'arrêt de la fiche : c'est d'elles que dérive l'énumération de l'outil « terminer ». */
  sortiesDeLAgent(tenantId: string, agentId: string): Promise<SortieAgent[] | null>;
}

/** Nom exposé au modèle. Charset commun OpenAI et Gemini, rejoué depuis le `check` en base : la base
*  refuserait de toute façon, mais en 500, dont Cloudflare remplace le corps. */
const NOM = z.string().trim().regex(/^[a-z0-9_]{1,64}$/, 'minuscules, chiffres et tirets bas, 64 au plus');
const TEXTE = (max: number) => z.string().trim().max(max);
/**
 * `cible` est lue contre le schéma du catalogue (`lireCibleSaisie`), pas ici : son `handler` vient de l'outil, jamais
 * du corps. Absente pour un outil qui n'en a pas ; une cible donnée à un tel outil est refusée (400).
 */
const ajoutSchema = z.object({ handler: z.string().trim().min(1).max(64), name: NOM.optional(), cible: z.unknown().optional() });
const patchSchema = z.object({
  /** La cible fixée d'un outil qui en a une (RC4). Même lecture qu'à la pose, `handler` imposé par l'outil. */
  cible: z.unknown().optional(),
  name: NOM.optional(),
  title: TEXTE(120).min(1).optional(),
  description: TEXTE(2000).min(1).optional(),
  nePasUtiliser: TEXTE(2000).optional(),
  /** Valeurs autorisées par paramètre. Une liste vide est un effacement volontaire, pas une absence. */
  enums: z.record(z.string(), z.array(z.string().trim().min(1).max(120)).max(50)).optional(),
  /**
   * Les gestes du moment : ce que nous faisons quand il se produit, sans le demander au modèle. Un tableau vide
   * est un effacement volontaire, l'absence du champ ne touche à rien. Même schéma que le runtime, importé.
   */
  gestes: gestesSchema.optional(),
  /**
   * Ce que l'agent fait de la réponse d'un connecteur API, et les champs qu'il lit (lot 2 du 2026-10-05). La paire
   * voyage ENSEMBLE : sa cohérence se juge sur la requête seule, sans relire l'outil, donc sans fenêtre entre une
   * lecture et l'écriture. Mêmes bornes qu'à la création.
   */
  nature: z.enum(['pousse', 'integre']).optional(),
  outputPaths: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
});
const drapeauSchema = z.object({ valeur: z.boolean() });

/**
 * La cohérence de ce qu'un appel fait de la réponse, LA MÊME à la création et à la modification : « intègre » sans
 * champ ferait un outil qui refuse chaque appel en pleine conversation, et des champs cochés sur un « pousse »
 * seraient ignorés en silence. `null` = cohérent. On refuse ici, là où le client corrige.
 */
function refusLecture(nature: 'pousse' | 'integre', champs: readonly string[]): string | null {
  if (nature === 'integre' && champs.length === 0) {
    return 'choisissez au moins une information à récupérer, ou déclarez que cet appel pousse seulement';
  }
  if (nature === 'pousse' && champs.length > 0) return 'un appel qui pousse ne lit aucun champ';
  return null;
}

/**
 * Brancher une requête de la bibliothèque sur cet agent. L'appel n'est pas décrit ici : on ne saisit que les
 * mots (nom exposé au modèle, usage, quand ne pas l'appeler), le reste vient de la requête, déjà éprouvée.
 */
const ajoutConnecteurSchema = z.object({
  requeteId: z.string().uuid(),
  /**
   * Ce que cet agent fait de la réponse, et les champs qu'il lit. Obligatoires : l'ordre de déploiement est
   * console d'abord, API ensuite. `nature` n'a pas de défaut : un appelant distrait retomberait sur `integre`,
   * alors que la question doit être posée.
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
  { tenant: string; agentId: string; userId: string } | { code: 404; error: string } {
    const tenant = espaceVerifie(req);
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) return { code: 404, error: 'agent introuvable' };
    // L'identité de l'activateur vient du jeton. Sans jeton (tests montés avec `gardeOuverte`), il n'y a personne
    // à nommer et l'activation est refusée plus bas, comme en base.
    return { tenant, agentId, userId: req.auth?.userId ?? '' };
  }

  /**
   * L'outil, plus ce que le modèle en voit. Le client règle des mots qui pilotent un appel de fonction : lui
   * montrer le schéma réel est le seul moyen honnête de lui faire vérifier ce qu'il a écrit.
   *
   * `expose: null` a un sens précis et l'écran doit le dire : l'outil est déclaré et actif, mais le modèle
   * n'en voit rien. C'est le cas de « terminer » tant qu'aucune règle d'arrêt n'existe sur la fiche.
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
    const outils = await deps.outils.listToutes(ctx.tenant, ctx.agentId);
    return reply.code(200).send({ outils: outils.map((o) => vue(o, sorties)), catalogue: CATALOGUE });
  });

  app.post(base, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const parse = ajoutSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'handler requis, nom au format [a-z0-9_]' });
    // Une cible offerte à un outil qui n'en a pas serait ignorée en silence : on la refuse.
    if (parse.data.cible !== undefined && !exigeUneCible(parse.data.handler)) {
      return reply.code(400).send({ error: 'cet outil n’a pas de cible à fixer' });
    }
    // 🔴 Le modèle d'outil vient du catalogue, jamais du corps (`ajouterOutilMaison`, que l'outil MCP
    // `set_agent_tools` appelle aussi) : titre, mots, paramètres et risque avec lui, et la cible exigée (RC4). Le
    // scénario d'une cible est cherché DANS L'ESPACE par l'écriture elle-même (`PgToolCatalog.ajouter`) : un scénario
    // d'un autre espace rend 404, comme un agent inconnu.
    const r = await ajouterOutilMaison(deps.outils, ctx.tenant, ctx.agentId, parse.data.handler, parse.data.name, parse.data.cible);
    if (!r.ok) {
      const scenarioEnJeu = r.statut === 404 && (parse.data.handler === 'envoyer_bloc' || parse.data.handler === 'lancer_scenario');
      return reply.code(r.statut).send(scenarioEnJeu ? { error: 'agent ou scénario introuvable' } : corpsDuRefus(r));
    }
    const sorties = (await deps.sortiesDeLAgent(ctx.tenant, ctx.agentId)) ?? [];
    return reply.code(201).send({ outil: vue(r.valeur, sorties) });
  });

  /**
   * Déclarer un outil de connecteur sur une source. Trois gardes :
   *  1. la source appartient à l'espace (sinon 404, au lieu d'un 500 sur la clé étrangère) ;
   *  2. le risque dérive de la méthode et ne peut qu'être monté : déclarer `read` un `DELETE` désarmerait la
   *     garde d'autonomie sur une action irréversible ;
   *  3. l'outil naît inactif : l'activation est un geste humain séparé.
   */
  app.post(`${base}/connecteur`, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const parse = ajoutConnecteurSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      return reply.code(400).send({ error: 'requête, nom et mots requis' });
    }
    const d = parse.data;
    // La requête est lue, pas crue sur parole : le risque plancher et le résumé de ce qui sera envoyé en
    // dérivent, et ils doivent décrire l'appel réel.
    const requete = await deps.requetes.parId(ctx.tenant, d.requeteId);
    if (!requete) return reply.code(404).send({ error: 'requête introuvable' });

    // Garde de cohérence de la lecture, la même que pour une modification (`refusLecture`).
    const refus = refusLecture(d.nature, d.outputPaths);
    if (refus) return reply.code(400).send({ error: refus });

    const plancher = risqueSelonMethode(requete.methode as MethodeConnecteur);
    const risk = d.risk ?? plancher;
    if (!risqueAuMoins(plancher, risk)) {
      return reply.code(400).send({ error: `un appel ${requete.methode} vaut au moins « ${plancher} » : le risque ne peut pas être abaissé` });
    }
    // Ce que le modèle voit, dérivé des variables de la requête dont l'origine est `modele`. Les autres (champ du
    // contact, valeur système, constante) sont résolues par le serveur : les exposer au modèle l'inviterait à les
    // fournir lui-même, donc à désigner la ressource d'un autre.
    const params = requete.variables
      .filter((v) => v.origine.type === 'modele')
      .map((v) => ({
        name: v.nom, type: v.type, source: 'modele' as const,
        ...(v.description ? { description: v.description } : {}),
        ...(v.requis ? { required: true } : {}),
        ...(v.enum && v.enum.length > 0 ? { enum: v.enum } : {}),
      }));
    try {
      const outil = await deps.outils.ajouterConnecteur(ctx.tenant, ctx.agentId, {
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
      // 🔴 Ce qui partira, rendu avec l'outil pour que l'écran le fasse confirmer : c'est là que le client voit
      // qu'un connecteur enverra, par exemple, le dernier message de ses contacts à un tiers.
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
    const d = parse.data;
    // La paire voyage ensemble : des champs sans nature se jugeraient sur la nature EN BASE, lue avant d'écrire.
    if (d.outputPaths !== undefined && d.nature === undefined) {
      return reply.code(400).send({ error: 'dites aussi ce que fait l’appel : les champs lus vont avec sa nature' });
    }
    if (d.nature) {
      const refus = refusLecture(d.nature, d.outputPaths ?? []);
      if (refus) return reply.code(400).send({ error: refus });
    }
    // L'outil visé, lu seulement quand le patch en dépend. Ni son origine ni son `handler` ne changent après coup :
    // cette lecture n'ouvre aucune fenêtre avec l'écriture qui suit.
    let cibleFixee: CibleOutilAgent | undefined;
    if (d.enums || d.nature || d.cible !== undefined) {
      const outils = await deps.outils.listToutes(ctx.tenant, ctx.agentId);
      const cible = outils.find((o) => o.id === outilId);
      if (!cible) return reply.code(404).send({ error: 'outil introuvable' });
      // La cible (RC4) se lit sous le `handler` de l'outil, jamais sous celui du corps : un outil de tag ne devient
      // pas un lancement de scénario. L'écriture le revérifie (`PgToolCatalog.patchConsommateur`).
      if (d.cible !== undefined) {
        const handler = handlerMaison(cible);
        if (!exigeUneCible(handler)) return reply.code(400).send({ error: 'cet outil n’a pas de cible à fixer' });
        const lue = lireCibleSaisie(handler, d.cible);
        if (!lue) return reply.code(400).send({ error: CIBLE_REQUISE[handler] });
        cibleFixee = lue;
      }
      // La nature ne se modifie ici que pour un connecteur API : un outil maison n'a rien à lire (elle y ferait croire
      // à un réglage sans effet), et un outil MCP est importé « intègre », sans écran qui le règle, bien que son
      // résolveur respecte « pousse ».
      if (d.nature && cible.origin !== 'http') {
        return reply.code(400).send({ error: 'seule la nature d’un appel de connecteur API se modifie ici' });
      }
      // Une énumération ne se pose que sur un paramètre que le catalogue ouvre : sinon un appel direct pourrait
      // restreindre `requete` ou `valeur` et rendre l'outil inappelable, sans écran pour le défaire.
      if (d.enums) {
        const modele = outilMaison(String(cible.binding.handler ?? ''));
        const ouverts = new Set((modele?.params ?? []).filter((p) => p.edition === 'enum').map((p) => p.name));
        const refuses = Object.keys(d.enums).filter((n) => !ouverts.has(n));
        if (refuses.length > 0) {
          return reply.code(400).send({ error: `paramètre sans liste de valeurs : ${refuses.join(', ')}` });
        }
      }
    }
    const { cible: _saisie, ...mots } = d;
    try {
      const outil = await deps.outils.patch(ctx.tenant, ctx.agentId, outilId, { ...mots, ...(cibleFixee ? { cible: cibleFixee } : {}) });
      // Un scénario de cible inconnu de cet espace ne s'écrit pas (`PgToolCatalog.patchConsommateur`).
      if (!outil) return reply.code(404).send({ error: cibleFixee ? 'outil ou scénario introuvable' : 'outil introuvable' });
      const sorties = (await deps.sortiesDeLAgent(ctx.tenant, ctx.agentId)) ?? [];
      return reply.code(200).send({ outil: vue(outil, sorties) });
    } catch (err) {
      if (err instanceof NomOutilDejaPris) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  /**
   * Mise en service, et autonomie sur une action irréversible. Deux gestes, une seule mécanique : un drapeau
   * qui porte le nom de celui qui l'a posé, pris sur le jeton.
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
    // Poser le drapeau exige de savoir qui : la base l'exige, et une route qui écrirait un actif sans activateur
    // remonterait un 500 illisible au lieu d'un refus explicable.
    if (parse.data.valeur && ctx.userId === '') {
      return reply.code(403).send({ error: 'activation impossible sans utilisateur identifié' });
    }
    /**
     * Le refus porte sa raison, venue du serveur distant (schéma non représentable, outil disparu) : le client ne
     * peut pas corriger ça lui-même, mais doit pouvoir le dire à son fournisseur.
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
    return poserDrapeau(req, reply, outilId, req.body, (t, a, i, v, par) => deps.outils.activer(t, a, i, v, par));
  });

  app.put(`${base}/:outilId/autonomie`, opts, async (req, reply) => {
    const { outilId } = req.params as { outilId: string };
    return poserDrapeau(req, reply, outilId, req.body, (t, a, i, v, par) => deps.outils.autonomie(t, a, i, v, par));
  });

  app.delete(`${base}/:outilId`, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const { outilId } = req.params as { outilId: string };
    if (!estUuid(outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    // Détache l'outil de cet agent ; le store tranche (`PgToolCatalog.detacher`). Une action ou un connecteur HTTP
    // que plus personne n'utilise part avec (sinon un orphelin invisible garderait son nom) ; un outil MCP reste.
    const detache = await deps.outils.detacher(ctx.tenant, ctx.agentId, outilId);
    if (!detache) return reply.code(404).send({ error: 'outil introuvable' });
    return reply.code(204).send();
  });

  /**
   * Rattacher ou détacher un outil de la bibliothèque pour cet agent. Séparé de `activation` : rattacher rend
   * l'outil disponible, activer l'expose au modèle ; un seul geste exposerait des mots que personne n'a relus.
   */
  app.put(`${base}/:outilId/rattachement`, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    const { outilId } = req.params as { outilId: string };
    if (!estUuid(outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    const parse = drapeauSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'valeur booléenne requise' });
    if (parse.data.valeur) {
      // Le refus de la porte porte sa raison : non enregistré, mort, réservé à l'agent de Meta, déjà donné, ou nom
      // déjà porté par un autre outil de cet agent (0211).
      const r = await deps.outils.rattacher(ctx.tenant, ctx.agentId, outilId);
      if (!r.ok) return reply.code(refusIntrouvable(r) ? 404 : 409).send({ error: messageDuRefus(r) });
      return reply.code(200).send({ rattache: true });
    }
    // « agent OU outil » : un détachement rend aussi `false` quand l'agent vient d'être supprimé.
    if (!(await deps.outils.detacher(ctx.tenant, ctx.agentId, outilId))) {
      return reply.code(404).send({ error: 'agent ou outil introuvable' });
    }
    return reply.code(200).send({ rattache: false });
  });

  /**
   * 🔴 CE QU'ON PEUT AJOUTER À CET AGENT, décidé par le catalogue (`offrablesPour`, la règle unique du 2026-10-02).
   * La page d'un agent IA filtrait la bibliothèque dans le navigateur, sans savoir qu'un outil était mort : elle
   * proposait un outil que l'agent ne pouvait pas appeler.
   */
  app.get(`${base}/offrables`, opts, async (req, reply) => {
    const ctx = contexte(req);
    if ('code' in ctx) return reply.code(ctx.code).send({ error: ctx.error });
    if ((await deps.sortiesDeLAgent(ctx.tenant, ctx.agentId)) === null) return reply.code(404).send({ error: 'agent introuvable' });
    return reply.code(200).send({ outils: await deps.outils.offrablesPour(ctx.tenant, consommateurAgent(ctx.agentId)) });
  });
}
