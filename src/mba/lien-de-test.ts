import { destinataireAgentEvent, evenementLienDeTest, traceReponse, type EvenementAgent } from './evenement';
import { messageDe } from '../lib/erreur';

/**
 * Le mot d'un lien de test reçu pendant que l'agent de Meta tient le fil (essai de Geoffrey du 2026-10-06).
 *
 * Meta donne ce mot à l'agent avant nous, et l'agent commence un tour. Le test lui reprenait le fil aussitôt : coupé en
 * plein tour, l'agent envoyait son message de passage (« Je transmets votre demande… ») 13 à 23 s plus tard, au milieu
 * du scénario, cinq fois en une demi-heure. Décision de Julien : l'agent dit une phrase prévue, puis le test part.
 * On lui envoie donc la consigne, on attend son écho, et on lance seulement alors, hors de son tour.
 *
 * 🔴 L'ATTENTE NE PEUT PAS SE FAIRE DANS LE JOB DU WEBHOOK : l'écho de l'agent arrive dans la même file, groupée par
 * contact (`cleDeContact`), donc derrière ce job. On lance l'attente sans l'attendre, et le job rend la main. Un
 * redémarrage du worker pendant l'attente perd ce démarrage : le testeur rouvre son lien, ce qui vaut mieux que de
 * tenir un emplacement de la file des entrants pendant 40 s.
 */
/** L'agent a mis de 13 à 23 s à répondre au mot du lien, mesuré le 2026-10-06. Au-delà, on lance quand même. */
export const ATTENTE_AGENT_MAX_MS = 40_000;
export const ATTENTE_AGENT_PAS_MS = 500;

export interface DepsApresLAgent {
  numero(tenantId: string): Promise<string | null>;
  envoyer(tenantId: string, phoneNumberId: string, to: string, event: EvenementAgent): Promise<unknown>;
  /** L'identifiant du dernier écho de l'agent, ou `null` : un identifiant qui change dit que l'agent a parlé. */
  dernierMessageDeLAgent(tenantId: string, waId: string): Promise<string | null>;
  attendre(ms: number): Promise<void>;
  maintenant(): number;
  journal(ligne: string): void;
}

/**
 * Rend la promesse de l'attente, pour les tests ; l'appelant de production ne l'attend pas.
 *
 * Une seule attente par contact (relecture du 2026-10-06) : un second clic sur un lien pendant l'attente REMPLACE le
 * lancement prévu, sinon les deux partaient ensemble au premier écho, deux parcours et deux modèles facturés. Le
 * dernier lien cliqué gagne. Et une lecture ratée ne coupe plus l'attente : lancer tout de suite reprendrait le fil à
 * l'agent en plein tour, le défaut même qu'on corrige. Faute de lecture, on attend le délai entier.
 */
export function creerApresLAgent(deps: DepsApresLAgent) {
  const enAttente = new Map<string, () => Promise<void>>();
  return (tenantId: string, waId: string, lancer: () => Promise<void>): Promise<void> => {
    const cle = `${tenantId}:${waId}`;
    if (enAttente.has(cle)) {
      enAttente.set(cle, lancer);
      deps.journal(`lien-de-test: un autre lien pour ${waId} pendant l’attente, il remplace le précédent`);
      return Promise.resolve();
    }
    enAttente.set(cle, lancer);
    return (async () => {
      const debut = deps.maintenant();
      const lire = async (): Promise<{ id: string | null } | null> => {
        try {
          return { id: await deps.dernierMessageDeLAgent(tenantId, waId) };
        } catch (err) {
          deps.journal(`lien-de-test: lecture de l’écho ratée pour ${waId}, on continue d’attendre : ${messageDe(err)}`);
          return null;
        }
      };
      let fin = 'delai';
      const avant = await lire();
      try {
        const pn = await deps.numero(tenantId);
        // Un refus n'arrête rien : l'agent a reçu le mot quoi qu'il arrive, il faut toujours attendre son tour.
        if (pn) deps.journal(`lien-de-test: consigne envoyée à l’agent pour ${waId} : ${traceReponse(await deps.envoyer(tenantId, pn, destinataireAgentEvent(waId), evenementLienDeTest()))}`);
      } catch (err) {
        deps.journal(`lien-de-test: consigne REFUSÉE pour ${waId}, on attend quand même la fin du tour : ${messageDe(err)}`);
      }
      try {
        while (deps.maintenant() - debut < ATTENTE_AGENT_MAX_MS) {
          await deps.attendre(ATTENTE_AGENT_PAS_MS);
          const lu = await lire();
          if (avant !== null && lu !== null && lu.id !== avant.id) { fin = 'reponse'; break; }
        }
      } catch (err) {
        // Jamais sortir sans lancer ni libérer la clé : un contact resterait « en attente » pour toujours.
        fin = `attente interrompue (${messageDe(err)})`;
      }
      deps.journal(`lien-de-test: fin du tour de l’agent pour ${waId} : ${fin} en ${Math.round((deps.maintenant() - debut) / 1000)} s, le test démarre`);
      const aLancer = enAttente.get(cle) ?? lancer;
      enAttente.delete(cle);
      try {
        await aLancer();
      } catch (err) {
        deps.journal(`lien-de-test: le test n’a pas démarré pour ${waId} : ${messageDe(err)}`);
      }
    })();
  };
}
