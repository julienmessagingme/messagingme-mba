import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import type { OutilBibliotheque, OutilComplet, Rattachement, RisqueOutil } from '../agent/catalog';
import { NomOutilDejaPris, OutilNonActivable, messageDuRefus, refusIntrouvable } from '../agent/catalog';
import type { RequeteConnecteur } from '../agent/requetes';
import { risqueSelonMethode, type MethodeConnecteur } from '../agent/http-cible';
import { espaceVerifie, estUuid } from './scope';
import { blocSeul, type BlocPropose, type CibleMaison } from '../mba/outils-maison';
import { outilsMcpProposables, vueOutilMba, SCENARIO_VIDE, type ContexteVue } from '../mba/vue-outils';
import { entryNode } from '../workflow/engine';
import { LONGUEUR_MAX_ETIQUETTE } from '../crm/poser-etiquette';
import type { WorkflowGraph } from '../workflow/graph';

/**
 * L'onglet « Outils » de l'agent de Meta : il ne parle que des outils de cet agent (la bibliothèque de l'espace
 * reste aux agents IA). Le numéro vient du serveur, jamais du corps ; la cible saisie devient un `binding` du
 * catalogue (`src/mba/outils-maison.ts`) et le risque d'un connecteur se dérive de la méthode de sa requête :
 * le navigateur ne choisit ni l'un ni l'autre (`.strict()` refuse les clés en trop).
 */
interface TextesOutil { name: string; title: string; description: string; nePasUtiliser: string }

export interface MbaOutilsDeps {
  repo: { getTenantPhoneNumberId(tenantId: string): Promise<string | null> };
  /** Les outils du consommateur `mba:<numéro>`, actifs ou non. */
  lister(tenantId: string, phoneNumberId: string): Promise<OutilComplet[]>;
  /** Ce qu'il faut pour dire d'une ligne ce qu'elle vise, et si c'est encore là. */
  contexte(tenantId: string, outils: readonly OutilComplet[]): Promise<ContexteVue>;
  requetes: { parId(tenantId: string, id: string): Promise<Pick<RequeteConnecteur, 'id' | 'sourceId' | 'methode' | 'variables'> | null> };
  /** Les clés des champs déclarés du mini-CRM. */
  champs(tenantId: string): Promise<string[]>;
  /** Les outils maison de l'agent de Meta, et le retrait d'un outil de son catalogue. */
  outils: {
    ajouterMaisonPourMba(tenantId: string, phoneNumberId: string, outil: TextesOutil & { cible: CibleMaison }, parUtilisateur: string): Promise<{ id: string } | null>;
    patchMaisonPourMba(tenantId: string, phoneNumberId: string, outilId: string, patch: Partial<TextesOutil> & { cible?: CibleMaison }): Promise<{ id: string } | null>;
    retirerDeMba(tenantId: string, phoneNumberId: string, outilId: string): Promise<'supprime' | 'detache' | 'introuvable'>;
  };
  /** Créer l'outil de connecteur et l'activer pour l'agent de Meta, au nom de `parUtilisateur`. */
  creerConnecteur(tenantId: string, phoneNumberId: string, outil: TextesOutil & {
    sourceId: string; requestId: string; risk: RisqueOutil;
  }, parUtilisateur: string): Promise<{ id: string } | null>;
  modifierConnecteur(tenantId: string, phoneNumberId: string, outilId: string, patch: Partial<TextesOutil>): Promise<{ id: string } | null>;
  /** Rallumer un outil éteint par le départ de son auteur. */
  reactiver(tenantId: string, phoneNumberId: string, outilId: string, parUtilisateur: string): Promise<boolean>;
  /** Un scénario de l'espace, avec son graphe publié (celui que le relais joue), ou `null`. */
  workflow(tenantId: string, id: string): Promise<{ name: string; graph: WorkflowGraph } | null>;
  /**
   * Les blocs d'un seul scénario publié, envoyables seuls ou non, pour le choix de l'écran : lister tous les blocs
   * de tous les scénarios ne tiendrait pas à 200 scénarios.
   */
  blocs(tenantId: string, workflowId: string): Promise<BlocPropose[]>;
  /** La bibliothèque d'outils de l'espace (`listCatalogue`) : l'origine d'un outil qu'on veut donner. */
  bibliotheque(tenantId: string): Promise<OutilBibliotheque[]>;
  /** Ce que le catalogue permet d'offrir à cet agent de Meta (`offrablesPour`) : la règle unique, rien à refiltrer. */
  offrables(tenantId: string, phoneNumberId: string): Promise<OutilBibliotheque[]>;
  /** Les serveurs MCP de l'espace, par identifiant, pour nommer celui d'un outil. */
  serveurs(tenantId: string): Promise<ReadonlyMap<string, { label: string }>>;
  /**
   * Rattacher un outil MCP de la bibliothèque à l'agent de Meta PUIS l'activer, au nom de `parUtilisateur` : deux gestes
   * du catalogue. Un refus de la porte remonte avec sa raison (`Rattachement`).
   */
  proposerMcp(tenantId: string, phoneNumberId: string, outilId: string, parUtilisateur: string): Promise<Rattachement>;
}

const NOM = z.string().trim().regex(/^[a-z0-9_]{1,64}$/, 'nom technique au format [a-z0-9_], 64 caractères au plus');
const texte = (max: number) => z.string().trim().min(1).max(max);

/**
 * Les bornes de la saisie, appliquées aussi par l'écran avant l'envoi (`BORNES_OUTIL`) pour dire ce qui manque
 * au lieu d'un 400 ; `tests/mba-outils-parite.test.ts` tient les deux listes égales.
 */
export const BORNES_OUTIL_MBA = { titre: 120, texte: 2000, tag: LONGUEUR_MAX_ETIQUETTE, champ: 64, valeur: 120, valeurs: 50 } as const;
const B = BORNES_OUTIL_MBA;

/** La cible saisie à l'écran. `connecteur` désigne un appel ; les autres deviennent un `binding` maison. */
const cibleSaisieSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tag'), tag: z.string().trim().min(1).max(B.tag) }).strict(),
  z.object({
    type: z.literal('champ'),
    champ: z.string().trim().min(1).max(B.champ),
    valeurs: z.array(z.string().trim().min(1).max(B.valeur)).max(B.valeurs).default([]),
  }).strict(),
  z.object({ type: z.literal('bloc'), workflowId: z.string().uuid(), code: z.string().min(1).max(128) }).strict(),
  z.object({ type: z.literal('scenario'), workflowId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('connecteur'), requeteId: z.string().uuid() }).strict(),
]);
type CibleSaisie = z.infer<typeof cibleSaisieSchema>;

/**
 * Les types qu'une création accepte, lus sur le schéma. L'écran en propose un sous-ensemble ; un type proposé que
 * la route refuserait serait un bouton qui rend 400 (`tests/mba-outils-parite.test.ts`).
 */
export const TYPES_SAISISSABLES: readonly string[] = cibleSaisieSchema.options.map((o) => o.shape.type.value);

const creationSchema = z.object({
  name: NOM, title: texte(B.titre), description: texte(B.texte), nePasUtiliser: texte(B.texte), cible: cibleSaisieSchema,
}).strict();
const patchSchema = z.object({
  name: NOM.optional(), title: texte(B.titre).optional(), description: texte(B.texte).optional(),
  nePasUtiliser: texte(B.texte).optional(), cible: cibleSaisieSchema.optional(),
}).strict();
const reactivationSchema = z.object({ valeur: z.literal(true) }).strict();

function versCibleMaison(c: Exclude<CibleSaisie, { type: 'connecteur' }>): CibleMaison {
  switch (c.type) {
    case 'tag': return { handler: 'tag_fixe', tag: c.tag };
    case 'champ': return { handler: 'champ_fixe', champ: c.champ, valeurs: c.valeurs };
    case 'bloc': return { handler: 'bloc_fixe', workflowId: c.workflowId, code: c.code };
    case 'scenario': return { handler: 'scenario_fixe', workflowId: c.workflowId };
  }
}

const SANS_NUMERO = 'Aucun numéro WhatsApp connecté : il n’y a pas d’agent de Meta à qui donner cet outil.';

export function registerMbaOutils(app: FastifyInstance, deps: MbaOutilsDeps, garde: Guard): void {
  const base = '/tenants/:tenantId/mba-outils';
  const opts = { preHandler: garde };
  const utilisateur = (req: unknown): string => (req as { auth?: { userId?: string } }).auth?.userId ?? '';
  const premiereErreur = (e: z.ZodError): string => e.issues[0]?.message ?? 'corps invalide';

  /** La cible d'un outil maison existe-t-elle ? `null` = oui, sinon la raison (422). */
  const cibleInvalide = async (tenant: string, c: CibleSaisie): Promise<string | null> => {
    if (c.type === 'champ' && !(await deps.champs(tenant)).includes(c.champ)) {
      return `le champ « ${c.champ} » n’existe pas dans le mini-CRM`;
    }
    // Même vérification que le relais à chaque appel (`blocSeul`) : un bloc à boutons accepté ici serait ensuite
    // refusé à chaque appel de l'agent de Meta.
    if (c.type === 'bloc' || c.type === 'scenario') {
      const wf = await deps.workflow(tenant, c.workflowId);
      if (!wf) return 'ce scénario n’existe pas';
      if (c.type === 'bloc') {
        const r = blocSeul(wf.graph, c.code);
        if (!r.ok) return r.raison;
      } else if (entryNode(wf.graph) === null) {
        return SCENARIO_VIDE;
      }
    }
    return null;
  };

  /** Un nom déjà pris est une erreur de saisie : 409 lisible, jamais un 500. */
  const siNomPris = (err: unknown, reply: FastifyReply): FastifyReply => {
    if (err instanceof NomOutilDejaPris) return reply.code(409).send({ error: err.message });
    throw err;
  };

  app.get(base, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const pn = await deps.repo.getTenantPhoneNumberId(tenant);
    if (!pn) return reply.code(200).send({ outils: [], phoneNumberId: null });
    const outils = await deps.lister(tenant, pn);
    const ctx = await deps.contexte(tenant, outils);
    return reply.code(200).send({ outils: outils.map((o) => vueOutilMba(o, ctx)), phoneNumberId: pn });
  });

  // Déclarée avant toute route `/:outilId` en GET.
  app.get(`${base}/blocs`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const workflowId = (req.query as { workflowId?: unknown } | undefined)?.workflowId;
    if (typeof workflowId !== 'string' || !estUuid(workflowId)) return reply.code(400).send({ error: 'choisissez d’abord un scénario' });
    return reply.code(200).send({ blocs: await deps.blocs(tenant, workflowId) });
  });

  /**
   * Les outils MCP que l'agent de Meta peut recevoir (2026-10-02, route A). Ils ne se créent pas ici : ils viennent d'un
   * serveur déclaré dans « Connecteurs MCP », et c'est là que se règlent leurs paramètres.
   */
  app.get(`${base}/mcp`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const pn = await deps.repo.getTenantPhoneNumberId(tenant);
    if (!pn) return reply.code(200).send({ outils: [] });
    const [offrables, serveurs] = await Promise.all([deps.offrables(tenant, pn), deps.serveurs(tenant)]);
    return reply.code(200).send({ outils: outilsMcpProposables(offrables, serveurs) });
  });

  app.post<{ Params: { outilId: string } }>(`${base}/mcp/:outilId`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (!estUuid(req.params.outilId)) return reply.code(404).send({ error: 'outil MCP introuvable' });
    const userId = utilisateur(req);
    if (userId === '') return reply.code(403).send({ error: 'ajout impossible sans utilisateur identifié' });
    const pn = await deps.repo.getTenantPhoneNumberId(tenant);
    if (!pn) return reply.code(409).send({ error: SANS_NUMERO });
    const outil = (await deps.bibliotheque(tenant)).find((o) => o.id === req.params.outilId);
    // La bibliothèque est lue côté serveur : un identifiant d'outil maison ou de connecteur ne passe pas par ici.
    if (!outil || outil.origin !== 'mcp') return reply.code(404).send({ error: 'outil MCP introuvable' });
    /**
     * 🔴 RIEN N'EST REVÉRIFIÉ ICI (règle unique du 2026-10-02) : la porte du catalogue refuse un outil non enregistré,
     * mort, déjà donné ou dont l'agent de Meta porte déjà le nom (0211), et dit pourquoi. Elle refuse AVANT de rattacher un outil inappelable, donc l'activation qui
     * suit ne laisse plus de ligne éteinte qu'aucun geste ne rallume.
     */
    let r: Rattachement;
    try {
      r = await deps.proposerMcp(tenant, pn, outil.id, userId);
    } catch (err) {
      if (err instanceof OutilNonActivable) return reply.code(409).send({ error: err.raison });
      throw err;
    }
    if (r.ok) return reply.code(201).send({ id: outil.id });
    return reply.code(refusIntrouvable(r) ? 404 : 409).send({ error: messageDuRefus(r) });
  });

  app.post(base, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const lu = creationSchema.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: premiereErreur(lu.error) });
    const userId = utilisateur(req);
    if (userId === '') return reply.code(403).send({ error: 'création impossible sans utilisateur identifié' });
    const pn = await deps.repo.getTenantPhoneNumberId(tenant);
    if (!pn) return reply.code(409).send({ error: SANS_NUMERO });
    const { cible, ...mots } = lu.data;
    try {
      if (cible.type === 'connecteur') {
        const requete = await deps.requetes.parId(tenant, cible.requeteId);
        if (!requete) return reply.code(404).send({ error: 'requête introuvable' });
        // Le risque se dérive de la méthode, jamais du navigateur. Les variables ne se recopient pas : la publication
        // et le relais lisent la requête, et un agent IA qui partagerait l'outil aussi (`paramsDuConnecteur`).
        const cree = await deps.creerConnecteur(tenant, pn, {
          ...mots, sourceId: requete.sourceId, requestId: requete.id,
          risk: risqueSelonMethode(requete.methode as MethodeConnecteur),
        }, userId);
        if (!cree) return reply.code(404).send({ error: 'requête introuvable' });
        return reply.code(201).send({ id: cree.id });
      }
      const raison = await cibleInvalide(tenant, cible);
      if (raison !== null) return reply.code(422).send({ error: raison });
      const cree = await deps.outils.ajouterMaisonPourMba(tenant, pn, { ...mots, cible: versCibleMaison(cible) }, userId);
      if (!cree) return reply.code(422).send({ error: 'création refusée' });
      return reply.code(201).send({ id: cree.id });
    } catch (err) {
      // Un connecteur dont la source n'est pas active est refusé AVANT d'être créé (`ajouterConnecteurPourMba`).
      if (err instanceof OutilNonActivable) return reply.code(409).send({ error: err.raison });
      return siNomPris(err, reply);
    }
  });

  app.patch<{ Params: { outilId: string } }>(`${base}/:outilId`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (!estUuid(req.params.outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    const lu = patchSchema.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: premiereErreur(lu.error) });
    if (Object.keys(lu.data).length === 0) return reply.code(400).send({ error: 'rien à corriger' });
    const pn = await deps.repo.getTenantPhoneNumberId(tenant);
    if (!pn) return reply.code(409).send({ error: SANS_NUMERO });
    const outil = (await deps.lister(tenant, pn)).find((o) => o.id === req.params.outilId);
    if (!outil) return reply.code(404).send({ error: 'outil introuvable' });
    const { cible, ...mots } = lu.data;
    // Les mots d'un outil MCP sont ceux de la bibliothèque, partagés avec les agents IA : ils se règlent dans
    // « Connecteurs MCP », comme ses paramètres.
    if (outil.origin === 'mcp') return reply.code(400).send({ error: 'un outil MCP se règle dans Connecteurs MCP' });
    try {
      if (outil.origin === 'http') {
        // La définition d'un connecteur est partagée avec les agents IA qui l'utilisent : on ne change pas son appel.
        if (cible) return reply.code(400).send({ error: 'pour changer d’appel, créez un autre outil' });
        const fait = await deps.modifierConnecteur(tenant, pn, outil.id, mots);
        return fait ? reply.code(200).send({ id: fait.id }) : reply.code(404).send({ error: 'outil introuvable' });
      }
      if (cible?.type === 'connecteur') return reply.code(400).send({ error: 'un outil maison ne devient pas un connecteur' });
      if (cible) {
        const raison = await cibleInvalide(tenant, cible);
        if (raison !== null) return reply.code(422).send({ error: raison });
      }
      const fait = await deps.outils.patchMaisonPourMba(tenant, pn, outil.id, { ...mots, ...(cible ? { cible: versCibleMaison(cible) } : {}) });
      return fait ? reply.code(200).send({ id: fait.id }) : reply.code(404).send({ error: 'outil introuvable' });
    } catch (err) {
      return siNomPris(err, reply);
    }
  });

  app.delete<{ Params: { outilId: string } }>(`${base}/:outilId`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (!estUuid(req.params.outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    const pn = await deps.repo.getTenantPhoneNumberId(tenant);
    if (!pn) return reply.code(409).send({ error: SANS_NUMERO });
    const issue = await deps.outils.retirerDeMba(tenant, pn, req.params.outilId);
    return issue === 'introuvable' ? reply.code(404).send({ error: 'outil introuvable' }) : reply.code(204).send();
  });

  app.put<{ Params: { outilId: string } }>(`${base}/:outilId/actif`, opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (!estUuid(req.params.outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    // Seulement rallumer : éteindre sans retirer n'a pas d'usage à l'écran, et ferait un outil muet de plus.
    if (!reactivationSchema.safeParse(req.body).success) return reply.code(400).send({ error: 'seule la réactivation est possible' });
    const userId = utilisateur(req);
    if (userId === '') return reply.code(403).send({ error: 'réactivation impossible sans utilisateur identifié' });
    const pn = await deps.repo.getTenantPhoneNumberId(tenant);
    if (!pn) return reply.code(409).send({ error: SANS_NUMERO });
    // `activerConsommateur` lève sur un outil non activable (un MCP marqué non activable) : 409 plutôt qu'un 500.
    let fait: boolean;
    try {
      fait = await deps.reactiver(tenant, pn, req.params.outilId, userId);
    } catch (err) {
      if (err instanceof OutilNonActivable) return reply.code(409).send({ error: err.raison });
      throw err;
    }
    return fait ? reply.code(200).send({ actif: true }) : reply.code(404).send({ error: 'outil introuvable' });
  });
}
