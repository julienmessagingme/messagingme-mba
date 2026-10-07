import { request } from './http';
import { lireMessagesTenus, type MessagesTenus } from './chiffres-canaux';
import { lireEtatRepondeur, lireRepondeurAgentId, type EtatRepondeur } from './repondeur';

/** Une règle d'arrêt déclarée sur la fiche d'un agent. Son `code` devient le handle `sortie:<code>` du bloc. */
export interface SortieAgent {
  code: string;
  label: string;
}

export type StatutAgent = 'draft' | 'active' | 'disabled';

/** Un agent, tel que la palette du builder et la liste de l'écran de réglage le voient. */
export interface AgentResume {
  id: string;
  label: string;
  status: StatutAgent;
  sorties: SortieAgent[];
  /** Le modèle, pour le logo du fournisseur dans la liste. Miroir manuel du type serveur : la frontière de
   *  build interdit au front d'importer `src/`. */
  modele: string;
}

/** La partie de la fiche que le client décrit, et que l'IA de construction remplira un jour. */
export interface FicheContenu {
  nom: string;
  objectif: string;
  ton: string;
  personnalite: string;
  reglesTransfert: string;
  sorties: SortieAgent[];
}

/** La fiche ENTIÈRE, telle que l'écran de réglage l'édite. */
export interface AgentComplet {
  id: string;
  label: string;
  status: StatutAgent;
  mentionIa: string;
  /**
   * ⚠️ PLUS DE `mentionIaFrequence` ICI DEPUIS LA MIGRATION 0140 : QUAND la phrase est dite est une
   * politique de l'ESPACE, réglée dans Sécurité > IA, parce que l'obligation d'information pèse sur la
   * marque déployante et pas sur chaque robot. La PHRASE, elle, reste propre à l'agent : c'est sa voix.
   */
  modele: string;
  maxTours: number;
  maxAppelsOutils: number;
  budgetMicroEur: number;
  inactiviteMinutes: number;
  contactInconnu: 'aucun_outil' | 'lecture_seule' | 'tous';
  contenu: FicheContenu;
  /** Compteur d'écritures de la fiche, renvoyé tel quel dans un patch de fiche : c'est le verrou qui empêche
   *  deux surfaces d'écraser la même clé en silence. */
  ficheVersion: number;
}

/** Un patch : tout est optionnel, et `contenu` est une FUSION (seules les clés présentes sont écrites).
 *  `ficheVersionAttendue` accompagne un patch de fiche et le fait refuser en 409 si elle a bougé. */
export type PatchAgent = Partial<Omit<AgentComplet, 'id' | 'contenu' | 'ficheVersion'>> & {
  contenu?: Partial<FicheContenu>;
  ficheVersionAttendue?: number;
};

/**
 * Les agents du workspace. Par défaut les ACTIFS seulement, ce dont la palette du builder a besoin : un
 * brouillon proposé dans un scénario promettrait une conversation qui n'aurait pas lieu.
 *
 * 🔴 `modele` EST REPLIÉ SUR LA CHAÎNE VIDE, et ce n'est pas une coquetterie. Il est NEUF dans la projection
 * du serveur (2026-09-23) : pendant la fenêtre où Vercel a publié la console au `git push` et où l'API
 * attend son `up`, la production rend des lignes SANS lui. Le type dit `string`, la réponse vient du réseau
 * et n'est pas validée, donc `logoDuModele(undefined)` appellerait `.indexOf` sur `undefined` et ferait
 * tomber la LISTE ENTIÈRE des agents, pas seulement son icône. `logoDuModele('')` rend `null` (c'est tenu
 * par `tests/web-logos-llm.test.ts`), donc la ligne retombe sur son repli sans rien casser.
 */
export async function listAgents(tenantId: string, opts: { tous?: boolean } = {}): Promise<AgentResume[]> {
  return (await listAgentsEtRepondeur(tenantId, opts)).agents;
}

/**
 * La liste ET le répondeur de l'espace (lot 5), rendus par la même route : l'écran des agents dit lequel répond à tous
 * les messages que personne ne tient. `repondeurAgentId` à `undefined` = une API qui ne le rend pas : on ne sait pas,
 * et l'écran n'affiche pas le choix plutôt que d'annoncer « Aucun ».
 */
export async function listAgentsEtRepondeur(
  tenantId: string, opts: { tous?: boolean } = {},
): Promise<{ agents: AgentResume[]; repondeurAgentId: string | null | undefined }> {
  const q = opts.tous ? '?statut=tous' : '';
  const r = await request<{ agents?: AgentResume[]; repondeurAgentId?: unknown }>(`/tenants/${tenantId}/agents${q}`);
  return {
    agents: (r.agents ?? []).map((a) => ({ ...a, modele: a.modele ?? '' })),
    repondeurAgentId: lireRepondeurAgentId(r.repondeurAgentId),
  };
}

/**
 * « Qui répond au client » (RC6, `GET /tenants/:tenantId/repondeur`) : ce que la carte de l'Accueil lit en un appel.
 * `null` = illisible, ou une API d'avant RC6 (404) : la carte ne s'affiche pas plutôt que d'annoncer un réglage
 * qu'elle n'a pas lu.
 */
export async function lireQuiRepond(tenantId: string): Promise<EtatRepondeur | null> {
  return lireEtatRepondeur(await request<unknown>(`/tenants/${tenantId}/repondeur`));
}

/** Le choix de la carte, tel que `PUT /tenants/:tenantId/repondeur` l'attend (le délai en heures, comme à l'écran). */
export type ChoixQuiRepond =
  | { mode: 'mba' } | { mode: 'equipe' }
  | { mode: 'agent'; agentId: string }
  | { mode: 'scenario'; workflowId: string; delaiHeures: number };

/**
 * Règle qui répond au client. Le serveur vérifie tout (agent actif, scénario publié, agent de Meta configurable) et
 * refuse lisiblement ; quitter le mode « MBA » retire ses contacts de sa liste, ce que la carte fait confirmer avant.
 * La carte relit l'état ensuite plutôt que de le supposer.
 */
export async function reglerQuiRepond(tenantId: string, choix: ChoixQuiRepond): Promise<void> {
  await request<unknown>(`/tenants/${tenantId}/repondeur`, { method: 'PUT', body: JSON.stringify(choix) });
}

/**
 * Le solde prépayé du workspace, en micro-euros. `null` = aucun solde configuré sur cette instance.
 *
 * 🔴 LECTURE SEULE, et c'est le sujet. Un client ne s'écrit pas de crédit : il paie (Stripe, dont le webhook
 * signé crédite, `lib/api-credit.ts`), ou l'exploitation le recharge. Un client qui pourrait se créditer
 * lui-même n'aurait plus de prépayé du tout.
 */
export async function getSoldeAgent(tenantId: string): Promise<number | null> {
  const r = await request<{ soldeMicroEur: number | null }>(`/tenants/${tenantId}/agents/solde`);
  return r.soldeMicroEur;
}

export async function getAgent(tenantId: string, agentId: string): Promise<AgentComplet> {
  return (await request<{ agent: AgentComplet }>(`/tenants/${tenantId}/agents/${agentId}`)).agent;
}

export async function createAgent(tenantId: string, label: string): Promise<AgentComplet> {
  const r = await request<{ agent: AgentComplet }>(`/tenants/${tenantId}/agents`, {
    method: 'POST',
    body: JSON.stringify({ label }),
  });
  return r.agent;
}

export async function deleteAgent(tenantId: string, agentId: string): Promise<void> {
  await request<void>(`/tenants/${tenantId}/agents/${agentId}`, { method: 'DELETE' });
}

export async function patchAgent(tenantId: string, agentId: string, patch: PatchAgent): Promise<AgentComplet> {
  const r = await request<{ agent: AgentComplet }>(`/tenants/${tenantId}/agents/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return r.agent;
}

/**
 * Ce que l'agent a CONSOMMÉ, sur une fenêtre décidée par le serveur.
 *
 * 🔴 UNE MESURE, PAS UN PLAFOND. Le plafond par conversation existe toujours et protège toujours d'une
 * boucle qui s'emballe ; il n'a rien à faire dans l'écran où l'on vient voir ce que l'agent a coûté.
 *
 * `null` = la console n'a pas de store de sessions : on n'affiche alors RIEN, plutôt qu'un zéro qui se
 * lirait « cet agent n'a rien consommé ».
 */
export interface ConsommationAgent {
  sessions: number;
  tokensEntree: number;
  tokensSortie: number;
  coutMicroEur: number;
  jours: number;
}

export async function consommationAgent(tenantId: string, agentId: string): Promise<ConsommationAgent | null> {
  const r = await request<{ consommation: ConsommationAgent | null }>(
    `/tenants/${tenantId}/agents/${agentId}/consommation`,
  );
  return r.consommation ?? null;
}

/**
 * Combien de messages ont été échangés dans les conversations que cet agent a tenues, sur 30 jours (la
 * fenêtre est décidée par le serveur, la même que celle de la consommation juste au-dessus).
 *
 * 🔴 `null` = ON NE SAIT PAS, jamais zéro. Trois cas réels le produisent : la route n'est pas encore
 * déployée (Vercel publie l'écran au `git push`, l'API attend son `up`), le compte n'est pas administrateur
 * (le module est monté en `g.admin`, donc un manager reçoit 403), et le serveur lui-même rend `null` quand
 * sa dépendance de comptage n'est pas câblée. Un zéro affirmerait que l'agent n'a parlé à personne.
 *
 * ⚠️ LE COMPTE EMBRASSE TOUT LE FIL, y compris les envois de campagne et ce que l'équipe a écrit après
 * avoir repris la main : c'est le volume de la conversation, pas le travail de l'agent. `EnteteAgent` le
 * DIT à l'écran, et ce n'est pas facultatif (sans quoi le chiffre se lit comme une note de performance).
 * ⚠️ Et ce n'est PAS le périmètre du « messages échangés » de l'Accueil et du Performance Lab, qui eux
 * écartent les modèles sortants. Le même mot, deux mesures : seule la légende peut lever l'ambiguïté.
 *
 * 🔴 `jours`, RENDU par la route, EST REMONTÉ avec le chiffre (relecture du 2026-09-25) : la légende de l'en-tête
 * le cite (`ChiffreMessagesTenus`) au lieu d'écrire « 30 jours » en dur. Changer la fenêtre du serveur change
 * donc la légende avec lui, au lieu de la faire mentir. Même lecture que l'agent de Meta : `lireMessagesTenus`.
 */
export async function messagesAgent(tenantId: string, agentId: string): Promise<MessagesTenus | null> {
  return lireMessagesTenus(await request<unknown>(`/tenants/${tenantId}/agents/${agentId}/messages`));
}

/**
 * Un modèle proposable. Les prix sont en EUROS PAR MILLION de jetons, commission comprise. `null` = le
 * fournisseur ne l'annonce pas, ou le catalogue était injoignable : l'écran le DIT, il n'invente pas 0.
 *
 * ⚠️ MIROIR À LA MAIN de `ModeleProposable` (`src/agent/modeles.ts`) : la frontière de build interdit au
 * front d'importer `src/`. Même convention que `ConsommationAgent` juste au-dessus. Renommer un champ d'un
 * seul côté ne casse aucun compilateur, ça vide simplement la valeur à l'écran : les deux se relisent
 * ensemble, comme pour les autres contrats de cette frontière.
 */
export interface ModeleProposable {
  id: string;
  nom: string;
  prixEntree: number | null;
  prixSortie: number | null;
}

/**
 * Les modèles proposés pour un agent, avec leur tarif. Triés par prix d'entrée croissant côté serveur.
 *
 * ⚠️ Une lecture en échec rend une liste VIDE, jamais une exception : l'onglet Modèle retombe alors sur
 * l'affichage du modèle courant en lecture seule, plutôt que de faire tomber la fiche entière.
 */
export async function listerModeles(tenantId: string): Promise<ModeleProposable[]> {
  const r = await request<{ modeles?: ModeleProposable[] }>(`/tenants/${tenantId}/agents/modeles`);
  return Array.isArray(r.modeles) ? r.modeles : [];
}
