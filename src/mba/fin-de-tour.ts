/**
 * ATTENDRE QUE L'AGENT DE META AIT FINI SON TOUR avant de lui prendre le fil (essai réel du 2026-09-22).
 *
 * 🔴 CE QUI A ÉTÉ MESURÉ. Chaque fois que le relais a pris le fil PENDANT que l'agent de Meta attendait la réponse
 * de l'outil (bloc à 14 h 46, scénario à 15 h 27), Meta a envoyé au client un texte générique, « Merci d'avoir pris
 * contact avec nous. Un membre de l'équipe reprendra la conversation… », qui n'est même pas le message de passage
 * à un humain réglé sur l'agent. Répondre en 1,5 s au lieu de 3 n'y a rien changé. Un message d'opérateur envoyé
 * depuis l'Inbox HORS d'un tour de l'agent, lui, ne le déclenche pas (vérifié par Julien).
 *
 * ⚠️ C'EST UNE EXPÉRIENCE, décidée par Julien : l'hypothèse est « prendre le fil en plein tour de l'agent ». Le
 * relais répond donc d'abord (« dis au client que tu le lui envoies »), puis le geste attend ICI que l'agent ait
 * parlé (un nouvel écho de sa part), au plus `FIN_DE_TOUR_MAX_MS`, et seulement ensuite prend le fil et envoie.
 * Le journal dit laquelle des deux fins a eu lieu : c'est ce que le prochain essai réel doit lire.
 *
 * 🔴 NE LÈVE JAMAIS : une lecture ratée n'est pas une raison de ne pas envoyer ce que l'agent a annoncé. Elle
 * rend `illisible` et le geste continue.
 */
export const FIN_DE_TOUR_MAX_MS = 15_000;
export const FIN_DE_TOUR_PAS_MS = 500;

export type FinDeTour = 'reponse' | 'delai' | 'illisible';

export interface DepsFinDeTour {
  /** `PgInboxStore.dernierMessageDeLAgent` : l'identifiant de son dernier écho, ou `null`. */
  dernierMessageDeLAgent(tenantId: string, waId: string): Promise<string | null>;
  attendre(ms: number): Promise<void>;
  maintenant(): number;
  journal?(ligne: string): void;
}

export function creerAttendreFinDuTour(deps: DepsFinDeTour) {
  return async (tenantId: string, waId: string): Promise<FinDeTour> => {
    const debut = deps.maintenant();
    const fin = await (async (): Promise<FinDeTour> => {
      try {
        const avant = await deps.dernierMessageDeLAgent(tenantId, waId);
        while (deps.maintenant() - debut < FIN_DE_TOUR_MAX_MS) {
          await deps.attendre(FIN_DE_TOUR_PAS_MS);
          if ((await deps.dernierMessageDeLAgent(tenantId, waId)) !== avant) return 'reponse';
        }
        return 'delai';
      } catch {
        return 'illisible';
      }
    })();
    deps.journal?.(`fin-de-tour: ${fin} après ${deps.maintenant() - debut} ms pour ${waId}`);
    return fin;
  };
}
