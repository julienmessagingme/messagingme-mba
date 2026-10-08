import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import type { AgentComplet, AgentResume, PatchAgent } from '../agent/agent-store';
import type { ModeleProposable } from '../agent/modeles';
import { creerAgent, manquesDeLAgent, modifierAgent, type DepsGestionAgents } from '../agent/gestion';
import { corpsDuRefus } from '../lib/issue';
import { espaceVerifie, estUuid } from './scope';
import type { ConsommationAgent } from '../agent/session-store';
import type { LigneHistorique } from '../agent/credits';
import {
  choisirRepondeur, choixDeLAncienneFormeSousLOffre, lireRepondeur, type ChoixRepondeur, type DepsReglageRepondeur,
} from '../repondeur/reglage';

/**
 * La fenêtre du suivi de consommation : trente jours, assez pour voir une tendance, assez court pour que
 * l'index `(tenant_id, created_at desc)` serve la requête.
 */
export const JOURS_CONSOMMATION = 30;

/** Les lignes de l'historique du crédit que la page montre. */
export const LIGNES_HISTORIQUE = 50;

/** Ce que les routes lisent et écrivent des fiches d'agent. */
export interface AgentsDep {
  listActifs(tenantId: string): Promise<AgentResume[]>;
  listToutes(tenantId: string): Promise<AgentResume[]>;
  complet(tenantId: string, id: string): Promise<AgentComplet | null>;
  create(tenantId: string, label: string, mentionIa: string, modele: string): Promise<AgentComplet>;
  patch(tenantId: string, id: string, patch: PatchAgent): Promise<AgentComplet | null>;
  remove(tenantId: string, id: string): Promise<boolean>;
}

/**
 * La gestion (`src/agent/gestion.ts` : modèle par défaut, lint d'activation, clé du modèle, historique), plus ce que
 * seules les routes lisent.
 */
export interface AgentsRouteDeps extends DepsGestionAgents {
  agents: AgentsDep;
  credits: {
    /**
     * Le solde prépayé de l'espace, en micro-euros. 🔴 Lecture seule : un client ne s'ajoute pas de crédit par une
     * écriture de solde. Il paie (webhook Stripe, `src/http/credit-stripe.ts`), ou l'exploitation le recharge (`/ops`).
     */
    solde(tenantId: string): Promise<number>;
    /** L'historique de ce qui a fait bouger le solde, pour la page Crédit IA (`PgCreditStore.historique`). */
    historique(tenantId: string, limite: number): Promise<LigneHistorique[]>;
  };
  sessions: {
    /** Ce que cet agent a consommé sur une fenêtre. */
    consommation(tenantId: string, agentId: string, jours: number): Promise<ConsommationAgent>;
    /** Les messages échangés dans les conversations que cet agent a tenues, sur une fenêtre de N jours. */
    messagesTenus(tenantId: string, agentId: string, jours: number): Promise<number>;
  };
  /**
   * Les modèles proposables et leur tarif, pour la liste de l'onglet Modèle, au tarif de l'offre de CET espace (sa
   * commission). Le câblage rend nos modèles sans tarif quand la tarification est indisponible : son absence
   * n'interdit pas un réglage.
   */
  modelesProposes(tenantId: string): Promise<ModeleProposable[]>;
  /** Le répondeur de l'espace (`src/repondeur/reglage.ts`) : le MÊME objet que l'outil MCP `set_default_responder`. */
  repondeur: DepsReglageRepondeur;
}

/**
 * Le corps de l'ANCIENNE `PUT .../agents/repondeur` (lot 5) : un agent, ou `null` pour n'en désigner aucun. Gardée pour
 * la console d'avant RC6 (elle est publiée APRÈS l'API) ; elle passe par `choixDeLAncienneFormeSousLOffre`.
 */
const corpsRepondeur = z.object({ agentId: z.string().max(100).nullable() });

/**
 * Le corps de `PUT /tenants/:tenantId/repondeur` (RC6) : un mode et sa cible. Le délai est en heures, comme à l'écran,
 * et ses bornes sont dans `choisirRepondeur` (une seule règle pour la console et l'outil MCP).
 */
const corpsQuiRepond = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('mba') }),
  z.object({ mode: z.literal('equipe') }),
  z.object({ mode: z.literal('agent'), agentId: z.string().max(100) }),
  z.object({ mode: z.literal('scenario'), workflowId: z.string().max(100), delaiHeures: z.number().int().optional() }),
]);

/**
 * Les agents IA d'un espace, réservés aux administrateurs (comme le builder qu'ils servent). Création et
 * modification passent par `src/agent/gestion.ts`, que les outils MCP de l'agent appellent aussi : les bornes, le
 * lint et la ligne d'historique y vivent, la route ne fait que traduire l'issue en statut.
 */

export function registerAgents(app: FastifyInstance, deps: AgentsRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  /**
   * Le solde prépayé de l'espace, en lecture seulement : un client qui pourrait s'en ajouter n'aurait plus de
   * prépayé du tout.
   */
  app.get('/tenants/:tenantId/agents/solde', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ soldeMicroEur: await deps.credits.solde(tenant) });
  });

  /**
   * Ce qui a fait bouger le solde, du plus récent au plus ancien : achats, crédit offert, recharges manuelles, et les
   * agents et les traductions agrégés par jour. Même garde que le solde. Aucune note : l'écran dit la raison en clair.
   * Le nombre de lignes est fixé ici, pas pris dans la requête.
   */
  app.get('/tenants/:tenantId/agents/mouvements', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send({ mouvements: await deps.credits.historique(tenant, LIGNES_HISTORIQUE) });
  });

  /**
   * Ce que l'agent a consommé, en tokens et en coût : une mesure, pas un plafond (le plafond par conversation
   * existe toujours contre une boucle qui s'emballe, mais n'a rien à faire sur cet écran).
   */
  app.get('/tenants/:tenantId/agents/:agentId/consommation', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) return reply.code(404).send({ error: 'agent introuvable' });
    // La fenêtre est fixée ici et pas prise dans la requête : un paramètre libre laisserait demander « depuis
    // toujours », qui relit toutes les sessions de l'espace pour un chiffre qui ne dit rien de l'usage courant.
    return reply.code(200).send({ consommation: await deps.sessions.consommation(tenant, agentId, JOURS_CONSOMMATION) });
  });

  /**
   * Combien de messages ont été échangés dans les conversations de cet agent, sur la même fenêtre que la
   * consommation (les deux chiffres sont comparés sur le même écran ; `jours` est rendu par le serveur).
   * `messages: null` quand on ne sait pas, jamais 0 : un zéro affirmerait que l'agent n'a parlé à personne.
   */
  app.get('/tenants/:tenantId/agents/:agentId/messages', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) return reply.code(404).send({ error: 'agent introuvable' });
    return reply.code(200).send({
      messages: await deps.sessions.messagesTenus(tenant, agentId, JOURS_CONSOMMATION),
      jours: JOURS_CONSOMMATION,
    });
  });

  app.get('/tenants/:tenantId/agents', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    // `?statut=tous` : l'écran de réglage voit ses brouillons, le builder ne voit que les actifs. Le défaut
    // est le plus restrictif, pour qu'un appelant distrait ne propose pas un brouillon dans un scénario.
    const tous = (req.query as { statut?: string }).statut === 'tous';
    const [agents, reglages] = await Promise.all([
      tous ? deps.agents.listToutes(tenant) : deps.agents.listActifs(tenant),
      deps.repondeur.reglages.get(tenant),
    ]);
    // Le répondeur de l'espace, à côté de la liste : l'écran dit lequel répond à tous les messages.
    return reply.code(200).send({ agents, repondeurAgentId: reglages.repondeurAgentId });
  });

  /**
   * « Qui répond au client » (RC6), ce que la carte de l'Accueil lit en un appel : le mode écrit et celui qui
   * s'applique, sa cible, le délai du scénario, l'agent de Meta (allumé, configurable), les agents actifs et les
   * scénarios publiés. Admins seulement (la garde du module).
   */
  app.get('/tenants/:tenantId/repondeur', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    return reply.code(200).send(await lireRepondeur(deps.repondeur, tenant, (t) => deps.agents.listActifs(t)));
  });

  /**
   * Règle qui répond au client : `{ mode: 'mba' | 'equipe' }`, `{ mode: 'agent', agentId }`, `{ mode: 'scenario',
   * workflowId, delaiHeures? }`. Admins seulement. Quitter le mode « MBA » retire ses contacts de la liste de l'agent de
   * Meta (la console le confirme avant) ; choisir « MBA » l'allume s'il est éteint. L'auteur vient de la session.
   */
  app.put('/tenants/:tenantId/repondeur', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const lu = corpsQuiRepond.safeParse(req.body ?? {});
    if (!lu.success) {
      return reply.code(400).send({ error: 'mode requis : « mba », « equipe », « agent » avec agentId, ou « scenario » avec workflowId (et delaiHeures)' });
    }
    const c = lu.data;
    const choix: ChoixRepondeur = c.mode === 'scenario'
      ? { mode: 'scenario', workflowId: c.workflowId, ...(c.delaiHeures !== undefined ? { delaiS: c.delaiHeures * 3600 } : {}) }
      : c;
    const r = await choisirRepondeur(deps.repondeur, tenant, choix, { userId: req.auth?.userId ?? null, origine: 'formulaire' });
    if (!r.ok) return reply.code(r.statut).send(corpsDuRefus(r));
    return reply.code(200).send(r.valeur);
  });

  /**
   * L'ANCIENNE porte du lot 5 : un agent IA (`agentId`), ou `null` (« aucun agent IA » : l'agent de Meta s'il est
   * allumé, sinon l'équipe, `choixDeLAncienneFormeSousLOffre`, sous l'offre). Gardée pour la console d'avant RC6, publiée après l'API ; elle ne
   * répond plus « agent de Meta éteint », puisque désigner un agent ne l'éteint plus. Sa réponse garde sa forme.
   */
  app.put('/tenants/:tenantId/agents/repondeur', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const lu = corpsRepondeur.safeParse(req.body ?? {});
    if (!lu.success) return reply.code(400).send({ error: 'agentId requis : l’identifiant d’un agent actif, ou null' });
    const choix = await choixDeLAncienneFormeSousLOffre(deps.repondeur, tenant, lu.data.agentId);
    const r = await choisirRepondeur(deps.repondeur, tenant, choix, { userId: req.auth?.userId ?? null, origine: 'formulaire' });
    if (!r.ok) return reply.code(r.statut).send(corpsDuRefus(r));
    return reply.code(200).send({ repondeurAgentId: r.valeur.agentId, agentDeMetaEteint: false, liste: r.valeur.liste });
  });

  app.get('/tenants/:tenantId/agents/:agentId', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { agentId } = req.params as { agentId: string };
    // Identifiant mal formé : 404, sinon Postgres lèverait sur la colonne `uuid` (donc un 500).
    if (!estUuid(agentId)) return reply.code(404).send({ error: 'agent introuvable' });
    const agent = await deps.agents.complet(tenant, agentId);
    if (!agent) return reply.code(404).send({ error: 'agent introuvable' });
    return reply.code(200).send({ agent });
  });

  app.post('/tenants/:tenantId/agents', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await creerAgent(deps, tenant, req.body);
    if (!r.ok) return reply.code(r.statut).send(corpsDuRefus(r));
    return reply.code(201).send({ agent: r.valeur });
  });

  /**
   * Ce qui manque à cet agent, en lecture : le lint ne parlait qu'à l'activation, et un agent en brouillon essayé
   * au bac à sable ne le voyait jamais. Même fonction que la garde d'activation (`manquesAvantActivation`), jamais
   * une seconde liste.
   */
  app.get('/tenants/:tenantId/agents/:agentId/manques', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { agentId } = req.params as { agentId: string };
    // Deux listes, un seul bandeau (`manquesDeLAgent`, la lecture que les outils MCP de l'agent partagent).
    const m = await manquesDeLAgent(deps, tenant, agentId);
    if (!m) return reply.code(404).send({ error: 'agent introuvable' });
    return reply.code(200).send({ manques: m.manques, avertissements: m.avertissements });
  });

  /**
   * Les modèles proposables, avec leur tarif. 🔴 Le prix affiché porte la commission de l'offre de l'espace,
   * et c'est aussi celui que le crédit paie (`prixClientMicroEur`) : la consommation de l'onglet voisin est au même
   * tarif. La clé du Gateway ne sort jamais d'ici : la console ne reçoit que des identifiants et des prix.
   */
  app.get('/tenants/:tenantId/agents/modeles', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const modeles = await deps.modelesProposes(tenant);
    return reply.code(200).send({ modeles });
  });

  app.patch('/tenants/:tenantId/agents/:agentId', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { agentId } = req.params as { agentId: string };
    // L'auteur vient de la session, jamais du corps : c'est lui que la ligne d'historique nomme.
    const r = await modifierAgent(deps, tenant, agentId, req.body, { userId: req.auth?.userId ?? null, origine: 'formulaire' });
    if (!r.ok) return reply.code(r.statut).send(corpsDuRefus(r));
    return reply.code(200).send({ agent: r.valeur });
  });

  app.delete('/tenants/:tenantId/agents/:agentId', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) return reply.code(404).send({ error: 'agent introuvable' });
    // Sans cette route, un agent créé avec un nom malheureux ne pouvait être ni renommé vers un nom occupé,
    // ni retiré : le workspace gardait une ligne morte pour toujours.
    const supprime = await deps.agents.remove(tenant, agentId);
    if (!supprime) return reply.code(404).send({ error: 'agent introuvable' });
    return reply.code(204).send();
  });
}
