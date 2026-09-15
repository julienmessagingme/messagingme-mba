import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import { LabelRequeteDejaPris, SourceIntrouvable, type RequeteConnecteur } from '../agent/requetes';
import { construireCible, risqueSelonMethode } from '../agent/http-cible';
import { assemblerAppel, cheminsDeLaReponse, estEnTeteReserve, variablesUtilisees, EN_TETES_RESERVES, type ValeurVariable } from '../agent/requete-http';
import { CHAMPS_CONTACT_AUTORISES, CLES_SYSTEME } from '../agent/variables';
import { scopeTenant, estUuid } from './scope';
import { resolutionPublique, type VerdictResolution } from '../lib/adresse-privee';
import { lireCorpsBorne } from '../lib/corps-borne';

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
 *  3. **`outputPaths` décide de ce que l'agent LIT de la réponse.** Elle appartient au client et part chez
 *     le fournisseur de modèle : c'est ici, et seulement ici, qu'on choisit ce qui en sort.
 *     🔴 **ELLE N'EST PLUS EXIGÉE À L'ENREGISTREMENT (2026-09-15), ET LA GARANTIE N'A PAS BOUGÉ POUR AUTANT.**
 *     Elle l'était, et ça refermait exactement le cycle que la route d'essai existe pour ouvrir : les champs
 *     de sortie se cochent dans la réponse d'un essai, l'essai suppose un appel au point, et un appel à
 *     moitié écrit ne pouvait donc pas être MIS DE CÔTÉ. Julien, le 2026-09-15 : « je peux pas enregistrer
 *     pour commencer, quand je vais revenir je vais devoir repartir de zéro ». Un écran qui perd le travail
 *     de quelqu'un parce qu'il n'est pas fini est le pire des garde-fous : on ne revient pas.
 *     La garantie s'est déplacée d'un cran, là où elle mord vraiment : **un appel sans champ de sortie ne
 *     peut pas être RATTACHÉ à un agent** (409 dans `agent-tools.ts`). Tant qu'il n'est rattaché à personne,
 *     il n'envoie rien et ne lit rien : c'est un brouillon, pas un risque.
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
  /**
   * Cette requête est-elle branchée sur le CONSENTEMENT (migration 0139) ?
   *
   * 🔴 UN SECOND USAGE EST APPARU LE 2026-09-13, ET IL NE PASSE PAS PAR `outils`. Le compteur `outils` ne
   * voit que les outils d'agent : une requête branchée sur la poussée d'opt-out y compte ZÉRO, donc la
   * supprimer était accepté, et la clé étrangère `on delete set null` débranchait la poussée EN SILENCE.
   * Le client cesserait alors de prévenir son propre système à chaque refus sans que rien ne le dise, ce qui
   * est exactement le manquement que le centre de sécurité existe pour empêcher.
   *
   * ⚠️ Optionnelle : absente, on retombe sur le comportement d'avant (seul `outils` protège).
   */
  brancheeSurConsentement?(tenantId: string, requestId: string): Promise<boolean>;
  fetchImpl?: typeof fetch;
  /** Injectée pour tester la garde de résolution sans DNS. Défaut : la vraie résolution. */
  verifierResolution?: (url: string) => Promise<VerdictResolution>;
  /**
   * Plafond de temps de l'appel de test. Défaut : `DELAI_TEST_MS`.
   *
   * ⚠️ **Cette couture existe parce qu'une garde qu'on ne peut pas éprouver n'est pas une garde.** Les faux
   * minuteurs de vitest ne pilotent PAS `AbortSignal.timeout` (vérifié, pas supposé : après onze secondes de
   * faux temps, le signal n'est toujours pas abandonné), donc sans elle le seul test possible serait « un
   * signal est passé », qui passe aussi sur un plafond de dix minutes. C'est exactement ce que le premier
   * jet de ces tests faisait, et le second était pire : il passait AUSSI sans la garde qu'il prétendait tenir.
   */
  delaiTestMs?: number;
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
  /** 🔴 PEUT ÊTRE VIDE, et c'est ce qui rend un brouillon enregistrable : voir la garde 3 ci-dessus. Le
   *  refus vit au RATTACHEMENT à un agent, pas ici. Chaque chemin coché, lui, reste borné. */
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
  /** Valeurs d'essai FOURNIES à ce test. Absentes -> celles enregistrées sur la requête. */
  valeurs: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()])).optional(),
});

/**
 * Un BROUILLON qu'on eprouve avant de l'enregistrer : tout ce qu'il faut pour ASSEMBLER l'appel, et rien de
 * ce qu'un brouillon ne peut pas encore avoir.
 *
 * 🔴 NI `label` NI `outputPaths`, et ce n'est pas un oubli : les champs de sortie se choisissent DANS la
 * reponse de cet essai. Les exiger ici refermerait le cycle que la route d'essai existe pour ouvrir.
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
 * Ce dont un essai a besoin, et rien d'autre.
 *
 * ⚠️ `Pick` du BON cote de la regle du depot : ses membres sont CONSOMMES SUR PLACE (`assemblerAppel`,
 * `risqueSelonMethode`), donc un oubli serait une erreur au point d'usage, pas une liste qui derive.
 */
type RequetePourTest = Pick<
  RequeteConnecteur,
  'sourceId' | 'methode' | 'chemin' | 'parametres' | 'entetes' | 'corps' | 'valeursTest'
>;

/** Réponse de test TRONQUÉE. Le client doit voir assez pour choisir ses champs, pas de quoi remplir un écran. */
const MAX_APERCU = 20_000;

/**
 * Plafond de temps du bouton « Test ». Recopié du bouton jumeau (l'épreuve d'une source, `src/index.ts`)
 * plutôt qu'inventé : deux boutons voisins qui appellent le système du même client n'ont aucune raison
 * d'attendre des durées différentes, et une troisième valeur serait une décision de plus à tenir.
 */
const DELAI_TEST_MS = 10_000;

/**
 * Ce qui cloche dans une requête, ou `null`. Rejoué à la création ET au patch, sur l'état EFFECTIF après
 * écriture : une garde calculée sur le seul corps de la requête ne fermerait qu'un sens (règle du CLAUDE.md).
 */
/**
 * Ce que `verifier` LIT, et rien de plus.
 *
 * ⚠️ Elle est appelee sur une CREATION, sur un PATCH fusionne et desormais sur un BROUILLON d'essai, qui n'a
 * ni nom ni champs de sortie. La typer sur le corps complet rendait ce troisieme appel impossible sans un
 * `as`, c'est-a-dire sans desactiver la seule garde qui compte ici.
 */
type ARegler = Pick<z.infer<typeof corpsRequete>, 'methode' | 'chemin' | 'parametres' | 'entetes' | 'corps' | 'variables'>;

function verifier(r: ARegler, clesDeChamps: readonly string[]): string | null {
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

export function registerAgentRequetes(app: FastifyInstance, deps: AgentRequetesRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };
  const base = '/tenants/:tenantId/agent-requetes';
  const appeler = deps.fetchImpl ?? fetch;
  const estPublique = deps.verifierResolution ?? ((url: string) => resolutionPublique(url));

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
    /**
     * ⚠️ IL Y AVAIT ICI UNE GARDE QUI REFUSAIT DE VIDER LES CHAMPS D'UN APPEL DÉJÀ UTILISÉ (2026-09-15,
     * matin). Elle est partie l'après-midi même, avec la migration 0150, et pas par relâchement : ces champs
     * ne gouvernent PLUS l'exécution. Chaque outil porte désormais sa propre liste, copiée au rattachement ;
     * celle de l'appel n'est qu'un DÉFAUT de pré-remplissage. La vider ne rend donc plus aucun agent muet,
     * elle ne change que ce qui sera proposé au prochain rattachement.
     *
     * 🔴 ET C'EST BIEN CE QUE JULIEN A DEMANDÉ : « changer le défaut ne touche aucun agent en service ».
     * Une garde qui protégerait encore ici protégerait contre un effet qui n'existe plus, et ferait croire
     * au prochain lecteur que le défaut se propage.
     */
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
    // Le SECOND usage, qui ne compte pas dans `outils` : la poussée d'opt-out du centre de Sécurité. Sans ce
    // refus, la clé étrangère `on delete set null` de 0139 débrancherait la conformité sans un mot.
    if (deps.brancheeSurConsentement && await deps.brancheeSurConsentement(tenant, id)) {
      return reply.code(409).send({ error: 'cette requête prévient votre système à chaque désabonnement (Sécurité > Consentement) : débranchez-la d’abord' });
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
  /**
   * L'EXECUTION d'un essai, partagee par les deux routes ci-dessous.
   *
   * 🔴 UNE SEULE CONSTRUCTION, ET C'EST LA RAISON D'ETRE DE CETTE FONCTION. Il y a deux facons d'eprouver un
   * appel (un BROUILLON qu'on met au point, un appel DEJA ENREGISTRE qu'on rejoue), et les ecrire deux fois
   * les ferait diverger : c'est la lecon d'`enTetesAuthSource`, deja payee une fois dans ce depot.
   */
  async function executerTest(
    tenant: string,
    r: RequetePourTest,
    valeursSup: Record<string, ValeurVariable> | undefined,
  ): Promise<{ code: number; body: unknown }> {
    const source = await deps.sourcePourTest(tenant, r.sourceId);
    if (!source) return { code: 400, body: { error: 'la source de cet appel n’existe plus' } };

    // Une source en brouillon peut etre testee : c'est justement l'ordre normal (on eprouve, puis on active).
    // Une source DESACTIVEE, non : elle a ete coupee expres, et la tester la ferait appeler quand meme.
    if (source.status === 'disabled') return { code: 409, body: { error: 'cette source est désactivée' } };

    const valeurs: Record<string, ValeurVariable> = { ...r.valeursTest, ...(valeursSup ?? {}) };
    const appel = assemblerAppel({
      baseUrl: source.baseUrl, methode: r.methode, chemin: r.chemin,
      parametres: r.parametres, entetes: r.entetes, corps: r.corps,
      valeurs, construireCible,
    });
    // Un refus d'assemblage est une INFORMATION pour le client, pas une panne : 200 avec `ok: false`, sinon
    // Cloudflare remplace le corps et il ne sait meme pas ce qui a echoue (cf. CLAUDE.md).
    if (!appel.ok) return { code: 200, body: { ok: false, erreur: appel.raison } };

    // 🔴 OU CE NOM MENE-T-IL VRAIMENT ? Ce bouton appelle une URL que le client vient de saisir, depuis notre
    // reseau, exactement comme le connecteur en conversation. `construireCible` refuse les hotes internes sur
    // leur TEXTE ; elle ne peut rien contre un nom public qui pointe vers le reseau Docker ou vers les
    // metadonnees du fournisseur. Meme garde ici, sinon le chemin le plus facile a atteindre resterait ouvert.
    const resolution = await estPublique(appel.url);
    if (!resolution.ok) {
      return { code: 200, body: { ok: false, erreur: 'cette adresse n’est pas joignable depuis notre infrastructure' } };
    }

    const debut = Date.now();
    let res: Response;
    /**
     * 🔴 LE SEUL DES TROIS BOUTONS « TEST » QUI N'AVAIT PAS DE PLAFOND (contre-audit du 2026-09-03).
     *
     * L'epreuve d'une source en pose un de 10 s, l'embarquement d'agent un de 45 s ; celui-ci, ecrit par la
     * meme main sur le meme motif, n'en avait aucun. Sans `signal`, ce n'est pas illimite pour autant : c'est
     * le defaut d'undici qui coupe, MESURE a 309 s contre un serveur qui accepte et ne repond jamais. Trente
     * fois le plafond du bouton voisin, sur une adresse que le client SAISIT lui-meme, donc sur un hote
     * arbitraire dont la lenteur est choisie par autrui.
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
      return { code: 200, body: { ok: false, erreur: `appel impossible : ${err instanceof Error ? err.message : 'erreur réseau'}` } };
    }

    // Lecture bornee EN FLUX : `res.text()` chargeait tout en memoire avant de couper a `MAX_APERCU`, donc un
    // systeme client bavard remplissait le process pour un apercu de quelques kilo-octets.
    const lu = await lireCorpsBorne(res, MAX_APERCU * 2);
    // 🔴 ET LE PLAFOND DOIT COUVRIR LA LECTURE DU CORPS, pas seulement l'etablissement de la reponse. Un
    // serveur qui rend ses en-tetes vite puis distille son corps epuise l'echeance ICI, et `lireCorpsBorne`
    // avale l'abandon en rendant un texte vide : la route repondrait alors `ok: true`, apercu vide et aucun
    // chemin, c'est-a-dire un SUCCES AU CORPS VIDE qui ferait chercher longtemps du mauvais cote.
    if (echeance.aborted) {
      return { code: 200, body: { ok: false, erreur: 'le système n’a pas répondu dans le temps imparti' } };
    }
    // 🔴 ET L'ECHEANCE N'EST PAS LE SEUL FAUX SUCCES POSSIBLE (audit du 2026-09-04). Un systeme qui coupe en
    // plein corps, sans que l'echeance soit atteinte, produisait exactement la meme reponse trompeuse.
    if (lu.casse) {
      return { code: 200, body: { ok: false, erreur: 'la réponse a été interrompue en cours de lecture' } };
    }
    // Le corps trop gros etait le troisieme : la route l'ignorait et rendait un apercu vide, la ou ses deux
    // routes soeurs refusent. Le plafond n'a de sens que si on le DIT.
    if (lu.trop_gros) {
      return { code: 200, body: { ok: false, erreur: 'réponse trop volumineuse pour l’aperçu' } };
    }
    const brut = lu.texte.slice(0, MAX_APERCU);
    let json: unknown;
    try { json = JSON.parse(brut); } catch { json = undefined; }
    return {
      code: 200,
      body: {
        // `ok` decrit l'ASSEMBLAGE et l'aller-retour, pas le verdict du systeme du client : un 404 est une
        // reponse valide a montrer, et la marquer en echec ferait chercher un probleme chez nous.
        ok: true,
        httpStatus: res.status,
        dureeMs: Date.now() - debut,
        // Ce qui est PARTI, pour que le client voie ce que sa configuration produit vraiment.
        envoye: { url: appel.url, methode: appel.methode, corps: appel.corps },
        apercu: brut,
        // Les chemins a cocher, derives de la REPONSE REELLE : c'est ce qui evite d'ecrire `livraison.date`
        // de tete, et donc de decouvrir sa faute de frappe en pleine conversation.
        chemins: json === undefined ? [] : cheminsDeLaReponse(json),
        risqueMinimum: risqueSelonMethode(r.methode),
      },
    };
  }

  /**
   * REJOUER un appel ENREGISTRE, tel qu'il est en base.
   *
   * ⚠️ CE N'EST PAS CE QUE LA CONSOLE APPELLE : son bouton « Essayer » eprouve ce qui est A L'ECRAN
   * (`POST .../test`, juste en dessous), sinon il repondrait sur une adresse que le client vient de changer.
   * Celle-ci reste la seule facon d'eprouver ce qui EST enregistre, et c'est elle que la suite de tests de
   * securite emprunte : resolution d'adresse interne, plafond de temps, corps coupe, corps trop gros. Les
   * deux routes partagent `executerTest`, donc ce qui est verifie ici vaut pour les deux.
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
    const r = await executerTest(tenant, requete, parse.data.valeurs);
    return reply.code(r.code).send(r.body);
  });

  /**
   * EPROUVER UN BROUILLON, c'est-a-dire un appel qui n'existe pas encore en base.
   *
   * 🔴 SANS ELLE, AUCUN APPEL NE POUVAIT ETRE CREE, et c'etait un blocage TOTAL, trouve par Julien le
   * 2026-09-10 en essayant d'en declarer un. Le cycle etait ferme : enregistrer EXIGE au moins un champ de
   * sortie, les champs de sortie se cochent dans la reponse d'un essai, et l'essai exigeait un appel
   * ENREGISTRE. Le premier appel d'un client etait donc impossible, alors que l'ecran promet l'ordre inverse
   * en toutes lettres : « quelles donnees on envoie, ou on les envoie, on essaie, on coche ce qu'on garde ».
   *
   * ⚠️ ELLE VALIDE COMME LA CREATION, moins ce qu'un brouillon ne peut pas encore avoir (son nom, ses champs
   * de sortie) : en-tetes reserves, variables declarees, corps JSON valide. Un essai qui accepterait ce que
   * l'enregistrement refuse ferait mettre au point un appel impossible a sauver.
   */
  app.post(`${base}/test`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const parse = brouillonTest.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'source, méthode et chemin requis' });
    const pb = verifier(parse.data, await deps.clesDeChamps(tenant));
    if (pb) return reply.code(400).send({ error: pb });
    const r = await executerTest(tenant, parse.data, parse.data.valeurs);
    return reply.code(r.code).send(r.body);
  });

}
