import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Guard } from '../auth/middleware';
import type { AgentComplet, AgentResume, PatchAgent } from '../agent/agent-store';
import { FicheAgentPerimee, LabelAgentDejaPris } from '../agent/agent-store';
import { fichePatchSchema } from '../agent/fiche';
import { manquesAvantActivation, type EtatPourLint } from '../agent/setup/lint';
import { MODELES_CHOISIS, IDS_MODELES_CHOISIS, type ModeleProposable } from '../agent/modeles';
import { scopeTenant, nonEmpty, estUuid } from './scope';
import type { ConsommationAgent } from '../agent/session-store';

/** La fenetre du suivi de consommation. Trente jours : assez pour voir une tendance, assez court pour que
 *  l'index `(tenant_id, created_at desc)` serve la requete. */
const JOURS_CONSOMMATION = 30;

export interface AgentsRouteDeps {
  listActifs(tenantId: string): Promise<AgentResume[]>;
  listToutes(tenantId: string): Promise<AgentResume[]>;
  complet(tenantId: string, id: string): Promise<AgentComplet | null>;
  create(tenantId: string, label: string, mentionIa: string, modele: string): Promise<AgentComplet>;
  patch(tenantId: string, id: string, patch: PatchAgent): Promise<AgentComplet | null>;
  remove(tenantId: string, id: string): Promise<boolean>;
  /** Modèle par défaut d'un agent neuf. Vient de la configuration serveur, pas du client. */
  modeleParDefaut: string;
  /**
   * Le solde prépayé du workspace, en micro-euros. LECTURE SEULE ici, et c'est le point : un client voit ce
   * qu'il lui reste, il ne se recharge pas lui-même. Le rechargement vit sur `/ops`, sous une autorité
   * séparée. Absente -> l'écran n'affiche pas de solde.
   */
  soldeAgent?(tenantId: string): Promise<number>;
  /**
   * Ce que cet agent a consomme sur une fenetre. OPTIONNELLE : une console sans store de sessions rend
   * simplement `null`, et l'ecran n'affiche pas le bloc. Une mesure indisponible ne doit pas casser un
   * ecran de reglage.
   */
  consommationAgent?(tenantId: string, agentId: string, jours: number): Promise<ConsommationAgent>;
  /**
   * L'état à opposer au lint d'ACTIVATION. Absent, l'activation n'est pas contrôlée : c'est le montage des
   * tests de routes voisins, jamais la production.
   */
  etatPourLint?(tenantId: string, agentId: string): Promise<EtatPourLint | null>;
  /**
   * Les modèles proposables et leur tarif, pour la liste déroulante de l'onglet Modèle.
   *
   * OPTIONNELLE : absente, la route rend nos modèles SANS tarif plutôt qu'un 503. Le menu reste utilisable,
   * ce qui est le point : une tarification indisponible n'a pas à interdire un réglage.
   */
  modelesProposes?(): Promise<ModeleProposable[]>;
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
  // 🔴 `fichePatchSchema` et NON `ficheAgentSchema.partial()`. Le second remplit chaque champ absent par son
  // défaut (le `.default()` survit au `.partial()`), et la fusion jsonb n'aurait alors plus aucune clé
  // absente à protéger : enregistrer l'objectif effacerait le ton, les règles et toutes les sorties.
  contenu: fichePatchSchema.optional(),
  /** Version lue au chargement. Fournie -> l'écriture est refusée en 409 si la fiche a bougé entre-temps. */
  ficheVersionAttendue: z.number().int().min(1).optional(),
});
const creationSchema = z.object({ label: LABEL });

export function registerAgents(app: FastifyInstance, deps: AgentsRouteDeps, guard?: Guard): void {
  const opts = guard ? { preHandler: guard } : {};

  /**
   * Le solde prépayé du workspace. En LECTURE seulement : c'est ce qui reste à dépenser, et un client qui
   * pourrait s'en ajouter n'aurait plus de prépayé du tout.
   */
  app.get('/tenants/:tenantId/agents/solde', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (!deps.soldeAgent) return reply.code(200).send({ soldeMicroEur: null });
    return reply.code(200).send({ soldeMicroEur: await deps.soldeAgent(tenant) });
  });

  /**
   * Ce que l'agent a consomme, en tokens et en cout.
   *
   * 🔴 UNE MESURE, PAS UN PLAFOND. Julien, le 2026-09-08 : « ce qu'on veut, c'est un suivi du budget
   * consomme au total en tokens pour le robot, et pas mettre un budget ». Le plafond par conversation
   * existe toujours et protege toujours d'une boucle qui s'emballe ; il n'a simplement rien a faire dans
   * l'ecran ou l'on vient voir ce que l'agent a coute.
   */
  app.get('/tenants/:tenantId/agents/:agentId/consommation', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) return reply.code(404).send({ error: 'agent introuvable' });
    if (!deps.consommationAgent) return reply.code(200).send({ consommation: null });
    // La fenetre est fixee ICI et pas prise dans la requete : un parametre libre laisserait demander
    // « depuis toujours », qui relit toutes les sessions de l'espace pour un chiffre qui ne dit rien de
    // l'usage courant.
    return reply.code(200).send({ consommation: await deps.consommationAgent(tenant, agentId, JOURS_CONSOMMATION) });
  });

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

  /**
   * CE QUI MANQUE À CET AGENT, en lecture.
   *
   * 🔴 POURQUOI CETTE ROUTE EXISTE ALORS QUE LE LINT ÉTAIT DÉJÀ LÀ. Il ne parlait qu'à l'ACTIVATION, dans
   * le corps d'un 422. Un agent en BROUILLON qu'on essaie dans le bac à sable ne l'a donc jamais vu :
   * Julien, le 2026-09-08, a passé un moment à chercher pourquoi son agent ne trouvait rien, alors que la
   * réponse (« l'outil de recherche est inactif ») était déjà écrite dans le code, mais derrière un geste
   * qu'il n'avait pas fait.
   *
   * ⚠️ MÊME FONCTION que la garde d'activation (`manquesAvantActivation`), jamais une seconde liste : deux
   * inventaires de ce qui manque finiraient par ne pas dire la même chose, et le client croirait avoir fini
   * sur un écran et pas sur l'autre.
   */
  app.get('/tenants/:tenantId/agents/:agentId/manques', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { agentId } = req.params as { agentId: string };
    if (!estUuid(agentId)) return reply.code(404).send({ error: 'agent introuvable' });
    if (!deps.etatPourLint) return reply.code(503).send({ error: 'lint non configure' });
    const etat = await deps.etatPourLint(tenant, agentId);
    if (!etat) return reply.code(404).send({ error: 'agent introuvable' });
    return reply.code(200).send({ manques: manquesAvantActivation(etat) });
  });

  /**
   * LES MODÈLES PROPOSABLES, avec leur tarif (2026-09-09, demande de Julien).
   *
   * 🔴 LE PRIX AFFICHÉ N'EST PAS CELUI QUI EST DÉCOMPTÉ, et il faut le savoir en lisant les deux écrans.
   * Ce tarif porte la commission (`COMMISSION_MODELE_PCT`, 10 % par défaut) ; la consommation réelle de
   * l'onglet voisin est enregistrée au coût BRUT du Gateway. L'écart est voulu le temps que la facturation
   * Stripe existe (choix de Julien du 2026-09-09), et il est dit à l'écran plutôt que subi.
   *
   * ⚠️ La clé du Gateway ne sort JAMAIS d'ici : c'est le serveur qui lit le catalogue, la console ne reçoit
   * que des identifiants et des prix. Une liste construite côté navigateur aurait exigé la clé dans le bundle.
   */
  app.get('/tenants/:tenantId/agents/modeles', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    // Sans câblage, on rend quand même NOS modèles : le menu doit rester utilisable. Le tarif manquant est
    // une information que le front affiche, pas une panne.
    const modeles = deps.modelesProposes
      ? await deps.modelesProposes()
      : MODELES_CHOISIS.map((m) => ({ ...m, prixEntree: null, prixSortie: null }));
    return reply.code(200).send({ modeles });
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
    /**
     * 🔴 LE MODÈLE SE CHOISIT DANS UNE LISTE, IL NE SE TAPE PLUS (2026-09-09). Le champ était une saisie
     * libre bornée à 120 caractères : une faute de frappe passait l'enregistrement, et ne se voyait qu'au
     * premier message d'un client, quand le Gateway rendait un 404 sur un modèle inconnu.
     *
     * Contrôlé contre la liste STATIQUE, jamais contre le catalogue en ligne : une panne du Gateway
     * interdirait sinon d'enregistrer un modèle parfaitement valide. Le défaut du serveur est accepté même
     * s'il n'est pas dans la liste, sinon changer `AGENT_MODEL` rendrait l'onglet inutilisable.
     *
     * ⚠️ N'affecte QUE les écritures : un agent qui porte déjà un modèle hors liste continue de tourner
     * avec, et rien ne le réécrit dans son dos.
     */
    if (champs.modele !== undefined && !IDS_MODELES_CHOISIS.has(champs.modele) && champs.modele !== deps.modeleParDefaut) {
      return reply.code(400).send({ error: `modèle inconnu : ${champs.modele}. Choisissez-en un dans la liste proposée.` });
    }
    // 🔴 Le blocage dur du cadrage : on ne rend pas un agent proposable dans un scénario tant qu'il lui
    // manque de quoi tenir sa promesse. Sur des CHAMPS VIDES, jamais sur une qualité sémantique, et sur
    // l'ACTIVATION seulement : un brouillon se remplit dans n'importe quel ordre, et la conversation de
    // construction procède justement par petites touches.
    if (parse.data.status === 'active' && deps.etatPourLint) {
      const etat = await deps.etatPourLint(tenant, agentId);
      if (!etat) return reply.code(404).send({ error: 'agent introuvable' });
      // 🔴 SUR L'ÉTAT EFFECTIF APRÈS ÉCRITURE, jamais sur celui qu'on vient de lire. Le corps peut porter
      // `contenu` ET `status: 'active'` dans la MÊME requête, et le store applique les deux d'un coup :
      // linter l'état d'avant laisserait vider l'objectif et activer dans le même geste, c'est-à-dire
      // contourner la garde en une requête. C'est la règle du CLAUDE.md (« une garde de validation se
      // calcule sur l'état effectif, `patch ?? courant` »), et elle vaut aussi quand le patch est un jsonb.
      // La fusion rejouée ici est la même que celle du SQL : superficielle, clé par clé.
      const manques = manquesAvantActivation({ ...etat, fiche: { ...etat.fiche, ...(parse.data.contenu ?? {}) } });
      // 422 et non 500 : c'est une chose que le client doit lire et corriger, pas un incident.
      if (manques.length > 0) return reply.code(422).send({ error: 'agent incomplet', manques });
    }
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
