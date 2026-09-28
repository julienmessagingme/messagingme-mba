import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import type { AgentComplet, AgentResume, PatchAgent } from '../agent/agent-store';
import { FicheAgentPerimee, LabelAgentDejaPris } from '../agent/agent-store';
import { fichePatchSchema } from '../agent/fiche';
import { avertissements, manquesAvantActivation, type EtatPourLint } from '../agent/setup/lint';
import { CreditInsuffisantPourCle, PLAFOND_GATEWAY_MIN_DOLLARS } from '../agent/provisionner-cle';
import { IDS_MODELES_CHOISIS, type ModeleProposable } from '../agent/modeles';
import { espaceVerifie, nonEmpty, estUuid } from './scope';
import { journaliser } from '../lib/journal';
import type { ConsommationAgent } from '../agent/session-store';

/**
 * La fenêtre du suivi de consommation : trente jours, assez pour voir une tendance, assez court pour que
 * l'index `(tenant_id, created_at desc)` serve la requête.
 */
export const JOURS_CONSOMMATION = 30;

/** Ce que les routes lisent et écrivent des fiches d'agent. */
export interface AgentsDep {
  listActifs(tenantId: string): Promise<AgentResume[]>;
  listToutes(tenantId: string): Promise<AgentResume[]>;
  complet(tenantId: string, id: string): Promise<AgentComplet | null>;
  create(tenantId: string, label: string, mentionIa: string, modele: string): Promise<AgentComplet>;
  patch(tenantId: string, id: string, patch: PatchAgent): Promise<AgentComplet | null>;
  remove(tenantId: string, id: string): Promise<boolean>;
}

export interface AgentsRouteDeps {
  agents: AgentsDep;
  /** Modèle par défaut d'un agent neuf. Vient de la configuration serveur, pas du client. */
  modeleParDefaut: string;
  credits: {
    /**
     * Le solde prépayé de l'espace, en micro-euros. 🔴 Lecture seule : un client voit ce qu'il lui reste, il ne
     * se recharge pas lui-même (le rechargement vit sur `/ops`, sous une autorité séparée).
     */
    solde(tenantId: string): Promise<number>;
  };
  sessions: {
    /** Ce que cet agent a consommé sur une fenêtre. */
    consommation(tenantId: string, agentId: string, jours: number): Promise<ConsommationAgent>;
    /** Les messages échangés dans les conversations que cet agent a tenues, sur une fenêtre de N jours. */
    messagesTenus(tenantId: string, agentId: string, jours: number): Promise<number>;
  };
  /**
   * L'état à opposer au lint d'activation. Requis : un montage sans lui laisserait activer sans contrôle.
   */
  etatPourLint(tenantId: string, agentId: string): Promise<EtatPourLint | null>;
  /**
   * Les modèles proposables et leur tarif, pour la liste de l'onglet Modèle. Le câblage rend nos modèles sans
   * tarif quand la tarification est indisponible : son absence n'interdit pas un réglage.
   */
  modelesProposes(): Promise<ModeleProposable[]>;
  /**
   * S'assurer que l'espace a sa clé AI Gateway, en la créant chez Vercel s'il n'en a pas. Absente =
   * provisionnement éteint. Câblée, elle est impérative et appelée avant `create` : son échec refuse la création.
   */
  assurerCleModele?(tenantId: string): Promise<unknown>;
}

/**
 * Les agents IA d'un espace, réservés aux administrateurs (comme le builder qu'ils servent).
 * La colonne `fiche` (jsonb) porte ce qui décrit l'agent et passe par `ficheAgentSchema.safeParse`. Les
 * plafonds, le modèle, la mention légale et le statut vivent en colonnes, bornés ici : une saisie ne relève pas
 * un plafond de dépense au-delà de ce que la base accepte, et n'efface pas la phrase qui annonce une IA (AI Act,
 * article 50).
 */

/** Mention d'IA par défaut. Obligatoire en base (`not null`), donc il en faut une dès la création : la laisser
 *  vide reviendrait à créer un agent hors-la-loi que personne ne penserait à compléter. */
const MENTION_IA_DEFAUT = 'Vous échangez avec un assistant automatique.';

/**
 * Bornes des champs. Cinq rejouent un `check` en base (`max_tours`, `max_appels_outils`, `inactivite_minutes`,
 * `contact_inconnu`, `status`) pour rendre un 400 lisible au lieu d'un 500 ; `tests/agents-bornes-parity.test.ts`
 * tient la parité. Les autres (`label`, `mentionIa`, `modele`, la borne haute du budget) n'ont aucun équivalent
 * en base : ici, elles sont le seul garde-fou.
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
  // 🔴 `fichePatchSchema` et non `ficheAgentSchema.partial()` : le `.default()` survit au `.partial()`, et la
  // fusion jsonb écraserait alors toute la fiche (ton, règles, sorties) en n'enregistrant que l'objectif.
  contenu: fichePatchSchema.optional(),
  /** Version lue au chargement. Fournie -> l'écriture est refusée en 409 si la fiche a bougé entre-temps. */
  ficheVersionAttendue: z.number().int().min(1).optional(),
});
const creationSchema = z.object({ label: LABEL });

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
    const agents = tous ? await deps.agents.listToutes(tenant) : await deps.agents.listActifs(tenant);
    return reply.code(200).send({ agents });
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
    const parse = creationSchema.safeParse(req.body ?? {});
    // Même règle qu'au PATCH : un label trop long est refusé, pas tronqué en silence. Deux comportements
    // différents pour le même champ selon la route feraient croire à un bug d'affichage.
    if (!parse.success) return reply.code(400).send({ error: 'label requis, 120 caractères au plus' });
    // Un agent sans modèle serait activable et muet au premier tour. La configuration serveur est la seule
    // source ici : le corps ne peut pas en imposer un.
    if (!nonEmpty(deps.modeleParDefaut)) {
      return reply.code(422).send({ error: 'aucun modèle par défaut configuré côté serveur' });
    }
    // 🔴 La clé du modèle avant l'agent, et son échec refuse : le bac à sable appelle vraiment le modèle, et un
    // agent né sans clé propre se mettrait au point sur notre argent, sans que la dépense soit attribuée à personne.
    if (deps.assurerCleModele) {
      try {
        await deps.assurerCleModele(tenant);
      } catch (err) {
        // 422, jamais 5xx (Cloudflare en remplacerait le corps). Journalisé côté serveur en plus : ce 422 est la
        // seule trace côté client.
        journaliser('error', 'cle_modele_non_provisionnee', { err, tenantId: tenant });
        if (err instanceof CreditInsuffisantPourCle) {
          return reply.code(422).send({
            error: `crédit insuffisant pour créer un agent : il en faut au moins l'équivalent de ${PLAFOND_GATEWAY_MIN_DOLLARS} $. Rechargez le crédit des agents IA, puis réessayez.`,
          });
        }
        return reply.code(422).send({ error: 'la clé de modèle de cet espace n’a pas pu être créée. Réessayez dans un instant.' });
      }
    }
    try {
      // Créé en brouillon par le store, jamais actif : le corps ne peut pas en décider.
      const agent = await deps.agents.create(tenant, parse.data.label, MENTION_IA_DEFAUT, deps.modeleParDefaut);
      return reply.code(201).send({ agent });
    } catch (err) {
      if (err instanceof LabelAgentDejaPris) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  /**
   * Ce qui manque à cet agent, en lecture : le lint ne parlait qu'à l'activation, et un agent en brouillon essayé
   * au bac à sable ne le voyait jamais. Même fonction que la garde d'activation (`manquesAvantActivation`), jamais
   * une seconde liste.
   */
  app.get('/tenants/:tenantId/agents/:agentId/manques', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) return reply.code(404).send({ error: 'agent introuvable' });
    const etat = await deps.etatPourLint(tenant, agentId);
    if (!etat) return reply.code(404).send({ error: 'agent introuvable' });
    // Deux listes, un seul bandeau : les manques bloquent l'activation, les avertissements non (les fondre
    // donnerait à un serveur tiers un droit de veto sur l'activation d'un agent).
    return reply.code(200).send({ manques: manquesAvantActivation(etat), avertissements: avertissements(etat) });
  });

  /**
   * Les modèles proposables, avec leur tarif. 🔴 Le prix affiché porte la commission (`COMMISSION_MODELE_PCT`),
   * et c'est aussi celui que le crédit paie (`prixClientMicroEur`) : la consommation de l'onglet voisin est au même
   * tarif. La clé du Gateway ne sort jamais d'ici : la console ne reçoit que des identifiants et des prix.
   */
  app.get('/tenants/:tenantId/agents/modeles', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const modeles = await deps.modelesProposes();
    return reply.code(200).send({ modeles });
  });

  app.patch('/tenants/:tenantId/agents/:agentId', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) return reply.code(404).send({ error: 'agent introuvable' });
    /**
     * Un champ qui a déménagé se refuse, il ne s'avale pas : `z.object()` retire les clés inconnues en silence, et
     * un onglet resté ouvert sur l'ancienne console perdrait le choix du client en recevant 200. Le message dit où
     * le réglage est parti.
     */
    if ((req.body as Record<string, unknown> | null)?.mentionIaFrequence !== undefined) {
      return reply.code(400).send({
        error: 'le régime d’annonce d’IA est désormais un réglage de l’espace : PATCH /tenants/:tenantId/settings/mention-ia (écran Sécurité > IA)',
      });
    }
    const parse = patchSchema.safeParse(req.body ?? {});
    if (!parse.success) {
      const detail = parse.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');
      // 4xx et non 5xx : Cloudflare remplacerait le corps, et le client ne saurait pas quel champ corriger.
      return reply.code(400).send({ error: `champs invalides : ${detail}` });
    }
    // Une version seule ne modifie rien : elle accompagne un patch, elle n'en est pas un.
    const { ficheVersionAttendue: _v, ...champs } = parse.data;
    if (Object.keys(champs).length === 0) return reply.code(400).send({ error: 'aucun champ à modifier' });
    /**
     * Le modèle se choisit dans une liste, contrôlé contre la liste statique (jamais le catalogue en ligne, dont une
     * panne interdirait d'enregistrer) ; le défaut du serveur est accepté même hors liste. N'affecte que les
     * écritures : un agent qui porte déjà un modèle hors liste continue de tourner avec.
     */
    if (champs.modele !== undefined && !IDS_MODELES_CHOISIS.has(champs.modele) && champs.modele !== deps.modeleParDefaut) {
      return reply.code(400).send({ error: `modèle inconnu : ${champs.modele}. Choisissez-en un dans la liste proposée.` });
    }
    // Blocage dur : un agent n'est proposable dans un scénario que s'il a de quoi tenir sa promesse. Sur des
    // champs vides, jamais sur une qualité sémantique, et à l'activation seulement : un brouillon se remplit dans
    // le désordre.
    if (parse.data.status === 'active') {
      const etat = await deps.etatPourLint(tenant, agentId);
      if (!etat) return reply.code(404).send({ error: 'agent introuvable' });
      // Sur l'état effectif après écriture, jamais sur celui qu'on vient de lire : le corps peut porter `contenu` et
      // `status: 'active'` ensemble, et linter l'état d'avant laisserait vider l'objectif et activer d'un geste. La
      // fusion rejouée ici est celle du SQL : superficielle, clé par clé.
      const manques = manquesAvantActivation({ ...etat, fiche: { ...etat.fiche, ...(parse.data.contenu ?? {}) } });
      // 422 et non 500 : c'est une chose que le client doit lire et corriger, pas un incident.
      if (manques.length > 0) return reply.code(422).send({ error: 'agent incomplet', manques });
    }
    try {
      const agent = await deps.agents.patch(tenant, agentId, parse.data);
      if (!agent) return reply.code(404).send({ error: 'agent introuvable' });
      return reply.code(200).send({ agent });
    } catch (err) {
      if (err instanceof FicheAgentPerimee) return reply.code(409).send({ error: err.message });
      if (err instanceof LabelAgentDejaPris) return reply.code(409).send({ error: err.message });
      throw err;
    }
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
