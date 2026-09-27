/**
 * Attendre que l'agent de Meta ait fini son tour avant de lui prendre le fil. Pris pendant que l'agent attend la
 * réponse de l'outil, Meta envoie au client un texte générique de passage à un humain ; un message d'opérateur
 * hors tour ne le déclenche pas. Le relais répond donc d'abord, puis le geste attend ici un nouvel écho de
 * l'agent, au plus `FIN_DE_TOUR_MAX_MS`, avant de prendre le fil et d'envoyer. Hypothèse en cours d'essai : le
 * journal dit laquelle des deux fins a eu lieu.
 * Ne lève jamais : une lecture ratée rend `illisible` et le geste continue.
 */
export const FIN_DE_TOUR_MAX_MS = 15_000;
export const FIN_DE_TOUR_PAS_MS = 500;
/**
 * L'écho « d'avant » ne se relève qu'après ce délai, celui où le relais répond à Meta (`DELAI_REPONSE_ENVOI_MS`,
 * égalité tenue par un test) : plus tôt, un texte écrit par l'agent avant d'appeler l'outil serait pris pour la
 * fin de son tour.
 */
export const FIN_DE_TOUR_DEBUT_MS = 1500;

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
        await deps.attendre(FIN_DE_TOUR_DEBUT_MS);
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
