import type { AgentBrain, DecisionAgent } from './brain';
import type { ChatMessage, OutilExpose, ReponseChat } from './llm/chat-client';
import type { ContexteAppel, ResultatOutil, ToolExecutorDeps } from './executor';
import { executeTool } from './executor';
import type { OutilDefini } from './catalog';
import type { SortieAgent } from './agent-store';
import { outilsExposes } from './outils-maison';
import { blocResultatOutil, promptSysteme, type ContexteAgent } from './prompt';
import { SORTIE_PLAFOND } from './sorties';

/**
 * Le CERVEAU réel : la boucle qui transforme un historique en une décision.
 *
 * 🔴 C'EST L'APPELANT QUI MANQUAIT à `executeTool` (dette D3), et les trois responsabilités que sa JSDoc lui
 * assignait sont ici, chacune commentée là où elle se joue : alerter sur une erreur de protocole, calculer
 * les plafonds restants, et encadrer le résultat d'outil en bloc délimité avant de le remettre au modèle.
 *
 * 🔴 CE QUI ARRÊTE LA BOUCLE, et il n'y a que trois façons. Le modèle rend du TEXTE (il a fini de parler,
 * c'est le cas nominal) ; un outil demande une SORTIE (`mba_terminer`, ou la recherche de connaissance qui
 * ne trouve rien) ou a déjà rendu la main (escalade) ; ou on atteint le plafond d'ALLERS-RETOURS. Sans ce
 * dernier, un modèle qui rappelle indéfiniment le même outil brûlerait le compte prépayé du tenant en
 * quelques secondes, et c'est exactement ce qu'une injection dans un message de contact chercherait à faire.
 *
 * Le même cerveau sert le bac à sable de la console et, plus tard, le tour de production : c'est délibéré.
 * Un bac à sable qui n'exercerait pas le vrai chemin ne testerait rien.
 */

/**
 * L'agent n'existe pas, ou appartient à un autre tenant.
 *
 * Une ERREUR TYPÉE et non un message à reconnaître : c'est l'idiome du dépôt (`FicheAgentPerimee`,
 * `LabelAgentDejaPris`, `NomOutilDejaPris`), et il évite deux choses d'un coup. Un appelant qui devrait
 * relire l'agent juste pour distinguer un 404 d'un 502 ferait une requête de plus par essai, et un appelant
 * qui reconnaîtrait le message verrait sa distinction cassée en silence au premier refactor de ce texte.
 */
export class AgentIntrouvable extends Error {
  constructor(agentId: string) { super(`agent ${agentId} introuvable`); this.name = 'AgentIntrouvable'; }
}

/** Allers-retours de modèle dans UN tour. Au-delà, on sort par le plafond plutôt que de continuer à payer.
 *  À ne pas confondre avec `max_tours` de la fiche, qui compte les tours de CONVERSATION. */
export const MAX_ALLERS_RETOURS = 6;

export interface GatewayBrainDeps {
  /** L'appel de modèle. Injecté : le cerveau se teste sans réseau. */
  completer(input: { modele: string; messages: ChatMessage[]; outils?: OutilExpose[]; signal?: AbortSignal }): Promise<ReponseChat>;
  /** Tout ce que l'agent est : sa fiche, ses outils actifs, ses règles d'arrêt. `null` = agent introuvable. */
  contexte(tenantId: string, agentId: string): Promise<ContexteAgentComplet | null>;
  /** L'exécution d'outil, avec ses deps. La boucle ne les connaît pas, elle les passe. */
  outils: ToolExecutorDeps;
  /** Signale une erreur de PROTOCOLE (bug de notre client). Best-effort : jamais bloquant. */
  alerter?(message: string): void;
  now?: () => number;
}

export interface ContexteAgentComplet {
  modele: string;
  mentionIa: string;
  sorties: SortieAgent[];
  contenu: ContexteAgent['contenu'];
  /** Les outils ACTIFS, tels que le catalogue les rend. Vide = l'agent peut parler mais rien faire. */
  outilsActifs: OutilDefini[];
  plafonds: { maxAppelsOutils: number; budgetMicroEur: number };
}

/** Ce que l'appelant fournit pour situer le tour. En bac à sable, ce sont des valeurs de bac à sable. */
export interface ContexteTour {
  sessionId: string;
  runId: string;
  workflowId: string;
  waId: string;
  contact: Record<string, unknown> | null;
  contactInconnu: ContexteAppel['contactInconnu'];
  /** Appels d'outils DÉJÀ faits dans cette session, et coût déjà engagé. */
  appelsDejaFaits: number;
  coutDejaMicroEur: number;
}

/** Un appel d'outil, tel que l'écran de test le montre. Le tour de production, lui, n'en a pas besoin. */
export interface TraceAppel {
  nom: string;
  arguments: string;
  status: ResultatOutil['status'];
  contenu: unknown;
}

export interface DecisionTracee extends DecisionAgent {
  appels: TraceAppel[];
}

/** Le transcript, tel que la session le porte : un rôle et un texte. Lu défensivement, c'est du jsonb. */
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
 * Un tour de raisonnement complet.
 *
 * Rendu séparément de `creerCerveauGateway` parce que le bac à sable a besoin de la TRACE des appels
 * d'outils (c'est tout l'intérêt du panneau de test : voir ce que l'agent a choisi de faire), alors que le
 * tour de production n'en a que faire. Une seule boucle, deux façons de la regarder.
 */
export async function penserTrace(
  input: { agentId: string; tenantId: string; transcript: unknown[]; deadline: number },
  tour: ContexteTour,
  deps: GatewayBrainDeps,
): Promise<DecisionTracee> {
  const agent = await deps.contexte(input.tenantId, input.agentId);
  if (!agent) throw new AgentIntrouvable(input.agentId);

  const messages: ChatMessage[] = [
    { role: 'system', content: promptSysteme({ mentionIa: agent.mentionIa, contenu: agent.contenu, contactConnu: tour.contact !== null }) },
    ...versMessages(input.transcript),
  ];
  const exposes = outilsExposes(agent.outilsActifs, agent.sorties);
  const appels: TraceAppel[] = [];
  const usage = { tokensIn: 0, tokensOut: 0, coutMicroEur: 0 };
  let appelsFaits = tour.appelsDejaFaits;

  for (let allerRetour = 0; allerRetour < MAX_ALLERS_RETOURS; allerRetour += 1) {
    const reponse = await deps.completer({
      modele: agent.modele,
      messages,
      ...(exposes.length > 0 ? { outils: exposes } : {}),
      // `Math.max(0, ...)` et non un plancher d'une seconde : l'échéance du tour est DURE, et une grâce
      // rejouée à chaque aller-retour la rendrait molle.
      signal: AbortSignal.timeout(Math.max(0, input.deadline - (deps.now ? deps.now() : Date.now()))),
    });
    usage.tokensIn += reponse.usage.tokensIn;
    usage.tokensOut += reponse.usage.tokensOut;
    // ⚠️ DETTE D1 : le Gateway facture en DOLLARS et la colonne est en micro-euros. La conversion est une
    // décision de facturation, pas technique, et elle est encore ouverte. On accumule la valeur telle
    // quelle, en micro-unités, pour que le plafond morde au bon ordre de grandeur en attendant.
    usage.coutMicroEur += Math.round(reponse.usage.coutDollars * 1_000_000);

    if (reponse.appelsOutils.length === 0) {
      return { texte: reponse.texte ?? '', sortie: null, usage, appels };
    }

    // 🔴 LE MESSAGE `assistant` QUI PORTE `tool_calls` EST OBLIGATOIRE, et il porte TOUS les appels de CETTE
    // réponse, pas un par appel. L'API refuse en 400 un message `tool` qui ne répond pas à un `assistant`
    // portant `tool_calls`, et un 400 est TERMINAL (jamais rejoué) : la conversation s'arrêterait au deuxième
    // aller-retour, c'est-à-dire exactement là où l'agent reformule à partir de ses sources. On renvoie donc
    // les appels TELS QUE le modèle les a produits.
    messages.push({
      role: 'assistant',
      content: reponse.texte,
      tool_calls: reponse.appelsOutils.map((a) => ({ id: a.id, type: 'function' as const, function: { name: a.nom, arguments: a.argumentsJson } })),
    });

    for (const appel of reponse.appelsOutils) {
      // Les plafonds sont calculés à CHAQUE appel, pas une fois par tour : c'est la dette D3(b). Un modèle
      // qui demande six outils d'un coup ne doit pas pouvoir dépasser en une seule salve.
      const ctx: ContexteAppel = {
        tenantId: input.tenantId,
        agentId: input.agentId,
        sessionId: tour.sessionId,
        runId: tour.runId,
        workflowId: tour.workflowId,
        waId: tour.waId,
        contact: tour.contact,
        contactInconnu: tour.contactInconnu,
        appelsRestants: agent.plafonds.maxAppelsOutils - appelsFaits,
        budgetRestantMicroEur: agent.plafonds.budgetMicroEur - (tour.coutDejaMicroEur + usage.coutMicroEur),
        deadline: input.deadline,
      };
      const res = await executeTool({ name: appel.nom, argumentsJson: appel.argumentsJson }, ctx, deps.outils);
      appelsFaits += 1;
      appels.push({ nom: appel.nom, arguments: appel.argumentsJson, status: res.status, contenu: res.contenu });

      if (res.fatal) {
        // Dette D3(a) : une erreur de PROTOCOLE est un bug de NOTRE client, pas du modèle. On alerte et on
        // arrête le tour : le lui repasser lui ferait réessayer indéfiniment une chose qu'il ne peut pas
        // corriger.
        deps.alerter?.(`agent ${input.agentId} : erreur de protocole sur l'outil ${appel.nom}`);
        return { texte: null, sortie: null, usage, appels };
      }
      // L'escalade a déjà rendu la main : plus rien à dire, et surtout pas un message de plus au contact.
      if (res.rendu) return { texte: null, sortie: null, usage, appels };
      if (res.sortie) return { texte: reponse.texte ?? null, sortie: res.sortie, usage, appels };

      // Dette D3(c) : le résultat repart au modèle DANS UN BLOC DÉLIMITÉ. Il vient d'une base de
      // connaissance qu'un site tiers a remplie, ou demain d'un connecteur dont personne ne contrôle la
      // réponse : c'est de la donnée, jamais un ordre.
      messages.push({ role: 'tool', content: blocResultatOutil(res.contenu), tool_call_id: appel.id });
    }
  }

  // Plafond d'allers-retours atteint : on sort proprement plutôt que de continuer à payer un modèle qui
  // tourne en rond. C'est la même sortie que le plafond de tours, et le client la câble une seule fois.
  return { texte: null, sortie: SORTIE_PLAFOND, usage, appels };
}

/** Le cerveau, pour le tour de production : la même boucle, sans la trace. */
export function creerCerveauGateway(tour: ContexteTour, deps: GatewayBrainDeps): AgentBrain {
  return {
    penser: async (input) => {
      const { appels: _appels, ...decision } = await penserTrace(input, tour, deps);
      return decision;
    },
  };
}
