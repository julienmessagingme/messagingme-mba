import type { AgentBrain, ContexteTourAgent, DecisionAgent } from './brain';
import { TourInterrompu } from './brain';
import type { ChatMessage, OutilExpose, ReponseChat } from './llm/chat-client';
import type { ContexteAppel, ResultatOutil, ToolExecutorDeps } from './executor';
import { executeTool } from './executor';
import type { OutilDefini } from './catalog';
import type { SortieAgent } from './agent-store';
import { outilsExposes } from './outils-maison';
import { blocResultatOutil, ressembleAUnBlocOutil, promptSysteme, type ContexteAgent } from './prompt';
import { SORTIE_PLAFOND } from './sorties';
import { microEurosDepuisDollars } from './devise';

/**
 * Le CERVEAU réel : la boucle qui transforme un historique en une décision.
 *
 * 🔴 C'EST L'APPELANT QUI MANQUAIT à `executeTool` (dette D3), et les trois responsabilités que sa JSDoc lui
 * assignait sont ici, chacune commentée là où elle se joue : alerter sur une erreur de protocole, calculer
 * les plafonds restants, et encadrer le résultat d'outil en bloc délimité avant de le remettre au modèle.
 *
 * 🔴 UNE QUATRIÈME S'Y EST AJOUTÉE LE 2026-09-08, et elle regarde dans l'autre sens : GARDER LA SORTIE. Le
 * modèle a rendu un faux bloc de résultat d'outil comme réponse, contenu inventé compris, et un client l'a
 * lu. Encadrer ce qui ENTRE ne suffit pas quand la consigne apprend au modèle à écrire ce format.
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
  /** ⚠️ `tenantId` decide QUELLE CLE paie l'appel (2026-09-09) : celle de l'espace, sinon la maison. */
  completer(input: { tenantId: string; modele: string; messages: ChatMessage[]; outils?: OutilExpose[]; signal?: AbortSignal }): Promise<ReponseChat>;
  /** Tout ce que l'agent est : sa fiche, ses outils actifs, ses règles d'arrêt. `null` = agent introuvable. */
  contexte(tenantId: string, agentId: string): Promise<ContexteAgentComplet | null>;
  /** L'exécution d'outil, avec ses deps. La boucle ne les connaît pas, elle les passe. */
  outils: ToolExecutorDeps;
  /**
   * La fiche du contact, bornée par l'appelant. Absente -> contact INCONNU, ce qui est la vérité d'un bac à
   * sable et le cas le plus fréquent d'un premier message.
   *
   * ⚠️ C'est une PROJECTION, pas la ligne de base : `mba_lire_contact` la rend telle quelle au modèle, donc
   * au fournisseur. Y verser une ligne brute enverrait chez lui des champs que personne n'a décidé de
   * partager.
   */
  lireContact?(tenantId: string, waId: string): Promise<Record<string, unknown> | null>;
  /**
   * Taux de conversion dollars vers euros. Le Gateway facture en DOLLARS, tous nos compteurs sont en
   * micro-euros. Absent -> facteur 1, jamais zéro : mieux vaut facturer un dollar pour un euro que de ne
   * rien facturer du tout, ce qui désarmerait les plafonds en silence.
   */
  tauxEurParDollar?: number;
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
  /** Ce que l'agent a le droit de faire face à un contact inconnu. Vient de sa fiche, jamais de l'appelant. */
  contactInconnu: ContexteAppel['contactInconnu'];
}

/**
 * Ce que l'appelant fournit pour situer le tour.
 *
 * ⚠️ Il ne porte NI le contact NI la politique de contact inconnu, et c'est délibéré : le premier se lit
 * (`lireContact`), la seconde vit sur la fiche de l'agent. Les faire remonter jusqu'ici obligerait chaque
 * appelant à les résoudre, et le bac à sable l'avait fait en les forçant à des valeurs de son cru, ce qui
 * lui faisait montrer un comportement que la production n'aurait pas eu.
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
 * Pourquoi le tour s'est arrêté, quand la SORTIE seule ne suffit pas à le dire.
 *
 * 🔴 CE N'EST PAS UNE SORTIE DE PLUS, ET C'EST TOUT L'INTÉRÊT. La sortie `plafond` est CÂBLÉE dans les
 * scénarios des clients : en inventer une seconde obligerait chacun à la relier, et un handle que personne
 * n'a câblé fait partir le parcours par la première arête venue. Le motif voyage donc À COTÉ, il ne
 * remplace rien, et seul le bac à sable le lit.
 *
 * Julien, le 2026-09-08 : « pas une sortie plafond, je ne comprends pas ». Il avait raison de ne pas
 * comprendre : aucun plafond n'était atteint. Le modèle avait imité un bloc de résultat d'outil, et le
 * garde-fou l'avait refusé, ce qui est juste ; c'est le MOT qui l'a envoyé chercher un réglage inexistant.
 */
export type MotifArret = 'plafond_allers_retours' | 'reponse_non_conforme';

export interface DecisionTracee extends DecisionAgent {
  appels: TraceAppel[];
  /** Absent quand la sortie se suffit à elle-même (l'agent a répondu, ou emprunté une sortie du client). */
  motif?: MotifArret;
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
  // 🔴 LE COMPTEUR VIT ICI, EN DEHORS DE LA BOUCLE, POUR SURVIVRE À SON ÉCHEC. Un tour fait plusieurs
  // allers-retours et le fournisseur facture chacun séparément : si le deuxième lève (panne, 4xx terminal,
  // échéance dépassée), une exception nue emporterait avec elle ce que le premier a DÉJÀ coûté. Ni le
  // compteur de la session ni le solde prépayé du workspace ne bougeraient, alors que la facture, elle, est
  // partie. On repasse donc la consommation à l'appelant dans l'erreur, à charge pour lui de l'enregistrer.
  const usage = { tokensIn: 0, tokensOut: 0, coutMicroEur: 0 };
  try {
    return await boucler(input, tour, deps, usage);
  } catch (err) {
    if (usage.coutMicroEur > 0) throw new TourInterrompu(err, usage);
    throw err;
  }
}

/** La boucle elle-même. `usage` est MUTÉ : c'est ce qui permet à `penserTrace` de le rattraper quand la
 *  boucle lève. */
async function boucler(
  input: { agentId: string; tenantId: string; transcript: unknown[]; deadline: number },
  tour: ContexteTour,
  deps: GatewayBrainDeps,
  usage: { tokensIn: number; tokensOut: number; coutMicroEur: number },
): Promise<DecisionTracee> {
  const agent = await deps.contexte(input.tenantId, input.agentId);
  if (!agent) throw new AgentIntrouvable(input.agentId);
  // Le contact est lu UNE FOIS par tour, pas une fois par appel d'outil : il sert au prompt (l'agent doit
  // savoir s'il connaît son interlocuteur) et à l'autorisation de chaque outil.
  const contact = deps.lireContact ? await deps.lireContact(input.tenantId, tour.waId) : null;

  const messages: ChatMessage[] = [
    { role: 'system', content: promptSysteme({ mentionIa: agent.mentionIa, contenu: agent.contenu, contactConnu: contact !== null }) },
    ...versMessages(input.transcript),
  ];
  const exposes = outilsExposes(agent.outilsActifs, agent.sorties);
  const appels: TraceAppel[] = [];
  let appelsFaits = tour.appelsDejaFaits;

  for (let allerRetour = 0; allerRetour < MAX_ALLERS_RETOURS; allerRetour += 1) {
    const reponse = await deps.completer({
      tenantId: input.tenantId,
      modele: agent.modele,
      messages,
      ...(exposes.length > 0 ? { outils: exposes } : {}),
      // `Math.max(0, ...)` et non un plancher d'une seconde : l'échéance du tour est DURE, et une grâce
      // rejouée à chaque aller-retour la rendrait molle.
      signal: AbortSignal.timeout(Math.max(0, input.deadline - (deps.now ? deps.now() : Date.now()))),
    });
    usage.tokensIn += reponse.usage.tokensIn;
    usage.tokensOut += reponse.usage.tokensOut;
    /**
     * 🔴 LA TRACE QUI RÉPOND À « EST-CE QU'ON CACHE DÉJÀ ? » (2026-09-02). Le champ arrivait dans la réponse
     * et personne ne le lisait, donc on ne SAVAIT pas. C'est la mesure la moins chère du chantier IA et elle
     * décide de la suite : la partie constante de chaque appel (prompt système + définitions d'outils) est
     * renvoyée à CHAQUE aller-retour, jusqu'à six par tour. Si elle est servie depuis un cache, il n'y a rien
     * à construire ; sinon, c'est le plus gros levier sur le coût ET sur le débit tenable.
     *
     * Une ligne PAR ALLER-RETOUR et non par tour, délibérément : ce qu'on cherche à voir, c'est justement si
     * la part cachée grimpe au deuxième, le préfixe étant alors déjà connu du fournisseur. Un total par tour
     * moyennerait exactement l'information utile. La file n'ayant jamais tourné en production, le volume de
     * ces lignes est nul aujourd'hui ; à revoir le jour où elle tourne pour de bon.
     */
    // eslint-disable-next-line no-console
    console.log(`agent-cache: agent=${input.agentId} ar=${allerRetour} in=${reponse.usage.tokensIn} caches=${reponse.usage.tokensCaches} part=${reponse.usage.tokensIn > 0 ? Math.round((reponse.usage.tokensCaches / reponse.usage.tokensIn) * 100) : 0}%`);
    // 🔴 LA CONVERSION SE FAIT ICI, ET UNE SEULE FOIS (ancienne dette D1). Le Gateway facture en DOLLARS,
    // tous nos compteurs et tous nos plafonds sont en micro-euros : on additionnait donc des dollars dans
    // une colonne d'euros, et le plafond réglé par le client était comparé à une autre monnaie que la
    // sienne. Le taux est un paramètre COMMERCIAL de la configuration, pas un cours en temps réel.
    usage.coutMicroEur += microEurosDepuisDollars(reponse.usage.coutDollars, deps.tauxEurParDollar ?? 1);

    if (reponse.appelsOutils.length === 0) {
      const texte = reponse.texte ?? '';
      /**
       * 🔴 UN TEXTE QUI PORTE NOS DÉLIMITEURS N'EST PAS UNE RÉPONSE, et il ne sort pas d'ici. Vu en
       * production le 2026-09-08 : le modèle a rendu un faux bloc de résultat d'outil, contenu inventé
       * compris, et le client l'a lu à la place d'une réponse. On ne le renvoie donc pas ; on le signale
       * comme une erreur de protocole, exactement comme les autres, et l'appelant décide (le tour de
       * production escalade, le bac à sable l'affiche).
       *
       * ⚠️ On ne « nettoie » PAS le texte pour le rendre quand même : ce qui reste après retrait des
       * délimiteurs est du JSON inventé, donc une réponse fausse présentée comme une vraie. Mieux vaut
       * passer la main que répondre n'importe quoi sur un contrat d'assurance.
       */
      if (ressembleAUnBlocOutil(texte)) {
        deps.alerter?.(`agent ${input.agentId} : le modèle a rendu un faux bloc de résultat d’outil au lieu d’une réponse`);
        return { texte: null, sortie: SORTIE_PLAFOND, usage, appels, motif: 'reponse_non_conforme' };
      }
      return { texte, sortie: null, usage, appels };
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
  return { texte: null, sortie: SORTIE_PLAFOND, usage, appels, motif: 'plafond_allers_retours' };
}

/**
 * Le cerveau, pour le tour de production : la même boucle, sans la trace.
 *
 * 🔴 LE TOUR EST PRIS SUR L'APPEL, jamais figé ici. Un worker sert toutes les conversations de tous les
 * clients avec UN seul cerveau : un contexte figé au câblage ferait exécuter les outils du contact A dans la
 * conversation de B, et les compteurs de plafond d'une session dans une autre.
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
