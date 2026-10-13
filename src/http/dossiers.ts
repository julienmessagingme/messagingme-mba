import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { forbidNonAdmin, type PreHandler } from '../auth/middleware';
import type { DossierStore } from '../dossiers/store.pg';
import { MAX_DOSSIERS_PAR_TYPE, MAX_NOM_DOSSIER, TYPES_DOSSIER, type TypeDossier } from '../dossiers/regles';
import { espaceVerifie, estUuid } from './scope';

export type DossiersRouteDeps = DossierStore;

/** Combien d'éléments un rangement en masse porte au plus : une page de liste, pas un import. */
export const MAX_CLES_RANGEMENT = 500;

const UUID = z.string().refine(estUuid, 'identifiant invalide');
/** Le nom d'un template chez Meta : minuscules, chiffres et tirets bas, 512 au plus. */
const NOM_TEMPLATE = z.string().regex(/^[a-z0-9_]+$/).max(512);
const typeSchema = z.enum(TYPES_DOSSIER);
/** Ramené par `trim` AVANT la borne et l'index `lower(nom)` : « SAV » et « sav  » sont le même dossier. */
const nomSchema = z.string().trim().min(1).max(MAX_NOM_DOSSIER);

const creationSchema = z.object({ type: typeSchema, nom: nomSchema }).strict();
const renommageSchema = z.object({ nom: nomSchema }).strict();
const rangementSchema = z.object({
  type: typeSchema,
  cles: z.array(z.string()).max(MAX_CLES_RANGEMENT),
  dossierId: UUID.nullable(),
}).strict().superRefine((b, ctx) => {
  // La clé d'un scénario est son id, celle d'un template son nom : chacune sous SA forme, sans quoi un id forgé
  // passerait pour un nom de template (ou ferait échouer le cast uuid en base, une 500).
  const forme = b.type === 'scenario' ? UUID : NOM_TEMPLATE;
  b.cles.forEach((c, i) => { if (!forme.safeParse(c).success) ctx.addIssue({ code: 'custom', path: ['cles', i], message: 'clé invalide' }); });
});

/**
 * LES DOSSIERS QUI RANGENT LES SCÉNARIOS ET LES TEMPLATES (décision de Julien du 2026-10-13, migration 0229). Lire est à
 * toute session de l'espace, écrire aux admins. La liste des scénarios et celle des templates ne changent pas : la
 * console lit ici les dossiers ET le rangement, et fusionne. L'espace vient du jeton (`espaceVerifie`), jamais du corps.
 */
export function registerDossiers(app: FastifyInstance, deps: DossiersRouteDeps, garde: PreHandler): void {
  const opts = { preHandler: garde };

  app.get('/tenants/:tenantId/dossiers', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const type = typeSchema.safeParse((req.query as { type?: unknown }).type);
    if (!type.success) return reply.code(400).send({ error: 'type requis : scenario ou template' });
    const [dossiers, rangement] = await Promise.all([deps.lister(tenant, type.data), deps.rangement(tenant, type.data)]);
    return reply.code(200).send({ dossiers, rangement });
  });

  app.post('/tenants/:tenantId/dossiers', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const b = creationSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: `type (scenario ou template) et nom (1 à ${MAX_NOM_DOSSIER} caractères) requis` });
    const r = await deps.creer(tenant, b.data.type, b.data.nom);
    if (r === 'pris') return reply.code(409).send({ error: 'un dossier porte déjà ce nom' });
    if (r === 'plein') return reply.code(422).send({ error: `${MAX_DOSSIERS_PAR_TYPE} dossiers au plus` });
    return reply.code(201).send({ dossier: r });
  });

  app.patch('/tenants/:tenantId/dossiers/:id', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!estUuid(id)) return reply.code(404).send({ error: 'dossier inconnu' });
    const b = renommageSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: `nom requis (1 à ${MAX_NOM_DOSSIER} caractères)` });
    const r = await deps.renommer(tenant, id, b.data.nom);
    if (r === 'pris') return reply.code(409).send({ error: 'un dossier porte déjà ce nom' });
    if (r === null) return reply.code(404).send({ error: 'dossier inconnu' });
    return reply.code(200).send({ dossier: r });
  });

  app.delete('/tenants/:tenantId/dossiers/:id', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    if (!estUuid(id) || !(await deps.supprimer(tenant, id))) return reply.code(404).send({ error: 'dossier inconnu' });
    return reply.code(200).send({ supprime: true });
  });

  // Statique : elle passe avant `/dossiers/:id` (find-my-way préfère le segment fixe), et elle n'a pas de :id.
  app.put('/tenants/:tenantId/dossiers/rangement', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (forbidNonAdmin(req, reply)) return;
    const b = rangementSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: `type, cles (${MAX_CLES_RANGEMENT} au plus, à la forme du type) et dossierId (ou null) requis` });
    const r = await deps.ranger(tenant, b.data.type as TypeDossier, b.data.cles, b.data.dossierId);
    if (r === 'dossier_inconnu') return reply.code(404).send({ error: 'dossier inconnu' });
    return reply.code(200).send({ ranges: r });
  });
}
