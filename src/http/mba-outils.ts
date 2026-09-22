import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import type { OutilComplet, RisqueOutil } from '../agent/catalog';
import { NomOutilDejaPris, OutilNonActivable } from '../agent/catalog';
import type { RequeteConnecteur } from '../agent/requetes';
import { risqueSelonMethode, type MethodeConnecteur } from '../agent/http-cible';
import { scopeTenant, estUuid } from './scope';
import { blocSeul, type BlocPropose, type CibleMaison } from '../mba/outils-maison';
import { vueOutilMba, SCENARIO_VIDE, type ContexteVue } from '../mba/vue-outils';
import { entryNode } from '../workflow/engine';
import type { WorkflowGraph } from '../workflow/graph';

/**
 * L'ONGLET « OUTILS » DE L'AGENT DE META (spec docs/superpowers/specs/2026-09-21-outils-maison-mba-design.md, § 9).
 *
 * 🔴 IL NE PARLE QUE DES OUTILS DE L'AGENT DE META. La bibliothèque de l'espace (`GET /agent-tools`) reste aux
 * agents IA ; l'ancien écran mélangeait les deux, et c'est ce qui le rendait illisible (Julien, 2026-09-21).
 *
 * ⚠️ LE NUMÉRO VIENT DU SERVEUR, jamais du corps : c'est lui qui désigne l'agent de Meta de l'espace. La CIBLE
 * saisie devient un `binding` du catalogue (`src/mba/outils-maison.ts`), et le RISQUE d'un connecteur se dérive
 * de la méthode de sa requête : le navigateur ne choisit ni l'un ni l'autre (`.strict()` refuse les clés en trop).
 */
interface TextesOutil { name: string; title: string; description: string; nePasUtiliser: string }

export interface MbaOutilsDeps {
  numeroDuTenant(tenantId: string): Promise<string | null>;
  /** Les outils du consommateur `mba:<numéro>`, actifs ou non. */
  lister(tenantId: string, phoneNumberId: string): Promise<OutilComplet[]>;
  /** Ce qu'il faut pour dire d'une ligne ce qu'elle vise, et si c'est encore là. */
  contexte(tenantId: string, outils: readonly OutilComplet[]): Promise<ContexteVue>;
  requete(tenantId: string, id: string): Promise<Pick<RequeteConnecteur, 'id' | 'sourceId' | 'methode' | 'variables'> | null>;
  /** Les clés des champs déclarés du mini-CRM. */
  champs(tenantId: string): Promise<string[]>;
  creerMaison(tenantId: string, phoneNumberId: string, outil: TextesOutil & { cible: CibleMaison }, parUtilisateur: string): Promise<{ id: string } | null>;
  /** Créer l'outil de connecteur ET l'activer pour l'agent de Meta, au nom de `parUtilisateur`. */
  creerConnecteur(tenantId: string, phoneNumberId: string, outil: TextesOutil & {
    sourceId: string; requestId: string; params: unknown; risk: RisqueOutil;
  }, parUtilisateur: string): Promise<{ id: string } | null>;
  modifierMaison(tenantId: string, phoneNumberId: string, outilId: string, patch: Partial<TextesOutil> & { cible?: CibleMaison }): Promise<{ id: string } | null>;
  modifierConnecteur(tenantId: string, phoneNumberId: string, outilId: string, patch: Partial<TextesOutil>): Promise<{ id: string } | null>;
  retirer(tenantId: string, phoneNumberId: string, outilId: string): Promise<'supprime' | 'detache' | 'introuvable'>;
  /** Rallumer un outil éteint par le départ de son auteur (plan 2026-09-21-outils-maison-mba, écart 4). */
  reactiver(tenantId: string, phoneNumberId: string, outilId: string, parUtilisateur: string): Promise<boolean>;
  /** Un scénario de l'espace, avec son graphe PUBLIÉ (celui que le relais joue), ou `null`. */
  workflow(tenantId: string, id: string): Promise<{ name: string; graph: WorkflowGraph } | null>;
  /** Les blocs des scénarios publiés, envoyables seuls ou non, pour le choix de l'écran. */
  blocs(tenantId: string): Promise<BlocPropose[]>;
}

const NOM = z.string().trim().regex(/^[a-z0-9_]{1,64}$/, 'nom technique au format [a-z0-9_], 64 caractères au plus');
const texte = (max: number) => z.string().trim().min(1).max(max);

/**
 * Les bornes de la saisie. 🔴 L'écran les applique AVANT l'envoi (`BORNES_OUTIL`, `web/lib/mba-outils.ts`) pour
 * dire ce qui manque au lieu d'un 400 ; `tests/mba-outils-parite.test.ts` tient les deux listes égales.
 */
export const BORNES_OUTIL_MBA = { titre: 120, texte: 2000, tag: 64, champ: 64, valeur: 120, valeurs: 50 } as const;
const B = BORNES_OUTIL_MBA;

/** La cible SAISIE à l'écran. `connecteur` désigne un appel ; les autres deviennent un `binding` maison. */
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
 * Les types qu'une création accepte, lus sur le schéma lui-même. 🔴 L'écran en propose un sous-ensemble, et un
 * type proposé que la route refuse serait un bouton qui rend 400 : `tests/mba-outils-parite.test.ts` le tient.
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
    // 🔴 La même vérification que le relais fait à chaque appel (`blocSeul`) : un bloc à boutons accepté ici
    // refuserait ensuite chaque appel de l'agent de Meta.
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

  /** Un nom déjà pris est une erreur de saisie, lisible : 409, jamais un 500 dont Cloudflare remplace le corps. */
  const siNomPris = (err: unknown, reply: FastifyReply): FastifyReply => {
    if (err instanceof NomOutilDejaPris) return reply.code(409).send({ error: err.message });
    throw err;
  };

  app.get(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    const pn = await deps.numeroDuTenant(tenant);
    if (!pn) return reply.code(200).send({ outils: [], phoneNumberId: null });
    const outils = await deps.lister(tenant, pn);
    const ctx = await deps.contexte(tenant, outils);
    return reply.code(200).send({ outils: outils.map((o) => vueOutilMba(o, ctx)), phoneNumberId: pn });
  });

  // Déclarée avant toute route `/:outilId` en GET (il n'y en a aucune aujourd'hui : seuls PATCH et DELETE en portent).
  app.get(`${base}/blocs`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    return reply.code(200).send({ blocs: await deps.blocs(tenant) });
  });

  app.post(base, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    const lu = creationSchema.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: premiereErreur(lu.error) });
    const userId = utilisateur(req);
    if (userId === '') return reply.code(403).send({ error: 'création impossible sans utilisateur identifié' });
    const pn = await deps.numeroDuTenant(tenant);
    if (!pn) return reply.code(409).send({ error: SANS_NUMERO });
    const { cible, ...mots } = lu.data;
    try {
      if (cible.type === 'connecteur') {
        const requete = await deps.requete(tenant, cible.requeteId);
        if (!requete) return reply.code(404).send({ error: 'requête introuvable' });
        // Le MODÈLE ne voit que ce qu'il doit remplir ; le risque se DÉRIVE de la méthode, jamais du navigateur.
        const params = requete.variables.filter((v) => v.origine.type === 'modele').map((v) => ({
          name: v.nom, type: v.type, source: 'modele' as const,
          ...(v.description ? { description: v.description } : {}),
          ...(v.requis ? { required: true } : {}),
          ...(v.enum && v.enum.length > 0 ? { enum: v.enum } : {}),
        }));
        const cree = await deps.creerConnecteur(tenant, pn, {
          ...mots, sourceId: requete.sourceId, requestId: requete.id, params,
          risk: risqueSelonMethode(requete.methode as MethodeConnecteur),
        }, userId);
        if (!cree) return reply.code(404).send({ error: 'requête introuvable' });
        return reply.code(201).send({ id: cree.id });
      }
      const raison = await cibleInvalide(tenant, cible);
      if (raison !== null) return reply.code(422).send({ error: raison });
      const cree = await deps.creerMaison(tenant, pn, { ...mots, cible: versCibleMaison(cible) }, userId);
      if (!cree) return reply.code(422).send({ error: 'création refusée' });
      return reply.code(201).send({ id: cree.id });
    } catch (err) {
      return siNomPris(err, reply);
    }
  });

  app.patch<{ Params: { outilId: string } }>(`${base}/:outilId`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    if (!estUuid(req.params.outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    const lu = patchSchema.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: premiereErreur(lu.error) });
    if (Object.keys(lu.data).length === 0) return reply.code(400).send({ error: 'rien à corriger' });
    const pn = await deps.numeroDuTenant(tenant);
    if (!pn) return reply.code(409).send({ error: SANS_NUMERO });
    const outil = (await deps.lister(tenant, pn)).find((o) => o.id === req.params.outilId);
    if (!outil) return reply.code(404).send({ error: 'outil introuvable' });
    const { cible, ...mots } = lu.data;
    try {
      if (outil.origin === 'http') {
        // Plan, écart 1 : la définition d'un connecteur est partagée avec les agents IA qui l'utilisent.
        if (cible) return reply.code(400).send({ error: 'pour changer d’appel, créez un autre outil' });
        const fait = await deps.modifierConnecteur(tenant, pn, outil.id, mots);
        return fait ? reply.code(200).send({ id: fait.id }) : reply.code(404).send({ error: 'outil introuvable' });
      }
      if (cible?.type === 'connecteur') return reply.code(400).send({ error: 'un outil maison ne devient pas un connecteur' });
      if (cible) {
        const raison = await cibleInvalide(tenant, cible);
        if (raison !== null) return reply.code(422).send({ error: raison });
      }
      const fait = await deps.modifierMaison(tenant, pn, outil.id, { ...mots, ...(cible ? { cible: versCibleMaison(cible) } : {}) });
      return fait ? reply.code(200).send({ id: fait.id }) : reply.code(404).send({ error: 'outil introuvable' });
    } catch (err) {
      return siNomPris(err, reply);
    }
  });

  app.delete<{ Params: { outilId: string } }>(`${base}/:outilId`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    if (!estUuid(req.params.outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    const pn = await deps.numeroDuTenant(tenant);
    if (!pn) return reply.code(409).send({ error: SANS_NUMERO });
    const issue = await deps.retirer(tenant, pn, req.params.outilId);
    return issue === 'introuvable' ? reply.code(404).send({ error: 'outil introuvable' }) : reply.code(204).send();
  });

  app.put<{ Params: { outilId: string } }>(`${base}/:outilId/actif`, opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'espace interdit' });
    if (!estUuid(req.params.outilId)) return reply.code(404).send({ error: 'outil introuvable' });
    // Seulement RALLUMER : éteindre sans retirer n'a pas d'usage à l'écran, et ferait un outil muet de plus.
    if (!reactivationSchema.safeParse(req.body).success) return reply.code(400).send({ error: 'seule la réactivation est possible' });
    const userId = utilisateur(req);
    if (userId === '') return reply.code(403).send({ error: 'réactivation impossible sans utilisateur identifié' });
    const pn = await deps.numeroDuTenant(tenant);
    if (!pn) return reply.code(409).send({ error: SANS_NUMERO });
    // 🔴 `activerConsommateur` LÈVE sur un outil qui ne peut pas s'activer (un MCP marqué non activable, exposé
    // à l'agent de Meta par l'ancienne bibliothèque). Sans ce `catch`, un 500, donc une page Cloudflare sans un
    // mot ; l'ancienne route le traduisait déjà en 409, et la garde s'était perdue au portage.
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
