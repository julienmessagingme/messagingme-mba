import type { AgentBrain, ContexteTourAgent, DecisionAgent } from './brain';
import { TourInterrompu } from './brain';
import type { ChatMessage, OutilExpose, ReponseChat } from './llm/chat-client';
import type { ContexteAppel, ResultatOutil, ToolExecutorDeps } from './executor';
import { executeTool } from './executor';
import type { OutilDefini } from './catalog';
import type { SortieAgent } from './agent-store';
import type { FrequenceMentionIa } from './agent-store';
import { outilsExposes } from './outils-maison';
import { blocResultatOutil, ressembleAUnBlocOutil, promptSysteme, type ContexteAgent } from './prompt';
import type { EquipePourPrompt } from './disponibilite-equipe';
import { SORTIE_PLAFOND } from './sorties';
import { prixClientMicroEur } from './devise';

/**
 * Le cerveau réel : la boucle qui transforme un historique en une décision, partagée par le bac à sable et
 * le tour de production (un bac à sable qui n'exercerait pas le vrai chemin ne testerait rien).
 *
 * Elle alerte sur une erreur de protocole, calcule les plafonds restants à chaque appel, encadre le résultat
 * d'outil en bloc délimité, et garde la sortie (un texte qui imite nos délimiteurs n'est pas une réponse).
 *
 * 🔴 Trois façons d'arrêter la boucle : le modèle rend du texte ; un outil demande une sortie ou a rendu la
 * main ; le plafond d'allers-retours. Sans ce dernier, un modèle qui rappelle le même outil (ce qu'une
 * injection chercherait) brûlerait le compte prépayé du tenant.
 */

/**
 * L'agent n'existe pas, ou appartient à un autre tenant. Erreur typée : l'appelant rend un 404 sans relire
 * l'agent ni reconnaître un message.
 */
export class AgentIntrouvable extends Error {
  constructor(agentId: string) { super(`agent ${agentId} introuvable`); this.name = 'AgentIntrouvable'; }
}

/** Allers-retours de modèle dans un tour ; au-delà, on sort par le plafond. À ne pas confondre avec
 *  `max_tours` de la fiche, qui compte les tours de conversation. */
export const MAX_ALLERS_RETOURS = 6;

export interface GatewayBrainDeps {
  /** Le client du modèle, injecté. `tenantId` décide quelle clé paie l'appel : celle de l'espace, sinon la maison. */
  client: {
    completer(input: { tenantId: string; modele: string; messages: ChatMessage[]; outils?: OutilExpose[]; signal?: AbortSignal }): Promise<ReponseChat>;
  };
  /** Tout ce que l'agent est : sa fiche, ses outils actifs, ses règles d'arrêt. `null` = agent introuvable. */
  contexte(tenantId: string, agentId: string): Promise<ContexteAgentComplet | null>;
  /** L'exécution d'outil, avec ses deps. La boucle ne les connaît pas, elle les passe. */
  outils: ToolExecutorDeps;
  /**
   * La fiche du contact, bornée par l'appelant. Absente : contact inconnu. Une projection, pas la ligne de
   * base : `mba_lire_contact` la rend au modèle, donc au fournisseur.
   */
  contacts?: { projectionPourTiers(tenantId: string, waId: string): Promise<Record<string, unknown> | null> };
  /**
   * Taux dollars vers euros (le Gateway facture en dollars, nos compteurs sont en micro-euros). Absent :
   * facteur 1, jamais zéro, qui désarmerait les plafonds.
   */
  tauxEurParDollar?: number;
  /**
   * Notre commission, en pourcent (`COMMISSION_MODELE_PCT`) : le coût du tour est le PRIX CLIENT, celui que le
   * solde paie et que la liste des modèles annonce. Requise : un câblage qui l'oublierait débiterait le coût brut
   * sans que rien ne le signale.
   */
  commissionPct: number;
  /** Signale une erreur de protocole (bug de notre client). Best-effort : jamais bloquant. */
  alerter?(message: string): void;
  now?: () => number;
}

export interface ContexteAgentComplet {
  modele: string;
  /** Le régime d'annonce d'IA. C'est le tour qui en tire un booléen, pas le modèle. */
  mentionIaFrequence: FrequenceMentionIa;
  mentionIa: string;
  sorties: SortieAgent[];
  contenu: ContexteAgent['contenu'];
  /** Les outils actifs, tels que le catalogue les rend. Vide = l'agent peut parler mais rien faire. */
  outilsActifs: OutilDefini[];
  plafonds: { maxAppelsOutils: number; budgetMicroEur: number };
  /** Ce que l'agent a le droit de faire face à un contact inconnu. Vient de sa fiche, jamais de l'appelant. */
  contactInconnu: ContexteAppel['contactInconnu'];
  /** L'équipe est-elle joignable, et sinon quand reprend-elle ? Absente = disponible. */
  equipe?: EquipePourPrompt;
}

/**
 * Ce que l'appelant fournit pour situer le tour. Ni le contact (il se lit par `contacts.projectionPourTiers`) ni la politique
 * de contact inconnu (elle vit sur la fiche) : chaque appelant les résoudrait à sa façon, et le bac à sable
 * divergerait de la production.
 */
export type ContexteTour = ContexteTourAgent;

/** Un appel d'outil, tel que l'écran de test le montre. Le tour de production, lui, n'en a pas besoin. */
export interface TraceAppel {
  nom: string;
  arguments: string;
  status: ResultatOutil['status'];
  contenu: unknown;
}

/**
 * Pourquoi le tour s'est arrêté, quand la sortie seule ne suffit pas à le dire. Pas une sortie de plus : la
 * sortie `plafond` est câblée dans les scénarios, et un handle que personne n'a câblé ferait partir le
 * parcours par la première arête venue. Le motif voyage à côté, seul le bac à sable le lit.
 */
export type MotifArret = 'plafond_allers_retours' | 'reponse_non_conforme';

export interface DecisionTracee extends DecisionAgent {
  appels: TraceAppel[];
  /** Absent quand la sortie se suffit à elle-même (l'agent a répondu, ou emprunté une sortie du client). */
  motif?: MotifArret;
}

/**
 * L'agent a-t-il déjà pris la parole dans cette session ? Lu sur le transcript de la session, pas sur
 * l'historique : un contact qui revient ouvre une nouvelle session, et l'annonce se refait.
 */
function dejaParle(transcript: unknown[]): boolean {
  return transcript.some((t) => (t as { role?: unknown } | null)?.role === 'agent');
}

/**
 * Ce que le contact reçoit quand un outil fait sortir le tour : le texte de la réponse qui porte l'appel s'il n'est
 * pas vide ; sinon le dernier message que `terminer` porte, pour un modèle qui appelle l'outil sans rien écrire à
 * côté ; sinon rien. Un dernier message qui porte nos délimiteurs est écarté comme une réponse qui les imite, mais
 * la sortie reste : la règle d'arrêt a été atteinte, seul le message est douteux.
 */
function texteDeSortie(ecrit: string | null, dernierMessage: string | undefined, signaler: () => void): string | null {
  if (ecrit !== null && ecrit.trim() !== '') return ecrit;
  if (dernierMessage === undefined) return null;
  if (ressembleAUnBlocOutil(dernierMessage)) {
    signaler();
    return null;
  }
  return dernierMessage;
}

function versMessages(transcript: unknown[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const brut of transcript) {
    if (!brut || typeof brut !== 'object') continue;
    const t = brut as { role?: unknown; texte?: unknown };
    const texte = typeof t.texte === 'string' ? t.texte : '';
    if (texte === '') continue;
    out.push({ role: t.role === 'agent' ? 'assistant' : 'user', content: texte });
  }
  return out;
}

/**
 * Un tour de raisonnement complet, avec la trace des appels d'outils que le bac à sable affiche. Une seule
 * boucle, deux façons de la regarder (`creerCerveauGateway` jette la trace).
 */
export async function penserTrace(
  input: { agentId: string; tenantId: string; transcript: unknown[]; deadline: number },
  tour: ContexteTour,
  deps: GatewayBrainDeps,
): Promise<DecisionTracee> {
  // Le compteur vit hors de la boucle, pour survivre à son échec : chaque aller-retour est facturé, et
  // une exception nue emporterait ce que les précédents ont coûté. On le repasse à l'appelant dans l'erreur.
  const usage = { tokensIn: 0, tokensOut: 0, coutMicroEur: 0 };
  try {
    return await boucler(input, tour, deps, usage);
  } catch (err) {
    if (usage.coutMicroEur > 0) throw new TourInterrompu(err, usage);
    throw err;
  }
}

/** La boucle elle-même. `usage` est muté : c'est ce qui permet à `penserTrace` de le rattraper quand la
 *  boucle lève. */
async function boucler(
  input: { agentId: string; tenantId: string; transcript: unknown[]; deadline: number },
  tour: ContexteTour,
  deps: GatewayBrainDeps,
  usage: { tokensIn: number; tokensOut: number; coutMicroEur: number },
): Promise<DecisionTracee> {
  const agent = await deps.contexte(input.tenantId, input.agentId);
  if (!agent) throw new AgentIntrouvable(input.agentId);
  // Le contact est lu une fois par tour : il sert au prompt et à l'autorisation de chaque outil.
  const contact = deps.contacts ? await deps.contacts.projectionPourTiers(input.tenantId, tour.waId) : null;

  const messages: ChatMessage[] = [
    {
      role: 'system',
      /**
       * Le régime d'annonce devient ici une décision, sur le transcript de la session en cours :
       *   - `jamais`         : on n'en parle pas ;
       *   - `chaque_message` : à tous les tours ;
       *   - `session`        : au premier tour où l'agent prend la parole, et à celui-là seulement.
       */
      content: promptSysteme({
        mentionIa: agent.mentionIa,
        annoncerIa: agent.mentionIaFrequence === 'chaque_message'
          || (agent.mentionIaFrequence === 'session' && !dejaParle(input.transcript)),
        contenu: agent.contenu,
        contactConnu: contact !== null,
        equipe: agent.equipe,
      }),
    },
    ...versMessages(input.transcript),
  ];
  const exposes = outilsExposes(agent.outilsActifs, agent.sorties);
  const appels: TraceAppel[] = [];
  let appelsFaits = tour.appelsDejaFaits;

  for (let allerRetour = 0; allerRetour < MAX_ALLERS_RETOURS; allerRetour += 1) {
    /**
     * 🔴 Le budget arrête aussi les allers-retours, pas seulement les outils : sinon une conversation à court de
     * budget continuerait de payer des appels de modèle. `allerRetour > 0` : dès le premier, les outils du tour
     * ne seraient jamais exécutés et le refus « budget épuisé » de l'exécuteur n'atteindrait jamais le modèle.
     * `run-turn` garde déjà l'entrée du tour ; ce contrôle borne la suite.
     */
    if (allerRetour > 0 && tour.coutDejaMicroEur + usage.coutMicroEur >= agent.plafonds.budgetMicroEur) {
      return { texte: null, sortie: SORTIE_PLAFOND, usage, appels, motif: 'plafond_allers_retours' };
    }
    const reponse = await deps.client.completer({
      tenantId: input.tenantId,
      modele: agent.modele,
      messages,
      ...(exposes.length > 0 ? { outils: exposes } : {}),
      // `Math.max(0, ...)` et non un plancher d'une seconde : l'échéance du tour est dure, une grâce rejouée à
      // chaque aller-retour la rendrait molle.
      signal: AbortSignal.timeout(Math.max(0, input.deadline - (deps.now ? deps.now() : Date.now()))),
    });
    usage.tokensIn += reponse.usage.tokensIn;
    usage.tokensOut += reponse.usage.tokensOut;
    /**
     * Une ligne par aller-retour : la part du prompt servie depuis un cache, pour voir si elle grimpe au
     * deuxième (préfixe déjà connu du fournisseur). La partie constante (prompt système, outils) repart à chaque
     * aller-retour : c'est le plus gros levier sur le coût si elle n'est pas cachée.
     */
    // eslint-disable-next-line no-console
    console.log(`agent-cache: agent=${input.agentId} ar=${allerRetour} in=${reponse.usage.tokensIn} caches=${reponse.usage.tokensCaches} part=${reponse.usage.tokensIn > 0 ? Math.round((reponse.usage.tokensCaches / reponse.usage.tokensIn) * 100) : 0}%`);
    // La conversion se fait ici, une seule fois, et rend le prix client (commission comprise) : tout l'aval le lit
    // (débit du solde, coût de la session, budget de la conversation, coût affiché de l'essai).
    usage.coutMicroEur += prixClientMicroEur(reponse.usage.coutDollars, deps.tauxEurParDollar ?? 1, deps.commissionPct);

    if (reponse.appelsOutils.length === 0) {
      const texte = reponse.texte ?? '';
      /**
       * Un texte qui porte nos délimiteurs n'est pas une réponse (le modèle a imité un bloc de résultat d'outil,
       * contenu inventé compris) : il est signalé comme une erreur de protocole, l'appelant décide. On ne le
       * « nettoie » pas : ce qui reste est une réponse inventée présentée comme vraie.
       */
      if (ressembleAUnBlocOutil(texte)) {
        deps.alerter?.(`agent ${input.agentId} : le modèle a rendu un faux bloc de résultat d’outil au lieu d’une réponse`);
        return { texte: null, sortie: SORTIE_PLAFOND, usage, appels, motif: 'reponse_non_conforme' };
      }
      return { texte, sortie: null, usage, appels };
    }

    // Le message `assistant` qui porte `tool_calls` est obligatoire, avec tous les appels de cette réponse tels
    // que le modèle les a produits : sinon le message `tool` est refusé en 400, terminal.
    messages.push({
      role: 'assistant',
      content: reponse.texte,
      tool_calls: reponse.appelsOutils.map((a) => ({ id: a.id, type: 'function' as const, function: { name: a.nom, arguments: a.argumentsJson } })),
    });

    for (const appel of reponse.appelsOutils) {
      // Les plafonds sont recalculés à chaque appel : six outils demandés d'un coup ne dépassent pas en une salve.
      const ctx: ContexteAppel = {
        tenantId: input.tenantId,
        agentId: input.agentId,
        sessionId: tour.sessionId,
        runId: tour.runId,
        workflowId: tour.workflowId,
        waId: tour.waId,
        contact,
        contactInconnu: agent.contactInconnu,
        appelsRestants: agent.plafonds.maxAppelsOutils - appelsFaits,
        budgetRestantMicroEur: agent.plafonds.budgetMicroEur - (tour.coutDejaMicroEur + usage.coutMicroEur),
        deadline: input.deadline,
      };
      const res = await executeTool({ name: appel.nom, argumentsJson: appel.argumentsJson }, ctx, deps.outils);
      appelsFaits += 1;
      appels.push({ nom: appel.nom, arguments: appel.argumentsJson, status: res.status, contenu: res.contenu });

      if (res.fatal) {
        // Une erreur de protocole est un bug de notre client, pas du modèle : on alerte et on arrête le tour, il
        // ne peut rien y corriger.
        deps.alerter?.(`agent ${input.agentId} : erreur de protocole sur l'outil ${appel.nom}`);
        return { texte: null, sortie: null, usage, appels };
      }
      // L'escalade a déjà rendu la main : le tour s'arrête ici.
      if (res.rendu) {
        /**
         * La dernière phrase est gardée seulement si l'équipe est indisponible. Équipe joignable : c'est la branche
         * `humain` du scénario qui parle, une seule voix. Équipe fermée : cette branche est un bloc statique, qui ne
         * peut pas dire « nous reprenons lundi 9 h » ; l'agent, qui a reçu la date dans sa consigne, le peut. Un
         * espace sans réglage est en `always`, donc inchangé.
         */
        const equipeMuette = agent.equipe !== undefined && !agent.equipe.disponible;
        return {
          texte: equipeMuette ? (reponse.texte ?? null) : null,
          sortie: null,
          usage,
          appels,
          /**
           * Sans cette marque, le texte ci-dessus n'arriverait jamais : l'escalade vient de basculer le fil vers
           * `app_human`, et `run-turn` conclurait qu'un opérateur a pris la main.
           */
          ...(res.mainPrise ? { mainPriseParCeTour: true } : {}),
        };
      }
      if (res.sortie) {
        const texte = texteDeSortie(reponse.texte, res.dernierMessage, () => deps.alerter?.(
          `agent ${input.agentId} : le modèle a rendu un faux bloc de résultat d’outil comme dernier message`,
        ));
        return { texte, sortie: res.sortie, usage, appels };
      }

      // Le résultat repart au modèle dans un bloc délimité : il vient d'une base remplie depuis un site
      // tiers, ou d'un connecteur, c'est de la donnée, jamais un ordre.
      messages.push({ role: 'tool', content: blocResultatOutil(res.contenu), tool_call_id: appel.id });
    }
  }

  // Plafond d'allers-retours atteint : même sortie que le plafond de tours, câblée une seule fois.
  return { texte: null, sortie: SORTIE_PLAFOND, usage, appels, motif: 'plafond_allers_retours' };
}

/**
 * Le cerveau du tour de production : la même boucle, sans la trace. Le tour est pris sur l'appel, jamais
 * figé ici : un worker sert tous les clients avec un seul cerveau, et un contexte figé exécuterait les
 * outils du contact A dans la conversation de B.
 */
export function creerCerveauGateway(deps: GatewayBrainDeps): AgentBrain {
  return {
    penser: async (input) => {
      if (!input.tour) throw new Error('cerveau gateway : le tour est requis pour appeler des outils');
      const { appels: _appels, ...decision } = await penserTrace(input, input.tour, deps);
      return decision;
    },
  };
}
