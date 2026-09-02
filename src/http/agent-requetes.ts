import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import { LabelRequeteDejaPris, SourceIntrouvable, type RequeteConnecteur } from '../agent/requetes';
import { construireCible, risqueSelonMethode } from '../agent/http-cible';
import { assemblerAppel, cheminsDeLaReponse, estEnTeteReserve, variablesUtilisees, EN_TETES_RESERVES, type ValeurVariable } from '../agent/requete-http';
import { CHAMPS_CONTACT_AUTORISES, CLES_SYSTEME } from '../agent/variables';
import { scopeTenant, estUuid } from './scope';

/**
 * Les REQUÊTES d'un connecteur : décrire un appel, l'éprouver, puis l'ouvrir aux agents (migration 0105).
 *
 * 🔴 CE QUE CES ROUTES ACCORDENT. Décrire une requête, c'est décider ce qu'on ENVOIE au système d'un client et
 * ce qu'on a le droit d'en LIRE. Quatre gardes vivent ici :
 *
 *  1. **Le gabarit est éprouvé À L'ÉCRITURE**, pas seulement à l'appel. Un corps qui n'est pas du JSON, une
 *     variable utilisée sans être déclarée, une méthode refusée : tout cela se dit au moment de la saisie, où
 *     le client peut corriger, plutôt qu'en pleine conversation avec un contact.
 *  2. **Un en-tête réservé est refusé**, `authorization` en tête. L'authentification vit sur la SOURCE, où
 *     elle est chiffrée. La laisser saisir ici en ferait le chemin le plus naturel, donc le plus utilisé, et
 *     le secret serait stocké en clair dans la configuration.
 *  3. **`outputPaths` est obligatoire et non vide.** La réponse appartient au client et part chez le
 *     fournisseur de modèle : c'est ici, et seulement ici, qu'on décide ce que l'agent en lit.
 *  4. **Supprimer une requête que des outils désignent est refusé** (409), comme pour une source : la cascade
 *     rendrait un agent muet sans bruit.
 */

export interface AgentRequetesRouteDeps {
  lister(tenantId: string): Promise<RequeteConnecteur[]>;
  parId(tenantId: string, id: string): Promise<RequeteConnecteur | null>;
  creer(tenantId: string, input: Omit<RequeteConnecteur, 'id' | 'tenantId' | 'outils' | 'updatedAt'>): Promise<RequeteConnecteur>;
  patch(tenantId: string, id: string, patch: Record<string, unknown>): Promise<RequeteConnecteur | null>;
  supprimer(tenantId: string, id: string): Promise<boolean>;
  /** L'adresse de base et les en-têtes d'authentification de la source, au moment du test. */
  sourcePourTest(tenantId: string, sourceId: string): Promise<{ baseUrl: string; entetes: Record<string, string>; status: string } | null>;
  /** Les clés des champs personnalisés DÉCLARÉS par l'espace : une variable `champ` doit en désigner une. */
  clesDeChamps(tenantId: string): Promise<string[]>;
  fetchImpl?: typeof fetch;
}

const LABEL = z.string().trim().min(1).max(80);
const NOM_VARIABLE = z.string().trim().regex(/^[\w.-]{1,64}$/, 'nom de variable invalide');

const origineSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('modele') }),
  z.object({ type: z.literal('contact'), cle: z.enum(CHAMPS_CONTACT_AUTORISES) }),
  z.object({ type: z.literal('champ'), cle: z.string().trim().min(1).max(64) }),
  z.object({ type: z.literal('systeme'), cle: z.enum(CLES_SYSTEME) }),
  z.object({ type: z.literal('fixe'), valeur: z.union([z.string().max(500), z.number(), z.boolean()]) }),
]);

const variableSchema = z.object({
  nom: NOM_VARIABLE,
  type: z.enum(['string', 'number', 'integer', 'boolean']),
  origine: origineSchema,
  description: z.string().trim().max(500).optional(),
  requis: z.boolean().optional(),
  enum: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
});

const paireSchema = z.object({ cle: z.string().trim().max(200), valeur: z.string().max(2000) });
const enteteSchema = z.object({ nom: z.string().trim().max(64), valeur: z.string().max(2000) });

const corpsSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('aucun') }),
  z.object({ mode: z.literal('json'), gabarit: z.string().max(20_000) }),
  z.object({ mode: z.literal('champs'), champs: z.array(paireSchema).max(50) }),
]);

/**
 * Les champs d'une requête, SANS valeur par défaut.
 *
 * 🔴 CETTE SÉPARATION EST UN CORRECTIF, PAS UN STYLE. `.partial()` ne retire PAS les `.default()` de zod : sur
 * un patch qui omet `variables`, la clé revient quand même, avec `[]`, et la fusion `{...courant, ...patch}`
 * ÉCRASE alors l'existant. Renommer une requête aurait effacé toutes ses variables, ses paramètres d'URL, ses
 * en-têtes et son corps, en silence, et l'écran n'aurait montré la perte qu'au rechargement suivant.
 *
 * Vérifié plutôt que supposé : `z.object({v: z.array(...).default([])}).partial().safeParse({})` rend bien
 * `{v: []}`, la clé PRÉSENTE. Les défauts n'existent donc que dans le schéma de CRÉATION, où ils ont un sens.
 */
const CHAMPS = {
  sourceId: z.string().uuid(),
  label: LABEL,
  methode: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  chemin: z.string().trim().min(1).max(500),
  parametres: z.array(paireSchema).max(50),
  entetes: z.array(enteteSchema).max(30),
  corps: corpsSchema,
  variables: z.array(variableSchema).max(50),
  /** 🔴 NON VIDE : voir la garde 3 ci-dessus. */
  outputPaths: z.array(z.string().trim().min(1).max(120)).min(1).max(50),
  valeursTest: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()])),
};

const corpsRequete = z.object({
  ...CHAMPS,
  parametres: CHAMPS.parametres.default([]),
  entetes: CHAMPS.entetes.default([]),
  corps: CHAMPS.corps.default({ mode: 'aucun' }),
  variables: CHAMPS.variables.default([]),
  valeursTest: CHAMPS.valeursTest.default({}),
});
const patchSchema = z.object(CHAMPS).partial();
const testSchema = z.object({
  /** Valeurs d'essai FOURNIES à ce test. Absentes -> celles enregistrées sur la requête. */
  valeurs: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()])).optional(),
});

/** Réponse de test TRONQUÉE. Le client doit voir assez pour choisir ses champs, pas de quoi remplir un écran. */
const MAX_APERCU = 20_000;

/**
 * Ce qui cloche dans une requête, ou `null`. Rejoué à la création ET au patch, sur l'état EFFECTIF après
 * écriture : une garde calculée sur le seul corps de la requête ne fermerait qu'un sens (règle du CLAUDE.md).
 */
function verifier(r: z.infer<typeof corpsRequete>, clesDeChamps: readonly string[]): string | null {
  // 1. L'adresse, avec la MÊME fonction que le résolveur. Une seconde définition finirait par accepter à
  // l'écriture ce que l'appel refuse, donc par promettre un connecteur qui ne marchera jamais.
  // Les variables de chemin sont remplies d'un jeton quelconque : on éprouve la FORME, pas les valeurs.
  const faux: Record<string, unknown> = {};
  for (const v of r.variables) faux[v.nom] = 'x';
  const cible = construireCible({ baseUrl: 'https://exemple.test', binding: { methode: r.methode, chemin: r.chemin }, args: faux });
  if (!cible.ok) return `chemin refusé : ${cible.raison}`;

  // 2. Les en-têtes réservés. Refusés en le NOMMANT : « en-tête invalide » ferait chercher longtemps.
  for (const e of r.entetes) {
    if (e.nom.trim() === '') continue;
    if (estEnTeteReserve(e.nom)) {
      return `l’en-tête « ${e.nom.trim()} » ne se règle pas ici (réservés : ${EN_TETES_RESERVES.join(', ')}). L’authentification se déclare sur la source.`;
    }
  }

  // 3. Les variables : pas de doublon, et une variable `champ` doit désigner un champ DÉCLARÉ. Une faute de
  // frappe se voit ainsi à la saisie, pas en pleine conversation.
  const noms = new Set<string>();
  for (const v of r.variables) {
    if (noms.has(v.nom)) return `la variable « ${v.nom} » est déclarée deux fois`;
    noms.add(v.nom);
    if (v.origine.type === 'champ' && !clesDeChamps.includes(v.origine.cle)) {
      return `le champ « ${v.origine.cle} » n’existe pas dans cet espace`;
    }
  }

  // 4. Toute variable UTILISÉE dans un gabarit doit être déclarée. C'est la faute la plus fréquente, et sans
  // cette garde elle ne se voit qu'à l'appel, où elle refuse la requête au milieu d'une conversation.
  const utilisees = variablesUtilisees(r.corps, r.parametres, r.chemin);
  const inconnues = utilisees.filter((n) => !noms.has(n));
  if (inconnues.length > 0) return `variable(s) utilisée(s) mais non déclarée(s) : ${inconnues.join(', ')}`;

  // 5. Le corps doit être du JSON valide dès la saisie. On le vérifie en le construisant avec des valeurs
  // factices : c'est le MÊME code que l'exécution, donc ce qui passe ici passera là-bas.
  if (r.corps.mode === 'json' && r.corps.gabarit.trim() !== '') {
    try { JSON.parse(r.corps.gabarit); } catch { return 'le corps n’est pas du JSON valide'; }
  }
  return null;
}

export function registerAgentRequetes(app: FastifyInstance, deps: AgentRequetesRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};
  const base = '/tenants/:tenantId/agent-requetes';
  const appeler = deps.fetchImpl ?? fetch;

  /** Ce que la console propose : les origines de variable, pour que l'écran ne recopie pas une liste serveur. */
  const CATALOGUE = {
    contact: CHAMPS_CONTACT_AUTORISES,
    systeme: CLES_SYSTEME,
    entetesReserves: EN_TETES_RESERVES,
  };

  app.get(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({
      requetes: await deps.lister(tenant),
      champs: await deps.clesDeChamps(tenant),
      catalogue: CATALOGUE,
    });
  });

  app.post(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const parse = corpsRequete.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'source, nom, méthode, chemin et champs à lire requis' });
    const pb = verifier(parse.data, await deps.clesDeChamps(tenant));
    if (pb) return reply.code(400).send({ error: pb });
    try {
      return reply.code(201).send({ requete: await deps.creer(tenant, parse.data) });
    } catch (err) {
      if (err instanceof LabelRequeteDejaPris) return reply.code(409).send({ error: err.message });
      if (err instanceof SourceIntrouvable) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.patch(`${base}/:id`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'requête introuvable' });
    const parse = patchSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'corps invalide' });
    const actuelle = await deps.parId(tenant, id);
    if (!actuelle) return reply.code(404).send({ error: 'requête introuvable' });
    // L'état EFFECTIF après écriture (`patch ?? courant`), jamais le seul corps : sinon changer le corps sans
    // renvoyer les variables passerait la garde « variable non déclarée » alors qu'elle devrait mordre.
    const effectif = { ...actuelle, ...parse.data } as z.infer<typeof corpsRequete>;
    const pb = verifier(effectif, await deps.clesDeChamps(tenant));
    if (pb) return reply.code(400).send({ error: pb });
    try {
      const requete = await deps.patch(tenant, id, parse.data);
      if (!requete) return reply.code(404).send({ error: 'requête introuvable' });
      return reply.code(200).send({ requete });
    } catch (err) {
      if (err instanceof LabelRequeteDejaPris) return reply.code(409).send({ error: err.message });
      if (err instanceof SourceIntrouvable) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete(`${base}/:id`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'requête introuvable' });
    const actuelle = await deps.parId(tenant, id);
    if (!actuelle) return reply.code(404).send({ error: 'requête introuvable' });
    // Même doctrine que les sources : la cascade emporterait les outils sans bruit, et l'agent deviendrait
    // muet sur ces gestes-là, en production, sans que personne ne l'ait décidé.
    if (actuelle.outils > 0) {
      return reply.code(409).send({ error: `${actuelle.outils} outil(s) d’agent utilisent cette requête : retirez-les d’abord` });
    }
    return reply.code(200).send({ id, deleted: await deps.supprimer(tenant, id) });
  });

  /**
   * ÉPROUVER la requête avec des valeurs d'essai, et rendre la vraie réponse.
   *
   * 🔴 Elle passe par `assemblerAppel`, LE MÊME que l'exécution. C'est la seule chose qui empêche ce bouton de
   * dire « ça marche » d'un appel que la production ne saurait pas faire. La leçon est celle
   * d'`enTetesAuthSource` : deux constructions parallèles finissent toujours par diverger.
   *
   * ⚠️ Ce que ce test rend, un appel réel ne le rendrait PAS : la réponse ENTIÈRE (tronquée), et non les seuls
   * `outputPaths`. C'est voulu, et c'est le point : le client doit voir ce que son système répond pour choisir
   * ce que l'agent aura le droit d'en lire. Cette route est réservée aux administrateurs ; le filtre de sortie
   * protège le MODÈLE, pas le client de ses propres données.
   */
  app.post(`${base}/:id/test`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'requête introuvable' });
    const parse = testSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'corps invalide' });
    const requete = await deps.parId(tenant, id);
    if (!requete) return reply.code(404).send({ error: 'requête introuvable' });
    const source = await deps.sourcePourTest(tenant, requete.sourceId);
    if (!source) return reply.code(400).send({ error: 'la source de cette requête n’existe plus' });

    // Une source en brouillon peut être testée : c'est justement l'ordre normal (on éprouve, puis on active).
    // Une source DÉSACTIVÉE, non : elle a été coupée exprès, et la tester la ferait appeler quand même.
    if (source.status === 'disabled') return reply.code(409).send({ error: 'cette source est désactivée' });

    const valeurs: Record<string, ValeurVariable> = { ...requete.valeursTest, ...(parse.data.valeurs ?? {}) };
    const appel = assemblerAppel({
      baseUrl: source.baseUrl, methode: requete.methode, chemin: requete.chemin,
      parametres: requete.parametres, entetes: requete.entetes, corps: requete.corps,
      valeurs, construireCible,
    });
    // Un refus d'assemblage est une INFORMATION pour le client, pas une panne : 200 avec `ok: false`, sinon
    // Cloudflare remplace le corps et il ne sait même pas ce qui a échoué (cf. CLAUDE.md).
    if (!appel.ok) return reply.code(200).send({ ok: false, erreur: appel.raison });

    const debut = Date.now();
    let res: Response;
    try {
      res = await appeler(appel.url, {
        method: appel.methode,
        headers: { ...appel.entetes, ...source.entetes },
        ...(appel.corps !== null ? { body: appel.corps } : {}),
        redirect: 'error',
      });
    } catch (err) {
      return reply.code(200).send({ ok: false, erreur: `appel impossible : ${err instanceof Error ? err.message : 'erreur réseau'}` });
    }

    const brut = (await res.text().catch(() => '')).slice(0, MAX_APERCU);
    let json: unknown;
    try { json = JSON.parse(brut); } catch { json = undefined; }
    return reply.code(200).send({
      // `ok` décrit l'ASSEMBLAGE et l'aller-retour, pas le verdict du système du client : un 404 est une
      // réponse valide à montrer, et la marquer en échec ferait chercher un problème chez nous.
      ok: true,
      httpStatus: res.status,
      dureeMs: Date.now() - debut,
      // Ce qui est PARTI, pour que le client voie ce que sa configuration produit vraiment. L'authentification
      // n'y est pas : ces en-têtes-là sont ceux de la requête, la source ajoute les siens à l'envoi.
      envoye: { url: appel.url, methode: appel.methode, corps: appel.corps },
      apercu: brut,
      // Les chemins à cocher, dérivés de la RÉPONSE RÉELLE : c'est ce qui évite d'avoir à écrire
      // `livraison.date` de tête, et donc de découvrir sa faute de frappe en pleine conversation.
      chemins: json === undefined ? [] : cheminsDeLaReponse(json),
      risqueMinimum: risqueSelonMethode(requete.methode),
    });
  });
}
