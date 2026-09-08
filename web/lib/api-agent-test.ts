import { request } from './http';

/**
 * Le bac à sable : parler à son agent avant de l'activer.
 *
 * 🔴 CE QU'IL PROUVE, ET CE QU'IL NE PROUVE PAS. Le vrai cerveau tourne, avec le vrai prompt, les vrais
 * outils exposés et la VRAIE recherche de connaissance : ce que l'agent répond ici est ce qu'il répondra. Les
 * outils à EFFET, eux, sont simulés (il n'y a ni contact, ni conversation, ni parcours), et chaque appel le
 * dit. Un panneau qui laisserait croire qu'un tag a été posé ferait régler la suite sur une prémisse fausse.
 */

export interface TourEssai {
  role: 'user' | 'assistant';
  content: string;
}

/** Un appel d'outil, tel que l'agent l'a décidé. C'est le cœur de ce que le panneau montre. */
export interface AppelTrace {
  nom: string;
  /** Les arguments, tels que le modèle les a produits. Bruts, parce que c'est ce qu'on veut lire. */
  arguments: string;
  status: 'ok' | 'erreur_outil' | 'refuse' | 'timeout' | 'erreur_protocole' | 'budget';
  contenu: unknown;
}

export interface ReponseEssai {
  /** Ce que l'agent dirait au contact. `null` = il ne dit rien (il sort, ou la main lui a échappé). */
  texte: string | null;
  /** La règle d'arrêt empruntée, ou `null` s'il attend une réponse. */
  sortie: string | null;
  /**
   * Pourquoi le tour s'est arrêté, quand la SORTIE seule ne le dit pas.
   *
   * 🔴 `plafond` couvre deux choses très différentes : les allers-retours épuisés, et un modèle qui a rendu
   * une réponse non conforme (il a imité un résultat d'outil au lieu d'en appeler un, et le garde-fou
   * anti-hallucination l'a refusé). Le premier se règle avec un plafond, le second jamais : afficher le
   * même mot dans les deux cas envoie chercher un réglage qui n'existe pas. Vécu par Julien le 2026-09-08.
   *
   * Optionnel : une API plus ancienne que ce champ ne l'envoie pas, et l'écran retombe alors sur la sortie
   * seule plutôt que d'inventer un motif.
   */
  motif?: 'plafond_allers_retours' | 'reponse_non_conforme';
  appels: AppelTrace[];
  usage: { tokensIn: number; tokensOut: number; coutMicroEur: number };
}

export async function essayerAgent(tenantId: string, agentId: string, messages: TourEssai[]): Promise<ReponseEssai> {
  return request<ReponseEssai>(`/tenants/${tenantId}/agents/${agentId}/test`, {
    method: 'POST',
    body: JSON.stringify({ messages }),
  });
}

/**
 * Un essai ARCHIVÉ, tel que l'écran le rejoue.
 *
 * ⚠️ Ses `appels` sont plus MAIGRES que ceux d'un essai frais : on garde le nom et le statut, pas les
 * arguments ni ce que l'outil a rendu. C'est ce qui répond à la question qu'on se pose devant une mauvaise
 * réponse (« a-t-il seulement cherché ? ») sans stocker le contenu d'une base qu'un site tiers a remplie.
 */
export interface EssaiArchive {
  id: string;
  messages: TourEssai[];
  reponse: string | null;
  sortie: string | null;
  appels: Array<{ nom: string; status: string }>;
  tokensEntree: number;
  tokensSortie: number;
  coutMicroEur: number;
  createdAt: string;
}

/**
 * Les derniers essais de cet agent, du plus récent au plus ancien. Liste vide = jamais essayé.
 *
 * ⚠️ Le tableau est vérifié, pas supposé : ce corps vient du réseau, et un serveur qui ne tient pas de trace
 * peut très bien rendre autre chose. Un `undefined` ici casserait l'onglet entier pour une commodité.
 */
export async function listerEssais(tenantId: string, agentId: string): Promise<EssaiArchive[]> {
  const r = await request<{ essais?: EssaiArchive[] }>(`/tenants/${tenantId}/agents/${agentId}/tests`);
  return Array.isArray(r?.essais) ? r.essais : [];
}

/** L'appel a-t-il été SIMULÉ ? Lu défensivement : `contenu` vient du réseau et peut être n'importe quoi. */
export function estSimule(appel: AppelTrace): boolean {
  return (appel.contenu as { simule?: unknown } | null)?.simule === true;
}
