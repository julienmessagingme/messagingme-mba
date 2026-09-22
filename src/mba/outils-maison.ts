import { z } from 'zod';
import type { VariableDeclaree } from '../agent/requetes';
import type { RisqueOutil } from '../agent/catalog';
import { walk } from '../workflow/engine';
import type { WorkflowGraph, WorkflowNode } from '../workflow/graph';
import { CODE_BLOC_RE, summarize } from '../workflow/node-list';

/**
 * LES GESTES DE L'AGENT DE META : ce que le relais exécute lui-même, sans système tiers (spec
 * docs/superpowers/specs/2026-09-21-outils-maison-mba-design.md, § 3).
 *
 * 🔴 DES HANDLERS À PART DE CEUX DES AGENTS IA (`src/agent/outils-maison.ts`), et c'est une garde. Un outil de
 * l'agent de Meta qui atteindrait par erreur un agent IA tomberait sur un handler inconnu, donc un refus, au
 * lieu d'être joué avec une autre forme de paramètres. `tests/mba-outils-maison.test.ts` tient la disjonction.
 *
 * 🔴 LA CIBLE EST FIXÉE PAR L'ADMINISTRATEUR, jamais par le modèle (arbitrage de Julien, 2026-09-21 : « fixé
 * d'avance »). L'agent de Meta ne décide que du MOMENT, et pour un champ, de la valeur.
 */
export const HANDLERS_MAISON_MBA = ['tag_fixe', 'champ_fixe', 'bloc_fixe', 'scenario_fixe'] as const;
export type HandlerMaisonMba = (typeof HANDLERS_MAISON_MBA)[number];

/** Le type d'un outil tel que l'écran le montre. `connecteur` n'est pas un geste maison : il appelle un tiers. */
export type TypeOutilMba = 'tag' | 'champ' | 'bloc' | 'scenario' | 'connecteur';

/**
 * ⚠️ `.strict()` : le `binding` est un jsonb que rien d'autre ne contraint. Une clé en trop veut dire qu'une
 * autre écriture l'a produit, et un outil qu'on ne comprend pas ne s'exécute pas.
 */
export const cibleMaisonSchema = z.discriminatedUnion('handler', [
  z.object({ handler: z.literal('tag_fixe'), tag: z.string().trim().min(1).max(64) }).strict(),
  z.object({
    handler: z.literal('champ_fixe'),
    champ: z.string().trim().min(1).max(64),
    valeurs: z.array(z.string().trim().min(1).max(120)).max(50),
  }).strict(),
  // Un bloc se désigne par son CODE public (`nod_…`), pas par l'identifiant du nœud : c'est le code qui survit à
  // la réécriture du graphe par l'éditeur, et c'est déjà lui que l'API publique vise (`/v1/sends`).
  z.object({ handler: z.literal('bloc_fixe'), workflowId: z.string().uuid(), code: z.string().regex(CODE_BLOC_RE) }).strict(),
  z.object({ handler: z.literal('scenario_fixe'), workflowId: z.string().uuid() }).strict(),
]);
export type CibleMaison = z.infer<typeof cibleMaisonSchema>;
export type CibleChamp = Extract<CibleMaison, { handler: 'champ_fixe' }>;

/** La cible d'un outil relu en base, ou `null` : un outil illisible n'est ni exécuté ni publié. */
export function lireCibleMaison(binding: unknown): CibleMaison | null {
  const r = cibleMaisonSchema.safeParse(binding);
  return r.success ? r.data : null;
}

export function typeDeLaCible(c: CibleMaison): Exclude<TypeOutilMba, 'connecteur'> {
  switch (c.handler) {
    case 'tag_fixe': return 'tag';
    case 'champ_fixe': return 'champ';
    case 'bloc_fixe': return 'bloc';
    case 'scenario_fixe': return 'scenario';
  }
}

/**
 * Le risque déclaré en base. Meta n'a aucun réglage d'autonomie : il sert au journal et à la lecture.
 * ⚠️ Un bloc et un scénario ENVOIENT au client : un message parti ne se rappelle pas, d'où `irreversible`, que
 * l'écran signale.
 */
export const RISQUE_MAISON: Record<HandlerMaisonMba, RisqueOutil> = {
  tag_fixe: 'write',
  champ_fixe: 'write',
  bloc_fixe: 'irreversible',
  scenario_fixe: 'irreversible',
};

/**
 * CE QUE L'AGENT DE META REÇOIT EN CAS DE SUCCÈS (spec § 7).
 *
 * ⚠️ Jamais le nom de l'étiquette ni du champ : ce sont des noms internes, et l'agent les répéterait au client.
 */
export const REPONSE_MAISON: Record<HandlerMaisonMba, string> = {
  tag_fixe: 'C’est fait, c’est enregistré sur la fiche du client. Confirme-le-lui sans citer de nom technique.',
  champ_fixe: 'C’est enregistré sur la fiche du client.',
  // 🔴 « C'EST FAIT » ET « NE RAPPELLE PAS CET OUTIL » (essai réel du 2026-09-22). La première version disait
  // « Engage Me déroule maintenant un parcours… N'écris rien » : l'agent de Meta a rappelé l'outil sept fois dans le
  // même tour, sans jamais conclure. La réponse du tag, qui dit « c'est fait », avait marché du premier coup.
  // 🔴 L'INTERDICTION DE RAPPELER EST BORNÉE AU MESSAGE EN COURS, ET LA SUITE EST PERMISE EN TOUTES LETTRES (essais
  // réels du 2026-09-22, 16 h 32, 16 h 50, 17 h 01). « Ne rappelle pas cet outil. », sans borne, a été lu comme
  // valant pour TOUTE la conversation : l'agent s'en souvenait, ne rappelait plus l'outil quand le client
  // redemandait, et escaladait vers un humain faute d'autre moyen. Un test tient la borne sur chaque réponse.
  bloc_fixe: 'C’est fait : le client vient de recevoir le message prévu. Ne rappelle pas cet outil pour ce message-ci du client, et n’en répète pas le contenu. Si le client le redemande plus tard, rappelle cet outil.',
  scenario_fixe: 'C’est fait : le parcours est lancé et le client en reçoit déjà les messages. Ne rappelle pas cet outil pour ce message-ci du client, et n’écris rien de plus pour cette demande : la conversation te reviendra à la fin du parcours. Si le client le redemande plus tard, rappelle cet outil.',
};

/**
 * Ce que l'agent de Meta lit quand l'envoi n'a pas FINI dans le délai de réponse du relais : il continue sans lui.
 *
 * 🔴 META COUPE UN OUTIL VERS TROIS SECONDES (essai réel du 2026-09-22, mesure en conversation) : notre relais a
 * répondu en 3 005 ms, et l'agent de Meta a traité l'appel comme un échec. Il a passé la main à « un membre de
 * l'équipe » six secondes après que le bloc soit bien parti ; c'est très probablement aussi ce qui lui avait fait
 * RAPPELER sept fois un scénario le matin même. Un envoi prend le fil puis envoie : deux appels à Meta, sa durée
 * n'est pas à nous. Le relais n'attend donc l'envoi que `DELAI_REPONSE_ENVOI_MS` (`src/http/mba-relais.ts`), puis
 * répond ceci, et l'envoi continue. S'il échoue ensuite, l'agent l'apprend par un événement
 * (`src/mba/signaler-echec-tardif.ts`).
 *
 * 🔴 ET L'ENVOI N'A LIEU QU'APRÈS SON TOUR (expérience du 2026-09-22, `src/mba/fin-de-tour.ts`) : prendre le fil
 * pendant que l'agent attend l'outil fait envoyer par Meta « un membre de l'équipe reprendra la conversation ».
 * L'agent est donc invité à annoncer l'envoi en UNE phrase : c'est son écho qui dit que son tour est fini.
 */
export const REPONSE_EN_COURS: Record<'bloc_fixe' | 'scenario_fixe', string> = {
  bloc_fixe: 'C’est parti : le message prévu arrive au client dans quelques secondes. Dis-lui seulement, en une phrase courte, que tu le lui envoies, sans en donner le contenu. Ne rappelle pas cet outil pour ce message-ci du client. Si le client le redemande plus tard, rappelle cet outil.',
  scenario_fixe: 'C’est parti : le parcours démarre dans quelques secondes. Dis seulement au client, en une phrase courte, que tu lances ça pour lui, puis n’écris plus rien pour cette demande : la conversation te reviendra à la fin du parcours. Ne rappelle pas cet outil pour ce message-ci du client. Si le client le redemande plus tard, rappelle cet outil.',
};

export const VARIABLE_VALEUR = 'valeur';

/**
 * Les variables publiées dans le corps de l'outil chez Meta (`corpsOutilMeta` ne garde que les `modele`).
 * Une étiquette fixée ne demande rien ; un champ demande sa valeur, avec la liste permise quand il y en a une.
 */
export function variablesPourMeta(c: CibleMaison): VariableDeclaree[] {
  if (c.handler !== 'champ_fixe') return [];
  return [{
    nom: VARIABLE_VALEUR,
    type: 'string',
    origine: { type: 'modele' },
    requis: true,
    description: 'La valeur à enregistrer, telle que le client l’a donnée.',
    ...(c.valeurs.length > 0 ? { enum: c.valeurs } : {}),
  }];
}

// 🔴 La clé LUE est celle qu'on PUBLIE (`variablesPourMeta`) : écrite en dur ici, un renommage de la variable
// publiée aurait fait refuser toute valeur envoyée par Meta, sans aucune erreur de compilation.
const corpsChampSchema = z.object({ [VARIABLE_VALEUR]: z.string().trim().min(1).max(500) });

/** La valeur que l'agent de Meta envoie pour un champ, validée contre la liste permise. */
export function lireValeurChamp(
  c: CibleChamp, corps: unknown,
): { ok: true; valeur: string } | { ok: false; erreur: string } {
  const r = corpsChampSchema.safeParse(corps);
  if (!r.success) return { ok: false, erreur: 'la valeur à enregistrer manque' };
  const valeur = r.data[VARIABLE_VALEUR];
  if (c.valeurs.length > 0 && !c.valeurs.includes(valeur)) {
    return { ok: false, erreur: `valeur refusée : choisir parmi ${c.valeurs.join(', ')}` };
  }
  return { ok: true, valeur };
}

/** Les envois WhatsApp qu'un bloc seul peut porter. Un formulaire ou une question attendent toujours. */
const ENVOIS = new Set(['sendTemplate', 'sendQuickMessage']);

/** Pourquoi un bloc ne peut pas partir seul, selon ce sur quoi le parcours s'arrêterait. */
const RAISON_REPOS: Record<string, string> = {
  waiting: 'ce bloc attend une réponse du client : utilisez « Lancer un scénario »',
  agent_turn: 'ce bloc passe la main à un agent IA : utilisez « Lancer un scénario »',
  inbox: 'ce bloc remonte la conversation à un humain : utilisez « Lancer un scénario »',
  sleeping: 'ce bloc contient une attente : utilisez « Lancer un scénario »',
  rcs_send: 'ce bloc envoie en RCS, l’agent de Meta parle en WhatsApp',
};

export const BLOC_DISPARU = 'ce bloc n’existe plus dans le scénario';

function noeudDuCode(graph: WorkflowGraph, code: string): WorkflowNode | null {
  return graph.nodes.find((n) => String(n.data.code ?? '') === code) ?? null;
}

/** Le nom d'un bloc tel que l'écran le montre : celui donné par l'utilisateur, sinon son résumé. */
export function nomDuBloc(n: WorkflowNode): string {
  const libre = typeof n.data.name === 'string' ? n.data.name.trim() : '';
  return libre !== '' ? libre : summarize(n.type, n.data) || n.type;
}

/**
 * LE BLOC SEUL (spec 2026-09-21-outils-maison-mba, § 3.3) : le bloc désigné, SANS ce qui le suit, et seulement
 * s'il ne demande pas de réponse.
 *
 * 🔴 VÉRIFIÉ À LA CRÉATION ET À CHAQUE APPEL : le scénario peut avoir été modifié depuis. Le walk est pur et se
 * joue sur un graphe RÉDUIT au seul bloc, qui est aussi ce que le relais envoie : ce qui suit le bloc dans le
 * scénario ne peut donc pas partir. `mbaActif: true` parce que l'agent de Meta est par définition allumé.
 * `modele` dit si tout ce qui part est un modèle, seul envoi possible hors de la fenêtre de 24 h.
 */
export function blocSeul(
  graph: WorkflowGraph, code: string,
): { ok: true; noeudId: string; graphe: WorkflowGraph; modele: boolean } | { ok: false; raison: string } {
  if (!CODE_BLOC_RE.test(code)) return { ok: false, raison: BLOC_DISPARU };
  const noeud = noeudDuCode(graph, code);
  if (!noeud) return { ok: false, raison: BLOC_DISPARU };
  const graphe: WorkflowGraph = { nodes: [noeud], edges: [] };
  const { actions, rest } = walk(graphe, noeud.id, undefined, { mbaActif: true });
  if (rest.status !== 'done') return { ok: false, raison: RAISON_REPOS[rest.status] ?? 'ce bloc ne peut pas partir seul' };
  const envois = actions.filter((a) => ENVOIS.has(a.action.kind));
  if (envois.length === 0) return { ok: false, raison: 'ce bloc n’envoie aucun message' };
  return { ok: true, noeudId: noeud.id, graphe, modele: envois.every((a) => a.action.kind === 'sendTemplate') };
}

/** Le nom du bloc désigné par ce code, ou `null` s'il n'est plus dans le graphe. */
export function nomDuBlocParCode(graph: WorkflowGraph, code: string): string | null {
  const n = noeudDuCode(graph, code);
  return n ? nomDuBloc(n) : null;
}

export interface BlocPropose {
  workflowId: string; scenario: string; code: string; nom: string; type: string; envoyable: boolean; raison: string | null;
}

/**
 * Les blocs PUBLIÉS de l'espace, pour le choix de l'écran : les refusés restent visibles, avec leur raison, pour
 * qu'on comprenne pourquoi un bloc à boutons ne se choisit pas (il se lance avec son scénario).
 */
export function blocsProposables(workflows: readonly { id: string; name: string; graph: WorkflowGraph }[]): BlocPropose[] {
  const sortie: BlocPropose[] = [];
  for (const wf of workflows) {
    for (const n of wf.graph.nodes) {
      const code = String(n.data.code ?? '');
      if (!CODE_BLOC_RE.test(code)) continue;
      const r = blocSeul(wf.graph, code);
      sortie.push({
        workflowId: wf.id, scenario: wf.name, code, nom: nomDuBloc(n), type: n.type,
        envoyable: r.ok, raison: r.ok ? null : r.raison,
      });
    }
  }
  return sortie;
}
