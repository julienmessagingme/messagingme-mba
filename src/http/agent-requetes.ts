import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import { LabelRequeteDejaPris, SourceIntrouvable, type RequeteConnecteur } from '../agent/requetes';
import { construireCible, risqueSelonMethode } from '../agent/http-cible';
import { assemblerAppel, cheminsDeLaReponse, estEnTeteReserve, variablesUtilisees, EN_TETES_RESERVES, type ValeurVariable } from '../agent/requete-http';
import { CLES_SYSTEME, normaliserOrigine } from '../agent/variables';
import { CHAMPS_FICHE_FIXES, CLES_FICHE_SORTIE, type CleFicheFixe } from '../crm/champs-fiche';
import { espaceVerifie, estUuid } from './scope';
import { resolutionPublique, type VerdictResolution } from '../lib/adresse-privee';
import { fetchPublic, estRefusAdresseInterne, estRedirectionRefusee } from '../lib/connexion-publique';
import { lireCorpsBorne } from '../lib/corps-borne';

/**
 * Les requêtes d'un connecteur : décrire un appel, l'éprouver, puis l'ouvrir aux agents. Décrire une requête,
 * c'est décider ce qu'on envoie au système d'un client et ce qu'on a le droit d'en lire. Quatre gardes :
 *  1. Le gabarit est éprouvé à l'écriture (corps non JSON, variable non déclarée, méthode refusée), là où le
 *     client peut corriger.
 *  2. 🔴 Un en-tête réservé est refusé, `authorization` en tête : l'authentification vit sur la source,
 *     chiffrée ; saisie ici, le secret serait stocké en clair.
 *  3. `outputPaths` décide de ce que l'agent lit de la réponse, qui part chez le fournisseur de modèle. Il peut
 *     être vide à l'enregistrement (un brouillon se garde) : c'est le rattachement à un agent qui l'exige (409
 *     dans `agent-tools.ts`). Non rattaché, un appel n'envoie ni ne lit rien.
 *  4. Supprimer une requête que des outils désignent est refusé (409) : la cascade rendrait un agent muet.
 */

export interface AgentRequetesRouteDeps {
  requetes: {
    lister(tenantId: string): Promise<RequeteConnecteur[]>;
    parId(tenantId: string, id: string): Promise<RequeteConnecteur | null>;
    creer(tenantId: string, input: Omit<RequeteConnecteur, 'id' | 'tenantId' | 'outils' | 'updatedAt'>): Promise<RequeteConnecteur>;
    patch(tenantId: string, id: string, patch: Record<string, unknown>): Promise<RequeteConnecteur | null>;
    supprimer(tenantId: string, id: string): Promise<boolean>;
  };
  /** L'adresse de base et les en-têtes d'authentification de la source, au moment du test. */
  sourcePourTest(tenantId: string, sourceId: string): Promise<{ baseUrl: string; entetes: Record<string, string>; status: string } | null>;
  /** Les clés des champs personnalisés déclarés par l'espace : une variable `champ` doit en désigner une. */
  clesDeChamps(tenantId: string): Promise<string[]>;
  /**
   * Cette requête est-elle branchée sur le consentement (poussée d'opt-out) ? 🔴 Ce second usage ne compte pas
   * dans `outils` : sans ce refus, la supprimer passerait, la clé `on delete set null` débrancherait la poussée en
   * silence, et le client cesserait de prévenir son système à chaque refus. Les fixtures qui n'en parlent pas
   * passent `jamaisBrancheeSurConsentement`.
   */
  brancheeSurConsentement(tenantId: string, requestId: string): Promise<boolean>;
  fetchImpl?: typeof fetch;
  /** Injectée pour tester la garde de résolution sans DNS. Défaut : la vraie résolution. */
  verifierResolution?: (url: string) => Promise<VerdictResolution>;
  /**
   * Plafond de temps de l'appel de test (défaut `DELAI_TEST_MS`). Injectable parce que les faux minuteurs de
   * vitest ne pilotent pas `AbortSignal.timeout` : sans cette couture, la garde ne pourrait pas être éprouvée.
   */
  delaiTestMs?: number;
}

const LABEL = z.string().trim().min(1).max(80);
const NOM_VARIABLE = z.string().trim().regex(/^[\w.-]{1,64}$/, 'nom de variable invalide');

/**
 * L'origine d'une variable. Les formes anciennes (`contact:*`, `systeme:analyse_*`) sont ramenées à l'origine
 * `fiche` AVANT la validation (`normaliserOrigine`) : une console plus ancienne que l'API continue d'enregistrer,
 * et ce qui est écrit en base est toujours la forme actuelle. La clé d'un champ de fiche doit être dans la liste
 * unique ET pouvoir sortir (`CLES_FICHE_SORTIE`) : un 400 sinon.
 */
const origineSchema = z.preprocess((o) => normaliserOrigine(o) ?? o, z.discriminatedUnion('type', [
  z.object({ type: z.literal('modele') }),
  z.object({ type: z.literal('fiche'), cle: z.enum(CLES_FICHE_SORTIE as [CleFicheFixe, ...CleFicheFixe[]]) }),
  z.object({ type: z.literal('champ'), cle: z.string().trim().min(1).max(64) }),
  z.object({ type: z.literal('systeme'), cle: z.enum(CLES_SYSTEME) }),
  z.object({ type: z.literal('fixe'), valeur: z.union([z.string().max(500), z.number(), z.boolean()]) }),
]));

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
 * Les champs d'une requête, sans valeur par défaut : `.partial()` ne retire pas les `.default()` de zod, et un
 * patch qui omet `variables` la ramènerait à `[]`, écrasant l'existant à la fusion. Les défauts n'existent que
 * dans le schéma de création.
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
  /** Peut être vide : c'est ce qui rend un brouillon enregistrable (garde 3). Chaque chemin coché reste borné. */
  outputPaths: z.array(z.string().trim().min(1).max(120)).max(50),
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
  /** Valeurs d'essai fournies à ce test. Absentes -> celles enregistrées sur la requête. */
  valeurs: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()])).optional(),
});

/**
 * Un brouillon qu'on éprouve avant de l'enregistrer : de quoi assembler l'appel, sans `label` ni `outputPaths`
 * (les champs de sortie se choisissent dans la réponse de cet essai).
 */
const brouillonTest = z.object({
  sourceId: CHAMPS.sourceId,
  methode: CHAMPS.methode,
  chemin: CHAMPS.chemin,
  parametres: CHAMPS.parametres.default([]),
  entetes: CHAMPS.entetes.default([]),
  corps: CHAMPS.corps.default({ mode: 'aucun' }),
  variables: CHAMPS.variables.default([]),
  valeursTest: CHAMPS.valeursTest.default({}),
  /** Valeurs saisies dans l'ecran d'essai, qui l'emportent sur celles du brouillon. */
  valeurs: CHAMPS.valeursTest.optional(),
});

/**
 * Les en-têtes vraiment partis : ceux de la requête, moins ceux que la source écrase (l'envoi fusionne
 * `{ ...appel.entetes, ...source.entetes }`). Afficher un en-tête écrasé montrerait une valeur jamais reçue.
 * Les deux jeux sont en minuscules, la comparaison est directe.
 */
function sansCeuxDeLaSource(
  requete: Record<string, string>,
  source: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(requete).filter(([nom]) => !(nom in source)));
}

/**
 * Ce dont un essai a besoin. `Pick` consommé sur place (`assemblerAppel`, `risqueSelonMethode`) : un oubli
 * serait une erreur au point d'usage.
 */
type RequetePourTest = Pick<
  RequeteConnecteur,
  'sourceId' | 'methode' | 'chemin' | 'parametres' | 'entetes' | 'corps' | 'valeursTest'
>;

/** Réponse de test tronquée. Le client doit voir assez pour choisir ses champs, pas de quoi remplir un écran. */
const MAX_APERCU = 20_000;

/**
 * Plafond de temps du bouton « Test », le même que l'épreuve d'une source : deux boutons voisins qui appellent
 * le même système n'ont aucune raison d'attendre des durées différentes.
 */
const DELAI_TEST_MS = 10_000;

/**
 * Ce que `verifier` lit, et rien de plus. Elle est rejouée à la création, au patch (sur l'état effectif après
 * écriture, sinon la garde ne fermerait qu'un sens) et sur un brouillon d'essai, qui n'a ni nom ni champs de
 * sortie : un type plus large obligerait à un `as`.
 */
type ARegler = Pick<z.infer<typeof corpsRequete>, 'methode' | 'chemin' | 'parametres' | 'entetes' | 'corps' | 'variables'>;

function verifier(r: ARegler, clesDeChamps: readonly string[]): string | null {
  // 1. L'adresse, avec la même fonction que le résolveur : une seconde définition accepterait à l'écriture ce
  // que l'appel refuse. Les variables de chemin sont remplies d'un jeton quelconque : on éprouve la forme.
  const faux: Record<string, unknown> = {};
  for (const v of r.variables) faux[v.nom] = 'x';
  const cible = construireCible({ baseUrl: 'https://exemple.test', binding: { methode: r.methode, chemin: r.chemin }, args: faux });
  if (!cible.ok) return `chemin refusé : ${cible.raison}`;

  // 2. Les en-têtes réservés. Refusés en le nommant : « en-tête invalide » ferait chercher longtemps.
  for (const e of r.entetes) {
    if (e.nom.trim() === '') continue;
    if (estEnTeteReserve(e.nom)) {
      return `l’en-tête « ${e.nom.trim()} » ne se règle pas ici (réservés : ${EN_TETES_RESERVES.join(', ')}). L’authentification se déclare sur la source.`;
    }
  }

  // 3. Les variables : pas de doublon, et une variable `champ` doit désigner un champ déclaré. Une faute de
  // frappe se voit ainsi à la saisie, pas en pleine conversation.
  const noms = new Set<string>();
  for (const v of r.variables) {
    if (noms.has(v.nom)) return `la variable « ${v.nom} » est déclarée deux fois`;
    noms.add(v.nom);
    if (v.origine.type === 'champ' && !clesDeChamps.includes(v.origine.cle)) {
      return `le champ « ${v.origine.cle} » n’existe pas dans cet espace`;
    }
  }

  // 4. Toute variable utilisée dans un gabarit doit être déclarée. C'est la faute la plus fréquente, et sans
  // cette garde elle ne se voit qu'à l'appel, où elle refuse la requête au milieu d'une conversation.
  const utilisees = variablesUtilisees(r.corps, r.parametres, r.chemin, r.entetes);
  const inconnues = utilisees.filter((n) => !noms.has(n));
  if (inconnues.length > 0) return `variable(s) utilisée(s) mais non déclarée(s) : ${inconnues.join(', ')}`;

  // 5. Le corps doit être du JSON valide dès la saisie. On le vérifie en le construisant avec des valeurs
  // factices : c'est le même code que l'exécution, donc ce qui passe ici passera là-bas.
  if (r.corps.mode === 'json' && r.corps.gabarit.trim() !== '') {
    try { JSON.parse(r.corps.gabarit); } catch { return 'le corps n’est pas du JSON valide'; }
  }
  return null;
}

export function registerAgentRequetes(app: FastifyInstance, deps: AgentRequetesRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const base = '/tenants/:tenantId/agent-requetes';
  // Le `fetch` vérifié à la connexion (DNS rebinding) : `src/lib/connexion-publique.ts`.
  const appeler = deps.fetchImpl ?? fetchPublic;
  const estPublique = deps.verifierResolution ?? ((url: string) => resolutionPublique(url));

  /**
   * Ce que la console propose : les origines de variable, pour que l'écran ne recopie pas une liste serveur.
   * `fiche` : les champs de la liste unique qui peuvent sortir, avec leurs libellés. ⚠️ `contact` reste, pour une
   * console publiée AVANT cette API (elle lit `catalogue.contact` et planterait sans) : ses `contact:*` sont
   * réécrits en `fiche:*` à l'enregistrement. À retirer quand plus aucune console ancienne ne tourne.
   */
  const CATALOGUE = {
    fiche: CHAMPS_FICHE_FIXES.filter((c) => c.sortieTiers).map((c) => ({ cle: c.cle, libelle: c.libelle, provenance: c.provenance })),
    contact: ['wa_id', 'nom'] as const,
    systeme: CLES_SYSTEME,
    entetesReserves: EN_TETES_RESERVES,
  };

  app.get(base, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({
      requetes: await deps.requetes.lister(tenant),
      champs: await deps.clesDeChamps(tenant),
      catalogue: CATALOGUE,
    });
  });

  app.post(base, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const parse = corpsRequete.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'source, nom, méthode, chemin et champs à lire requis' });
    const pb = verifier(parse.data, await deps.clesDeChamps(tenant));
    if (pb) return reply.code(400).send({ error: pb });
    try {
      return reply.code(201).send({ requete: await deps.requetes.creer(tenant, parse.data) });
    } catch (err) {
      if (err instanceof LabelRequeteDejaPris) return reply.code(409).send({ error: err.message });
      if (err instanceof SourceIntrouvable) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.patch(`${base}/:id`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'requête introuvable' });
    const parse = patchSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'corps invalide' });
    const actuelle = await deps.requetes.parId(tenant, id);
    if (!actuelle) return reply.code(404).send({ error: 'requête introuvable' });
    // L'état effectif après écriture (`patch ?? courant`), jamais le seul corps : sinon changer le corps sans
    // renvoyer les variables passerait la garde « variable non déclarée » alors qu'elle devrait mordre.
    const effectif = { ...actuelle, ...parse.data } as z.infer<typeof corpsRequete>;
    const pb = verifier(effectif, await deps.clesDeChamps(tenant));
    if (pb) return reply.code(400).send({ error: pb });
    /**
     * Pas de garde contre le fait de vider les champs d'un appel déjà utilisé : ces champs ne gouvernent plus
     * l'exécution. Chaque outil porte sa propre liste, copiée au rattachement ; celle de l'appel n'est qu'un défaut
     * de pré-remplissage, et la changer ne touche aucun agent en service. La MÉTHODE, elle, les touche : le magasin
     * monte le risque des outils branchés dans la transaction de l'écriture (`PgRequeteStore.patch`).
     */
    try {
      const requete = await deps.requetes.patch(tenant, id, parse.data);
      if (!requete) return reply.code(404).send({ error: 'requête introuvable' });
      return reply.code(200).send({ requete });
    } catch (err) {
      if (err instanceof LabelRequeteDejaPris) return reply.code(409).send({ error: err.message });
      if (err instanceof SourceIntrouvable) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete(`${base}/:id`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'requête introuvable' });
    const actuelle = await deps.requetes.parId(tenant, id);
    if (!actuelle) return reply.code(404).send({ error: 'requête introuvable' });
    // Même doctrine que les sources : la cascade emporterait les outils sans bruit, et l'agent deviendrait
    // muet sur ces gestes-là, en production, sans que personne ne l'ait décidé.
    if (actuelle.outils > 0) {
      return reply.code(409).send({ error: `${actuelle.outils} outil(s) d’agent utilisent cette requête : retirez-les d’abord` });
    }
    // Le second usage, hors de `outils` : la poussée d'opt-out du centre de Sécurité. Sans ce refus, la clé
    // `on delete set null` débrancherait la conformité sans un mot.
    if (await deps.brancheeSurConsentement(tenant, id)) {
      return reply.code(409).send({ error: 'cette requête prévient votre système à chaque désabonnement (Sécurité > Consentement) : débranchez-la d’abord' });
    }
    return reply.code(200).send({ id, deleted: await deps.requetes.supprimer(tenant, id) });
  });

  /**
   * L'exécution d'un essai, partagée par les deux routes ci-dessous (un brouillon, un appel enregistré). Elle
   * passe par `assemblerAppel`, le même que l'exécution : deux constructions parallèles finiraient par diverger.
   * L'essai rend la réponse entière (tronquée), pas les seuls `outputPaths` : le client doit voir ce que son
   * système répond pour choisir ce que l'agent lira. Le filtre de sortie protège le modèle, pas le client de ses
   * propres données.
   */
  async function executerTest(
    tenant: string,
    r: RequetePourTest,
    valeursSup: Record<string, ValeurVariable> | undefined,
  ): Promise<{ code: number; body: unknown }> {
    const source = await deps.sourcePourTest(tenant, r.sourceId);
    if (!source) return { code: 400, body: { error: 'la source de cet appel n’existe plus' } };

    // Une source en brouillon peut être testée (on éprouve, puis on active) ; une source désactivée non : elle a
    // été coupée exprès, et la tester la ferait appeler quand même.
    if (source.status === 'disabled') return { code: 409, body: { error: 'cette source est désactivée' } };

    const valeurs: Record<string, ValeurVariable> = { ...r.valeursTest, ...(valeursSup ?? {}) };
    const appel = assemblerAppel({
      baseUrl: source.baseUrl, methode: r.methode, chemin: r.chemin,
      parametres: r.parametres, entetes: r.entetes, corps: r.corps,
      valeurs, construireCible,
    });
    // Un refus d'assemblage est une information pour le client, pas une panne : 200 avec `ok: false`.
    if (!appel.ok) return { code: 200, body: { ok: false, erreur: appel.raison } };

    // 🔴 Où ce nom mène-t-il vraiment ? Ce bouton appelle une URL saisie par le client, depuis notre réseau.
    // `construireCible` refuse les hôtes internes sur leur texte, pas un nom public qui pointe vers le réseau Docker
    // ou les métadonnées du fournisseur : même garde de résolution que le connecteur en conversation.
    const resolution = await estPublique(appel.url);
    if (!resolution.ok) {
      return { code: 200, body: { ok: false, erreur: 'cette adresse n’est pas joignable depuis notre infrastructure' } };
    }

    const debut = Date.now();
    let res: Response;
    /**
     * Plafond de temps de l'essai : sans `signal`, c'est le défaut d'undici qui coupe (309 s mesurées contre un
     * serveur qui ne répond jamais), sur un hôte que le client choisit, donc dont la lenteur est choisie par autrui.
     */
    const echeance = AbortSignal.timeout(deps.delaiTestMs ?? DELAI_TEST_MS);
    try {
      res = await appeler(appel.url, {
        method: appel.methode,
        headers: { ...appel.entetes, ...source.entetes },
        ...(appel.corps !== null ? { body: appel.corps } : {}),
        redirect: 'error',
        signal: echeance,
      });
    } catch (err) {
      // Refus à la connexion (le nom a résolu vers l'intérieur entre la vérification ci-dessus et l'appel) : même
      // message que la vérification préalable, c'est la même cause.
      if (estRefusAdresseInterne(err)) {
        return { code: 200, body: { ok: false, erreur: 'cette adresse n’est pas joignable depuis notre infrastructure' } };
      }
      // Même phrase que le résolveur de connecteur pour la même cause (`redirect: 'error'` ci-dessus).
      if (estRedirectionRefusee(err)) {
        return { code: 200, body: { ok: false, erreur: 'le système du client a redirigé l’appel, ce qui n’est pas accepté sur un connecteur' } };
      }
      return { code: 200, body: { ok: false, erreur: `appel impossible : ${err instanceof Error ? err.message : 'erreur réseau'}` } };
    }

    // Lecture bornée en flux : `res.text()` chargerait tout en mémoire avant de couper à `MAX_APERCU`.
    const lu = await lireCorpsBorne(res, MAX_APERCU * 2);
    // Le plafond doit couvrir aussi la lecture du corps : un serveur qui rend vite ses en-têtes puis distille son
    // corps épuise l'échéance ici, et `lireCorpsBorne` rendrait un texte vide, donc un faux succès au corps vide.
    if (echeance.aborted) {
      return { code: 200, body: { ok: false, erreur: 'le système n’a pas répondu dans le temps imparti' } };
    }
    // Autre faux succès possible : un système qui coupe en plein corps, sans que l'échéance soit atteinte.
    if (lu.casse) {
      return { code: 200, body: { ok: false, erreur: 'la réponse a été interrompue en cours de lecture' } };
    }
    // Le corps trop gros est refusé et dit, comme par les routes sœurs : un plafond n'a de sens que si on le dit.
    if (lu.trop_gros) {
      return { code: 200, body: { ok: false, erreur: 'réponse trop volumineuse pour l’aperçu' } };
    }
    const brut = lu.texte.slice(0, MAX_APERCU);
    let json: unknown;
    try { json = JSON.parse(brut); } catch { json = undefined; }
    return {
      code: 200,
      body: {
        // `ok` décrit l'assemblage et l'aller-retour, pas le verdict du système du client : un 404 est une réponse
        // valide à montrer, et la marquer en échec ferait chercher un problème chez nous.
        ok: true,
        httpStatus: res.status,
        dureeMs: Date.now() - debut,
        // Ce qui est parti, pour que le client voie ce que sa configuration produit : les en-têtes de la requête,
        // variables substituées, jamais ceux de la source (le secret), et moins ceux que la source écrase à l'envoi.
        envoye: { url: appel.url, methode: appel.methode, corps: appel.corps, entetes: sansCeuxDeLaSource(appel.entetes, source.entetes) },
        apercu: brut,
        // Les chemins à cocher, dérivés de la réponse réelle : on n'écrit pas `livraison.date` de tête, et une faute
        // de frappe ne se découvre pas en pleine conversation.
        chemins: json === undefined ? [] : cheminsDeLaReponse(json),
        risqueMinimum: risqueSelonMethode(r.methode),
      },
    };
  }

  /**
   * Rejouer un appel enregistré, tel qu'il est en base. Ce n'est pas ce que la console appelle (son bouton éprouve
   * ce qui est à l'écran, `POST .../test`) ; c'est la seule façon d'éprouver ce qui est enregistré, et celle que
   * la suite de sécurité emprunte. Les deux routes partagent `executerTest`.
   */
  app.post(`${base}/:id/test`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'requête introuvable' });
    const parse = testSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'corps invalide' });
    const requete = await deps.requetes.parId(tenant, id);
    if (!requete) return reply.code(404).send({ error: 'requête introuvable' });
    const r = await executerTest(tenant, requete, parse.data.valeurs);
    return reply.code(r.code).send(r.body);
  });

  /**
   * Éprouver un brouillon, un appel qui n'existe pas encore en base : les champs de sortie se cochent dans la
   * réponse d'un essai, donc sans elle aucun premier appel ne pourrait être créé. Elle valide comme la création,
   * moins le nom et les champs de sortie : un essai qui accepterait ce que l'enregistrement refuse ferait mettre
   * au point un appel impossible à sauver.
   */
  app.post(`${base}/test`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const parse = brouillonTest.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'source, méthode et chemin requis' });
    const pb = verifier(parse.data, await deps.clesDeChamps(tenant));
    if (pb) return reply.code(400).send({ error: pb });
    const r = await executerTest(tenant, parse.data, parse.data.valeurs);
    return reply.code(r.code).send(r.body);
  });

}
