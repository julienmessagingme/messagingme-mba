import { request } from './http';

/**
 * LE BOT D'AIDE DE LA CONSOLE, côté navigateur.
 *
 * 🔴 IL EXPLIQUE ET IL EMMÈNE, IL N'ÉCRIT JAMAIS RIEN. Il répond et il pose des liens vers des écrans. C'est
 * le périmètre tranché par Julien le 2026-09-11, et le seul où une réponse fausse ne coûte qu'un
 * aller-retour.
 */

/** Un écran vers lequel la réponse emmène. `cle` et `href` viennent de la CARTE du serveur, jamais du modèle. */
export interface EcranAide {
  cle: string;
  href: string;
  fr: string;
  en: string;
  chemin: string[];
}

export interface ReponseAide {
  /** `false` = aucune source pertinente. L'écran propose alors le recours humain plutôt qu'une réponse inventée. */
  sait: boolean;
  texte: string;
  /** Les TITRES des fiches utilisées, pour que le client voie d'où sort la réponse. */
  sources: string[];
  ecrans: EcranAide[];
}

/**
 * Pose une question à l'aide.
 *
 * ⚠️ `ecranCourant` est la CLÉ de nav de la page où se trouve la personne, pas son adresse. C'est ce qui rend
 * l'aide contextuelle sans qu'elle ait à préciser où elle est, et c'est une clé pour la même raison que dans
 * les fiches : une adresse vieillit le jour où une page déménage, une clé suit.
 */
export function demanderAide(
  tenantId: string,
  input: {
    question: string;
    ecranCourant: string | null;
    langue: 'fr' | 'en';
    /**
     * Les échanges précédents, du plus ancien au plus récent.
     *
     * 🔴 SANS EUX, UNE QUESTION DE SUITE EST INCOMPRÉHENSIBLE. « Et ensuite ? » ne veut rien dire seul, et
     * afficher un historique auquel le bot répond comme si rien ne précédait serait pire que pas
     * d'historique du tout. Le serveur les borne de son côté, il ne fait pas confiance à ce qui arrive.
     */
    historique?: Array<{ question: string; reponse: string }>;
  },
  signal?: AbortSignal,
): Promise<ReponseAide> {
  return request<ReponseAide>(`/tenants/${tenantId}/aide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
}
