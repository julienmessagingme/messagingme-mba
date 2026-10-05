import { z } from 'zod';
import type { ContexteTour, DecisionTracee, GatewayBrainDeps } from './brain.gateway';
import { AgentIntrouvable, penserTrace } from './brain.gateway';
import { TourInterrompu, type UsageTour } from './brain';
import type { TestRunStore } from './test-runs';
import { direPanneModele } from '../llm/errors';
import { journaliser } from '../lib/journal';
import { messageDe } from '../lib/erreur';
import { refus, type Issue } from '../lib/issue';
import { estUuid } from '../http/scope';
import type { Origine } from '../reglages/historique';

/**
 * LE BAC À SABLE : parler à son agent avant de l'activer (lot 8a, `docs/superpowers/plans/2026-10-03-mcp-agent-ia.md`).
 *
 * 🔴 UNE SEULE VÉRITÉ, DEUX PORTES. La route de la console (`src/http/agent-test.ts`) et l'outil MCP `test_agent`
 * appellent `essayerAgent` : même solde exigé, même débit au prix client, même archivage. Un essai lancé par Claude
 * Code coûte exactement ce que coûte un essai lancé depuis l'écran.
 *
 * Il fait tourner le vrai cerveau (prompt, outils exposés, recherche de connaissance), mais les outils à effet sont
 * simulés (`resolvers/simulation.ts`) : il n'y a ni contact ni conversation, et poser un tag écrirait sur une vraie
 * fiche. 🔴 Aucune session ni run n'est ouvert ; seul l'essai est persisté (`agent_test_runs`), rien qui touche un
 * contact. Le journal d'appels reçu est muet : une session fictive violerait la clé étrangère de `agent_tool_calls`.
 */

/** Le câblage passe les MÊMES objets à la console et au MCP. */
export interface DepsEssai {
  /**
   * L'historique des essais. Un échec d'écriture ne fait jamais échouer un essai : une commodité ne devient pas
   * une condition.
   */
  essais: TestRunStore;
  /** Les deps du cerveau, moins l'appel de modèle quand il n'est pas configuré. */
  cerveau?: GatewayBrainDeps;
  /** Le Gateway est-il configuré ? Le modèle, lui, vient de la fiche de l'agent, pas d'une variable d'env. */
  disponible: boolean;
  /**
   * Le solde prépayé de l'espace, en micro-euros (les fixtures qui ne regardent pas l'argent passent `soldeIllimite`
   * et `sansDebit`). 🔴 Un essai consomme pour de vrai : le fournisseur le facture comme une conversation, et le
   * laisser hors du solde ouvrirait une porte gratuite et illimitée sur un compte prépayé.
   */
  credits: { solde(tenantId: string): Promise<number> };
  /** Retire du solde ce que l'essai a coûté. La note dit d'où vient le mouvement : un essai n'ouvre aucune
   *  session, donc le journal n'a rien d'autre pour l'expliquer. */
  debiter(tenantId: string, montantMicroEur: number, note: string): Promise<void>;
}

/**
 * Un essai n'est pas une conversation de production : on le borne plus court, il n'a pas à durer. Bornes et saisie
 * exportées pour UNE raison : l'outil MCP annonce chaque borne qu'il applique, et la lit ici.
 */
export const MAX_MESSAGES_ESSAI = 30;
export const MAX_CARACTERES_MESSAGE_ESSAI = 4000;
export const ROLES_ESSAI = ['user', 'assistant'] as const;
const messageSchema = z.object({
  role: z.enum(ROLES_ESSAI),
  content: z.string().trim().min(1).max(MAX_CARACTERES_MESSAGE_ESSAI),
});
export const saisieDEssai = z.object({ messages: z.array(messageSchema).min(1).max(MAX_MESSAGES_ESSAI) });

/** Budget de temps d'un essai. Plus large qu'un tour de production (30 s) : ici un humain attend devant son
 *  écran et préfère une réponse lente à un échec, alors qu'en production un contact attend sur WhatsApp. */
const DELAI_MS = 60_000;

/**
 * Le bac à sable n'a ni session, ni run, ni parcours : ces identifiants complètent le contexte du tronc commun et
 * ne désignent rien en base. Le contact est inconnu (aucun `lireContact`) et la politique de contact inconnu vient
 * de la fiche de l'agent : le bac à sable montre ce que la production ferait face à un inconnu.
 */
const TOUR_BAC_A_SABLE: Omit<ContexteTour, 'appelsDejaFaits' | 'coutDejaMicroEur'> = {
  sessionId: 'bac-a-sable',
  runId: 'bac-a-sable',
  workflowId: 'bac-a-sable',
  waId: 'bac-a-sable',
  // L'escalade y est simulée sans rendre la main (`resolvers/simulation.ts`) : la question ne se pose pas.
  repondeur: false,
};

/** La note du mouvement de crédit, par porte : c'est la seule explication du débit dans le journal du solde. */
const NOTE_DU_DEBIT: Readonly<Record<Exclude<Origine, 'assistant'>, string>> = {
  formulaire: 'essai depuis la console',
  mcp: 'essai depuis le serveur MCP',
};

/** Ce qu'un essai rend : la réponse, sa sortie, sa trace d'appels et ce qu'il a consommé. */
export interface ReponseEssai {
  texte: DecisionTracee['texte'];
  sortie: DecisionTracee['sortie'];
  /** N'existe que quand la sortie ne se suffit pas à elle-même (cf. `MotifArret`). */
  motif?: NonNullable<DecisionTracee['motif']>;
  appels: DecisionTracee['appels'];
  usage: UsageTour;
}

/**
 * Retire du solde ce que l'essai vient de coûter, au mieux comme en production : le fournisseur a déjà répondu,
 * on perd le décompte, jamais l'essai.
 */
async function debiterEssai(deps: DepsEssai, tenantId: string, coutMicroEur: number, note: string): Promise<void> {
  if (!(coutMicroEur > 0)) return;
  try {
    await deps.debiter(tenantId, coutMicroEur, note);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`agent: SOLDE NON DÉBITÉ pour un essai du tenant ${tenantId}`, messageDe(err));
  }
}

/**
 * Un essai : le solde d'abord, le vrai cerveau, le débit au prix client, puis l'archivage. 🔴 Une panne qui n'est
 * pas celle du fournisseur LÈVE (lecture de l'agent, clé déchiffrée, outils) : la route la rend en 500 opaque,
 * l'outil en erreur interne, sans quoi une panne de notre base partirait à l'appelant.
 */
export async function essayerAgent(
  deps: DepsEssai, tenantId: string, agentId: string, corps: unknown, origine: Exclude<Origine, 'assistant'>,
): Promise<Issue<ReponseEssai>> {
  if (!estUuid(agentId)) return refus(404, 'agent introuvable');
  if (!deps.cerveau || !deps.disponible) return refus(503, 'test indisponible (aucun modèle configuré côté serveur)');
  const lu = saisieDEssai.safeParse(corps ?? {});
  if (!lu.success) return refus(400, 'messages requis (rôle « user » ou « assistant », texte non vide)');
  const note = NOTE_DU_DEBIT[origine];

  // Le solde, avant l'appel au modèle : on ne paie pas un appel qu'on ne pourra pas facturer. 409 : un état du
  // compte, pas un incident (un 5xx serait remplacé par la page de Cloudflare).
  if ((await deps.credits.solde(tenantId)) <= 0) {
    return refus(409, 'solde épuisé : rechargez le compte pour essayer votre agent');
  }

  let decision: DecisionTracee;
  try {
    decision = await penserTrace(
      {
        agentId,
        tenantId,
        // Le transcript prend la forme que la session porte en production : le cerveau lit la même chose ici et là,
        // sans quoi le bac à sable ne testerait pas le même prompt.
        transcript: lu.data.messages.map((m) => ({ role: m.role === 'assistant' ? 'agent' : 'contact', texte: m.content })),
        deadline: Date.now() + DELAI_MS,
      },
      { ...TOUR_BAC_A_SABLE, appelsDejaFaits: 0, coutDejaMicroEur: 0 },
      deps.cerveau,
    );
  } catch (err) {
    // Une erreur typée distingue l'agent inconnu du reste : reconnaître un message se casserait en silence au
    // premier refactor de ce texte, et relire l'agent avant l'essai coûterait une requête par essai.
    if (err instanceof AgentIntrouvable) return refus(404, 'agent introuvable');
    // Un aller-retour déjà facturé se paie même si le suivant a échoué : le cerveau porte dans l'erreur ce
    // qu'il avait déjà dépensé, et un essai qui casse en cours de route n'a aucune raison d'être offert.
    if (err instanceof TourInterrompu) await debiterEssai(deps, tenantId, err.usage.coutMicroEur, note);
    /**
     * Panne du fournisseur, délai dépassé, clé refusée : 422 journalisé, pas un incident de la console.
     * 🔴 Mais ce `catch` attrape tout le tour (lecture de l'agent, clé déchiffrée, outils) : seule une panne du
     * fournisseur se dit, rédigée par `direPanneModele` ; le reste est relancé en 500 opaque, sans quoi une panne de
     * notre base partirait au navigateur. La cause se lit sous `TourInterrompu`.
     */
    const cause = err instanceof TourInterrompu ? err.erreur : err;
    const raison = direPanneModele(cause);
    // On relance la cause, pas l'enveloppe : le gestionnaire global journalise la pile, et celle de
    // `TourInterrompu` montre `penserTrace`, pas la fonction qui a levé. Une cause qui n'est pas une `Error`
    // repart dans son enveloppe, qui en porte au moins le texte.
    if (raison === null) throw cause instanceof Error ? cause : err;
    // La cause ici aussi : sa pile, pas celle de l'enveloppe.
    journaliser('error', 'agent_test_echec', { tenantId, agentId, err: cause instanceof Error ? cause : err });
    return refus(422, `l’essai a échoué : ${raison}`);
  }

  await debiterEssai(deps, tenantId, decision.usage?.coutMicroEur ?? 0, note);

  const usage = decision.usage ?? { tokensIn: 0, tokensOut: 0, coutMicroEur: 0 };
  /**
   * L'historique s'écrit après la décision et ne peut pas la faire échouer : le modèle a répondu et le solde est
   * débité, perdre la réponse pour une trace serait absurde. On journalise et on rend la réponse. L'attente est
   * voulue : l'écran relit l'historique juste après et doit y voir cet essai.
   */
  try {
    await deps.essais.ecrire(tenantId, agentId, {
      messages: lu.data.messages,
      reponse: decision.texte,
      sortie: decision.sortie,
      // On garde le nom et le statut, jamais le contenu rendu par l'outil : il peut être volumineux, il vient d'une
      // base qu'un site tiers a remplie, et la question ici est « a-t-il seulement cherché ? ».
      appels: decision.appels.map((a) => ({ nom: a.nom, status: a.status })),
      tokensEntree: usage.tokensIn,
      tokensSortie: usage.tokensOut,
      coutMicroEur: usage.coutMicroEur,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`agent: ESSAI NON ARCHIVÉ pour le tenant ${tenantId}`, messageDe(err));
  }
  return {
    ok: true,
    valeur: {
      texte: decision.texte,
      sortie: decision.sortie,
      // Le motif ne part que vers le bac à sable : la production ne lit que la sortie.
      ...(decision.motif ? { motif: decision.motif } : {}),
      appels: decision.appels,
      usage,
    },
  };
}
