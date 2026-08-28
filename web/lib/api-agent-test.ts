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
  appels: AppelTrace[];
  usage: { tokensIn: number; tokensOut: number; coutMicroEur: number };
}

export async function essayerAgent(tenantId: string, agentId: string, messages: TourEssai[]): Promise<ReponseEssai> {
  return request<ReponseEssai>(`/tenants/${tenantId}/agents/${agentId}/test`, {
    method: 'POST',
    body: JSON.stringify({ messages }),
  });
}

/** L'appel a-t-il été SIMULÉ ? Lu défensivement : `contenu` vient du réseau et peut être n'importe quoi. */
export function estSimule(appel: AppelTrace): boolean {
  return (appel.contenu as { simule?: unknown } | null)?.simule === true;
}
