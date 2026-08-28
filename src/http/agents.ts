import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import type { AgentComplet, AgentResume, PatchAgent } from '../agent/agent-store';
import { FicheAgentPerimee, LabelAgentDejaPris } from '../agent/agent-store';
import { ficheAgentSchema } from '../agent/fiche';
import { scopeTenant, nonEmpty, estUuid } from './scope';

export interface AgentsRouteDeps {
  listActifs(tenantId: string): Promise<AgentResume[]>;
  listToutes(tenantId: string): Promise<AgentResume[]>;
  complet(tenantId: string, id: string): Promise<AgentComplet | null>;
  create(tenantId: string, label: string, mentionIa: string, modele: string): Promise<AgentComplet>;
  patch(tenantId: string, id: string, patch: PatchAgent): Promise<AgentComplet | null>;
  remove(tenantId: string, id: string): Promise<boolean>;
  /** Modèle par défaut d'un agent neuf. Vient de la configuration serveur, pas du client. */
  modeleParDefaut: string;
}

/**
 * Les agents IA d'un workspace.
 *
 * Réservée aux ADMINISTRATEURS, comme les formulaires et comme le builder qu'elle sert : un compte non admin
 * ne peut ouvrir ni l'un ni l'autre. L'ouvrir plus largement élargirait la surface sans usage, et les codes
 * des règles d'arrêt disent le métier du client.
 *
 * 🔴 CE QUE LE CLIENT PEUT ÉCRIRE, ET CE QU'IL NE PEUT PAS. La colonne `fiche` (jsonb) porte tout ce qui
 * décrit l'agent, et c'est elle que l'IA de construction remplira un jour : elle passe par
 * `ficheAgentSchema.safeParse`. Les PLAFONDS, le modèle, la mention légale et le statut vivent en colonnes,
 * et chacun est borné ici : une saisie ne relève pas un plafond de dépense au-delà de ce que la base accepte,
 * et n'efface pas la phrase qui annonce que l'interlocuteur parle à une IA (AI Act, article 50).
 */

/** Mention d'IA par défaut. Obligatoire en base (`not null`), donc il en faut une dès la création : la laisser
 *  vide reviendrait à créer un agent hors-la-loi que personne ne penserait à compléter. */
const MENTION_IA_DEFAUT = 'Vous échangez avec un assistant automatique.';

/**
 * Bornes des champs.
 *
 * Cinq d'entre elles rejouent un `check` de la migration 0086 (`max_tours`, `max_appels_outils`,
 * `inactivite_minutes`, `contact_inconnu`, `status`) : la base refuserait de toute façon, mais en 500, dont
 * Cloudflare remplace le corps. Les répéter ici transforme un échec illisible en un 400 qui dit quoi
 * corriger. `tests/agents-bornes-parity.test.ts` casse si l'une d'elles s'écarte de la migration.
 *
 * Les autres (`label`, `mentionIa`, `modele`, la borne HAUTE du budget) n'ont AUCUN équivalent en base : ce
 * sont des colonnes `text` nues et un `bigint > 0`. Ici, elles sont le seul garde-fou.
 */
const LABEL = z.string().trim().min(1).max(120);
const patchSchema = z.object({
  label: LABEL.optional(),
  status: z.enum(['draft', 'active', 'disabled']).optional(),
  mentionIa: z.string().trim().min(1).max(500).optional(),
  modele: z.string().trim().min(1).max(120).optional(),
  maxTours: z.number().int().min(1).max(20).optional(),
  maxAppelsOutils: z.number().int().min(0).max(60).optional(),
  budgetMicroEur: z.number().int().min(1).max(100_000_000).optional(),
  inactiviteMinutes: z.number().int().min(1).max(1440).optional(),
  contactInconnu: z.enum(['aucun_outil', 'lecture_seule', 'tous']).optional(),
  // `.partial()` : le patch de la fiche est une FUSION. Sans ça, `ficheAgentSchema` remplirait chaque champ
  // absent par son défaut, et enregistrer l'objectif effacerait le ton, les règles et toutes les sorties.
  contenu: ficheAgentSchema.partial().optional(),
  /** Version lue au chargement. Fournie -> l'écriture est refusée en 409 si la fiche a bougé entre-temps. */
  ficheVersionAttendue: z.number().int().min(1).optional(),
});
const creationSchema = z.object({ label: LABEL });

export function registerAgents(app: FastifyInstance, deps: AgentsRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  app.get('/tenants/:tenantId/agents', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    // `?statut=tous` : l'écran de réglage voit ses brouillons, le builder ne voit que les actifs. Le défaut
    // est le plus RESTRICTIF, pour qu'un appelant distrait ne propose pas un brouillon dans un scénario.
    const tous = (req.query as { statut?: string }).statut === 'tous';
    const agents = tous ? await deps.listToutes(tenant) : await deps.listActifs(tenant);
    return reply.code(200).send({ agents });
  });

  app.get('/tenants/:tenantId/agents/:agentId', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { agentId } = req.params as { agentId: string };
    // Un identifiant mal forme part sinon tel quel dans un `where` sur une colonne `uuid` et fait LEVER
    // Postgres, donc un 500 dont Cloudflare remplace le corps. Une adresse tapee de travers rend 404.
    if (!estUuid(agentId)) return reply.code(404).send({ error: 'agent introuvable' });
    const agent = await deps.complet(tenant, agentId);
    if (!agent) return reply.code(404).send({ error: 'agent introuvable' });
    return reply.code(200).send({ agent });
  });

  app.post('/tenants/:tenantId/agents', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const parse = creationSchema.safeParse(req.body ?? {});
    // Même règle qu'au PATCH : un label trop long est REFUSÉ, pas tronqué en silence. Deux comportements
    // différents pour le même champ selon la route feraient croire à un bug d'affichage.
    if (!parse.success) return reply.code(400).send({ error: 'label requis, 120 caractères au plus' });
    // Un agent sans modèle serait activable et muet au premier tour. La configuration serveur est la seule
    // source ici : le corps ne peut pas en imposer un.
    if (!nonEmpty(deps.modeleParDefaut)) {
      return reply.code(422).send({ error: 'aucun modèle par défaut configuré côté serveur' });
    }
    try {
      // Créé en BROUILLON par le store, jamais actif : le corps ne peut pas en décider, et c'est voulu.
      const agent = await deps.create(tenant, parse.data.label, MENTION_IA_DEFAUT, deps.modeleParDefaut);
      return reply.code(201).send({ agent });
    } catch (err) {
      if (err instanceof LabelAgentDejaPris) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.patch('/tenants/:tenantId/agents/:agentId', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) return reply.code(404).send({ error: 'agent introuvable' });
    const parse = patchSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      const detail = parse.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');
      // 4xx et non 5xx : Cloudflare remplace le corps d'une 5xx par sa propre page d'erreur, et le client ne
      // saurait jamais quel champ corriger.
      return reply.code(400).send({ error: `champs invalides : ${detail}` });
    }
    // Une version seule ne modifie rien : elle accompagne un patch, elle n'en est pas un.
    const { ficheVersionAttendue: _v, ...champs } = parse.data;
    if (Object.keys(champs).length === 0) return reply.code(400).send({ error: 'aucun champ à modifier' });
    try {
      const agent = await deps.patch(tenant, agentId, parse.data);
      if (!agent) return reply.code(404).send({ error: 'agent introuvable' });
      return reply.code(200).send({ agent });
    } catch (err) {
      if (err instanceof FicheAgentPerimee) return reply.code(409).send({ error: err.message });
      if (err instanceof LabelAgentDejaPris) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/tenants/:tenantId/agents/:agentId', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) return reply.code(404).send({ error: 'agent introuvable' });
    // Sans cette route, un agent créé avec un nom malheureux ne pouvait être ni renommé vers un nom occupé,
    // ni retiré : le workspace gardait une ligne morte pour toujours.
    const supprime = await deps.remove(tenant, agentId);
    if (!supprime) return reply.code(404).send({ error: 'agent introuvable' });
    return reply.code(204).send();
  });
}
