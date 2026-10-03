import { z } from 'zod';
import type { AgentComplet, PatchAgent, StatutAgent } from './agent-store';
import { FicheAgentPerimee, LabelAgentDejaPris } from './agent-store';
import { fichePatchSchema, type FicheAgentContenu } from './fiche';
import { manquesAvantActivation, type EtatPourLint } from './setup/lint';
import { CreditInsuffisantPourCle, PLAFOND_GATEWAY_MIN_DOLLARS } from './provisionner-cle';
import { IDS_MODELES_CHOISIS } from './modeles';
import { estUuid, nonEmpty } from '../http/scope';
import { journaliser } from '../lib/journal';
import { refus, type Issue, type Refus } from '../lib/issue';
import type { HistoriqueStore, Origine } from '../reglages/historique';

/**
 * LA GESTION D'UN AGENT IA : le créer, le modifier, l'activer (lot 8a, `docs/superpowers/plans/2026-10-03-mcp-agent-ia.md`).
 *
 * 🔴 UNE SEULE VÉRITÉ, DEUX PORTES, comme les widgets (`src/widgets/gestion.ts`). La route de la console
 * (`src/http/agents.ts`) et les outils MCP de l'agent appellent CES fonctions : un agent modifié par Claude Code passe
 * exactement les contrôles d'un agent modifié à la main. La route n'ajoute que la garde d'administrateur et la
 * traduction des refus en statuts.
 *
 * La fiche (`contenu`, jsonb) et les colonnes (plafonds, modèle, mention légale, statut) sont bornées ici : une saisie
 * ne relève pas un plafond de dépense au-delà de ce que la base accepte, et n'efface pas la phrase qui annonce une IA
 * (AI Act, article 50).
 */

export const AGENT_INTROUVABLE = 'agent introuvable';

/** Mention d'IA par défaut. Obligatoire en base (`not null`), donc il en faut une dès la création : la laisser
 *  vide reviendrait à créer un agent hors-la-loi que personne ne penserait à compléter. */
const MENTION_IA_DEFAUT = 'Vous échangez avec un assistant automatique.';

/**
 * Bornes des champs. Cinq rejouent un `check` en base (`max_tours`, `max_appels_outils`, `inactivite_minutes`,
 * `contact_inconnu`, `status`) pour rendre un 400 lisible au lieu d'un 500 ; `tests/agents-bornes-parity.test.ts`
 * tient la parité. Les autres (`label`, `mentionIa`, `modele`, la borne haute du budget) n'ont aucun équivalent
 * en base : ici, elles sont le seul garde-fou.
 *
 * Exportés pour UNE raison : les outils MCP annoncent chaque borne qu'ils appliquent, et la lisent ici.
 */
const LABEL = z.string().trim().min(1).max(120);
export const saisieDeModification = z.object({
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
export const saisieDeCreation = z.object({ label: LABEL });

/** Ce que la gestion lit et écrit d'un agent. Le câblage passe les MÊMES objets à la console et au MCP. */
export interface DepsGestionAgents {
  agents: {
    complet(tenantId: string, id: string): Promise<AgentComplet | null>;
    create(tenantId: string, label: string, mentionIa: string, modele: string): Promise<AgentComplet>;
    patch(tenantId: string, id: string, patch: PatchAgent): Promise<AgentComplet | null>;
  };
  /** Modèle par défaut d'un agent neuf. Vient de la configuration serveur, pas du client. */
  modeleParDefaut: string;
  /**
   * L'état à opposer au lint d'activation. Requis : un montage sans lui laisserait activer sans contrôle.
   */
  etatPourLint(tenantId: string, agentId: string): Promise<EtatPourLint | null>;
  /**
   * S'assurer que l'espace a sa clé AI Gateway, en la créant chez Vercel s'il n'en a pas. Absente =
   * provisionnement éteint. Câblée, elle est impérative et appelée avant `create` : son échec refuse la création.
   */
  assurerCleModele?(tenantId: string): Promise<unknown>;
  /**
   * L'historique des réglages (`PgHistoriqueStore`), où chaque modification de la fiche laisse sa ligne
   * `fiche_agent`. Requis : un câblage qui l'oublierait ne compile pas, au lieu de ne rien journaliser en silence.
   */
  historique: Pick<HistoriqueStore, 'ecrire'>;
}

/**
 * Qui modifie, et par quelle porte. `userId` vient du jeton (la session de la console, la personne d'un jeton OAuth),
 * jamais du corps. `null` = personne à nommer ; la ligne d'historique porte alors « auteur inconnu ».
 */
export interface AuteurModification {
  userId: string | null;
  origine: Exclude<Origine, 'assistant'>;
}

const CREDIT_INSUFFISANT =
  `crédit insuffisant pour créer un agent : il en faut au moins l'équivalent de ${PLAFOND_GATEWAY_MIN_DOLLARS} $. Rechargez le crédit des agents IA, puis réessayez.`;
const AGENT_ACTIF_INCOMPLET =
  'agent actif : cette modification le rendrait incomplet. Complétez-la, ou désactivez l’agent avant de le remanier.';

export async function creerAgent(deps: DepsGestionAgents, tenantId: string, corps: unknown): Promise<Issue<AgentComplet>> {
  const lu = saisieDeCreation.safeParse(corps ?? {});
  // Même règle qu'à la modification : un label trop long est refusé, pas tronqué en silence. Deux comportements
  // différents pour le même champ selon la porte feraient croire à un bug d'affichage.
  if (!lu.success) return refus(400, 'label requis, 120 caractères au plus');
  // Un agent sans modèle serait activable et muet au premier tour. La configuration serveur est la seule
  // source ici : le corps ne peut pas en imposer un.
  if (!nonEmpty(deps.modeleParDefaut)) return refus(422, 'aucun modèle par défaut configuré côté serveur');
  // 🔴 La clé du modèle avant l'agent, et son échec refuse : le bac à sable appelle vraiment le modèle, et un
  // agent né sans clé propre se mettrait au point sur notre argent, sans que la dépense soit attribuée à personne.
  if (deps.assurerCleModele) {
    try {
      await deps.assurerCleModele(tenantId);
    } catch (err) {
      // 422, jamais 5xx (Cloudflare en remplacerait le corps). Journalisé côté serveur en plus : ce refus est la
      // seule trace côté client.
      journaliser('error', 'cle_modele_non_provisionnee', { err, tenantId });
      if (err instanceof CreditInsuffisantPourCle) return refus(422, CREDIT_INSUFFISANT);
      return refus(422, 'la clé de modèle de cet espace n’a pas pu être créée. Réessayez dans un instant.');
    }
  }
  try {
    // Créé en brouillon par le store, jamais actif : le corps ne peut pas en décider.
    return { ok: true, valeur: await deps.agents.create(tenantId, lu.data.label, MENTION_IA_DEFAUT, deps.modeleParDefaut) };
  } catch (err) {
    if (err instanceof LabelAgentDejaPris) return refus(409, err.message);
    throw err;
  }
}

/**
 * Une modification PARTIELLE : un champ absent garde sa valeur. Deux contrôles au-delà des bornes :
 *  - le contrôle de complétude (`manquesAvantActivation`), sur l'état EFFECTIF après écriture (voir `completudeRefusee`) ;
 *  - une ligne `fiche_agent` dans l'historique des réglages, avec l'auteur et la porte.
 */
export async function modifierAgent(
  deps: DepsGestionAgents, tenantId: string, agentId: string, corps: unknown, auteur: AuteurModification,
): Promise<Issue<AgentComplet>> {
  // Identifiant mal formé : 404, sinon Postgres lèverait sur la colonne `uuid` (donc un 500).
  if (!estUuid(agentId)) return refus(404, AGENT_INTROUVABLE);
  /**
   * Un champ qui a déménagé se refuse, il ne s'avale pas : `z.object()` retire les clés inconnues en silence, et
   * un onglet resté ouvert sur l'ancienne console perdrait le choix du client en recevant 200. Le message dit où
   * le réglage est parti.
   */
  if ((corps as Record<string, unknown> | null)?.mentionIaFrequence !== undefined) {
    return refus(400, 'le régime d’annonce d’IA est désormais un réglage de l’espace : PATCH /tenants/:tenantId/settings/mention-ia (écran Sécurité > IA)');
  }
  const lu = saisieDeModification.safeParse(corps ?? {});
  if (!lu.success) {
    const detail = lu.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');
    // 4xx et non 5xx : Cloudflare remplacerait le corps, et le client ne saurait pas quel champ corriger.
    return refus(400, `champs invalides : ${detail}`);
  }
  const patch: PatchAgent = lu.data;
  // Une version seule ne modifie rien : elle accompagne un patch, elle n'en est pas un.
  const { ficheVersionAttendue: _v, ...champs } = patch;
  if (Object.keys(champs).length === 0) return refus(400, 'aucun champ à modifier');
  /**
   * Le modèle se choisit dans une liste, contrôlé contre la liste statique (jamais le catalogue en ligne, dont une
   * panne interdirait d'enregistrer) ; le défaut du serveur est accepté même hors liste. N'affecte que les
   * écritures : un agent qui porte déjà un modèle hors liste continue de tourner avec.
   */
  if (champs.modele !== undefined && !IDS_MODELES_CHOISIS.has(champs.modele) && champs.modele !== deps.modeleParDefaut) {
    return refus(400, `modèle inconnu : ${champs.modele}. Choisissez-en un dans la liste proposée.`);
  }
  // L'état d'avant : il dit si l'agent est actif, et il est l'« avant » de la ligne d'historique. `null` ne refuse
  // rien ici : l'écriture le dira (404, ou 409 si c'est le verrou qui a mordu).
  const courant = await deps.agents.complet(tenantId, agentId);
  const incomplet = await completudeRefusee(deps, tenantId, agentId, courant, patch);
  if (incomplet) return incomplet;
  let agent: AgentComplet | null;
  try {
    agent = await deps.agents.patch(tenantId, agentId, patch);
  } catch (err) {
    if (err instanceof FicheAgentPerimee) return refus(409, err.message);
    if (err instanceof LabelAgentDejaPris) return refus(409, err.message);
    throw err;
  }
  if (!agent) return refus(404, AGENT_INTROUVABLE);
  await journaliserFiche(deps, tenantId, courant, agent, patch, auteur);
  return { ok: true, valeur: agent };
}

/** Activer ou désactiver : une modification du seul statut, donc les mêmes contrôles et la même ligne d'historique. */
export function changerStatut(
  deps: DepsGestionAgents, tenantId: string, agentId: string, statut: StatutAgent, auteur: AuteurModification,
): Promise<Issue<AgentComplet>> {
  return modifierAgent(deps, tenantId, agentId, { status: statut }, auteur);
}

/**
 * Le blocage dur : un agent n'est proposable dans un scénario que s'il a de quoi tenir sa promesse. Sur des champs
 * vides, jamais sur une qualité sémantique. Deux cas, et le second est né avec le lot 8a :
 *  - ACTIVER (`status: 'active'` dans le corps) : tous les manques de l'état effectif bloquent ;
 *  - MODIFIER LA FICHE d'un agent qui RESTE actif : seuls les manques que la modification INTRODUIT bloquent. Vider
 *    l'objectif d'un agent actif passait sans rien dire, et partait en production aussitôt (il n'y a pas de version
 *    publiée de la fiche). ⚠️ Un manque DÉJÀ là ne bloque pas : la connaissance et les outils se retirent par
 *    d'autres routes, que rien ne garde, et refuser alors toute retouche de la fiche (un renommage, un premier pas
 *    vers la correction) enfermerait le client. Les colonnes (plafonds, modèle) ne créent aucun manque : un patch
 *    sans `contenu` ne relit rien.
 * Un brouillon se remplit dans le désordre : jamais contrôlé.
 *
 * 🔴 Sur l'état effectif après écriture, jamais sur celui qu'on vient de lire : le corps peut porter `contenu` et
 * `status: 'active'` ensemble, et linter l'état d'avant laisserait vider l'objectif et activer d'un geste. La fusion
 * rejouée ici est celle du SQL : superficielle, clé par clé.
 */
async function completudeRefusee(
  deps: DepsGestionAgents, tenantId: string, agentId: string, courant: AgentComplet | null, patch: PatchAgent,
): Promise<Refus | null> {
  const active = patch.status === 'active';
  const resteActif = patch.status === undefined && courant?.status === 'active' && patch.contenu !== undefined;
  if (!active && !resteActif) return null;
  const etat = await deps.etatPourLint(tenantId, agentId);
  if (!etat) return refus(404, AGENT_INTROUVABLE);
  const apres = manquesAvantActivation({ ...etat, fiche: { ...etat.fiche, ...(patch.contenu ?? {}) } });
  // 422 et non 500 : c'est une chose que le client doit lire et corriger, pas un incident.
  if (active) return apres.length > 0 ? refus(422, 'agent incomplet', { manques: apres }) : null;
  const deja = new Set(manquesAvantActivation(etat).map((m) => m.message));
  const introduits = apres.filter((m) => !deja.has(m.message));
  return introduits.length > 0 ? refus(422, AGENT_ACTIF_INCOMPLET, { manques: introduits }) : null;
}

/** Les champs d'un patch dans les mots de l'écran, pour le libellé de la ligne d'historique. */
const NOMS_DES_CHAMPS: Readonly<Record<string, string>> = {
  label: 'libellé', status: 'statut', mentionIa: 'mention d’IA', modele: 'modèle', maxTours: 'tours',
  maxAppelsOutils: 'appels d’outils', budgetMicroEur: 'budget', inactiviteMinutes: 'inactivité',
  contactInconnu: 'contact inconnu', nom: 'nom', objectif: 'objectif', ton: 'ton', personnalite: 'personnalité',
  reglesTransfert: 'règles de transfert', sorties: 'règles d’arrêt',
};

/** Les champs que le patch nomme, et leur valeur dans `a` : la fiche jsonb clé par clé, comme sa fusion. */
function champsNommes(a: AgentComplet, patch: PatchAgent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const cle of Object.keys(patch) as Array<keyof PatchAgent>) {
    if (cle === 'ficheVersionAttendue') continue;
    if (cle === 'contenu') {
      out.contenu = Object.fromEntries(
        Object.keys(patch.contenu ?? {}).map((k) => [k, a.contenu[k as keyof FicheAgentContenu]]),
      );
    } else {
      out[cle] = a[cle];
    }
  }
  return out;
}

/**
 * Ne garde que ce qui a CHANGÉ, clé par clé et dans la fiche champ par champ : la console renvoie toujours la fiche
 * entière, et une ligne qui cite les six champs pour un ton retouché ne dit plus ce qui a bougé.
 */
function seulementCeQuiChange(
  avantNomme: Record<string, unknown> | null, apresNomme: Record<string, unknown>,
): { avant: Record<string, unknown> | null; apres: Record<string, unknown>; noms: string[] } {
  const differe = (x: unknown, y: unknown) => JSON.stringify(x) !== JSON.stringify(y);
  const avant: Record<string, unknown> = {};
  const apres: Record<string, unknown> = {};
  const noms: string[] = [];
  for (const [cle, valeur] of Object.entries(apresNomme)) {
    if (cle === 'contenu') {
      const ca = (avantNomme?.contenu ?? {}) as Record<string, unknown>;
      const cp = valeur as Record<string, unknown>;
      const changes = Object.keys(cp).filter((k) => avantNomme === null || differe(ca[k], cp[k]));
      if (changes.length === 0) continue;
      apres.contenu = Object.fromEntries(changes.map((k) => [k, cp[k]]));
      if (avantNomme) avant.contenu = Object.fromEntries(changes.map((k) => [k, ca[k]]));
      noms.push(...changes.map((k) => NOMS_DES_CHAMPS[k] ?? k));
    } else if (avantNomme === null || differe(avantNomme[cle], valeur)) {
      apres[cle] = valeur;
      if (avantNomme) avant[cle] = avantNomme[cle];
      noms.push(NOMS_DES_CHAMPS[cle] ?? cle);
    }
  }
  return { avant: avantNomme ? avant : null, apres, noms };
}

/**
 * La ligne `fiche_agent` : ce que le patch a nommé ET changé, avant et après. 🔴 Au mieux : l'écriture de l'agent a déjà eu
 * lieu, et la traiter en échec ferait réessayer un geste passé (et se faire refuser par le verrou de version).
 * Rien n'est écrit quand rien n'a changé : un enregistrement à l'identique n'est pas une modification.
 */
async function journaliserFiche(
  deps: DepsGestionAgents, tenantId: string, courant: AgentComplet | null, agent: AgentComplet,
  patch: PatchAgent, auteur: AuteurModification,
): Promise<void> {
  const { avant, apres, noms } = seulementCeQuiChange(courant ? champsNommes(courant, patch) : null, champsNommes(agent, patch));
  if (noms.length === 0) return;
  try {
    await deps.historique.ecrire(tenantId, {
      surface: 'agent', surfaceId: agent.id, element: 'fiche_agent', operation: 'modification',
      cible: null, libelle: `Fiche de l’agent : ${noms.join(', ')}`, avant, apres,
      origine: auteur.origine, acteurEmail: null, acteurId: auteur.userId,
    });
  } catch (err) {
    journaliser('error', 'fiche_agent_non_journalisee', { err, tenantId, agentId: agent.id });
  }
}
