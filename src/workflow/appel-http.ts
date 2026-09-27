import { creerAppelConnecteur, type DepsResolveurHttp } from '../agent/resolvers/http';
import type { JournalAppels } from '../agent/catalog';
import { messageDe } from '../lib/erreur';

/**
 * Le bloc « Appel HTTP » d'un scénario : jouer un appel déjà mis au point dans Tools > Connecteurs API, et
 * ranger sa réponse dans un champ du contact.
 *
 * Il ne décrit aucun appel, il en désigne un : adresse, méthode, corps, variables et filtre de sortie vivent
 * dans la bibliothèque, éprouvés une fois avec « Essayer ». Une seconde façon de déclarer un appel aurait ses
 * propres gardes à écrire et à oublier.
 *
 * Aucune garde ici : elles sont toutes dans `creerAppelConnecteur`, partagé avec l'agent IA et la poussée
 * d'un opt-out. Il n'y a ici que la traduction « réponse -> valeur de champ ».
 */

/** Plafond de lecture du corps pour ce chemin, en octets. Une réponse plus grosse est refusée, pas tronquée. */
export const MAX_OCTETS_APPEL_HTTP = 64 * 1024;

/**
 * Combien de temps un bloc de scénario attend son connecteur. Plus court que pour l'agent IA (30 s) : un
 * contact attend la suite de son parcours. Au-delà, le champ est vidé et le parcours continue.
 */
export const DELAI_APPEL_HTTP_MS = 10_000;

/**
 * La réponse d'un connecteur, telle qu'elle se range dans un champ de contact. Pure.
 *
 * Un seul champ déclaré -> sa valeur nue, pour qu'une condition puisse la tester (l'écran de condition ne lit
 * pas de JSON). Plusieurs champs -> l'objet JSON, faute de façon honnête d'en choisir un. Une valeur absente
 * donne une chaîne vide, comme un échec : le scénario branche sur « le champ est vide ».
 */
export function valeurPourChamp(contenu: unknown): string {
  if (contenu === null || typeof contenu !== 'object' || Array.isArray(contenu)) return '';
  const entrees = Object.entries(contenu as Record<string, unknown>);
  if (entrees.length === 0) return '';
  if (entrees.length === 1) {
    const v = entrees[0]![1];
    if (v === null || v === undefined) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return JSON.stringify(contenu);
}

/** Ce que le câblage doit fournir en plus des dépendances du connecteur. */
export interface DepsAppelHttpScenario extends DepsResolveurHttp {
  /**
   * Le journal des appels de connecteur, où le client voit qu'un connecteur a refusé l'appel d'un scénario.
   * Optionnel : absent, seul un `console.warn` en garde trace.
   */
  journalAppels?: JournalAppels;
  /** Le libellé de la requête jouée, pour que le journal nomme ce qu'un humain reconnaît. */
  libelleRequete?(tenantId: string, requestId: string): Promise<string | null>;
  /**
   * La projection du contact (`{nom, tags, champs}`), source des variables `champ` et `contact`. Chargée à
   * chaque appel : le bloc peut suivre un bloc qui vient d'écrire un champ, et une photo d'avant enverrait
   * l'ancienne valeur.
   */
  projectionContact(tenantId: string, waId: string): Promise<Record<string, unknown> | null>;
}

/**
 * Le câblage du bloc, prêt à être posé sur `WorkflowExecutorDeps.appelHttp`. N'échoue jamais vers
 * l'appelant : un connecteur en panne rend `{ok: false}` (champ vidé), sans arrêter le parcours au milieu.
 */
export function creerAppelHttpScenario(deps: DepsAppelHttpScenario) {
  const appel = creerAppelConnecteur(deps);
  return async (tenantId: string, waId: string, requestId: string): Promise<{ ok: boolean; valeur: string }> => {
    try {
      const contact = await deps.projectionContact(tenantId, waId);
      const r = await appel({
        tenantId,
        waId,
        contact,
        requestId,
        maxBytes: MAX_OCTETS_APPEL_HTTP,
        // Aucun argument de modèle : un scénario n'a pas de modèle qui décide. Une requête qui déclare une
        // variable `modele` requise sera refusée avec sa raison.
        args: {},
        /**
         * Un scénario intègre la réponse et lit les champs de la requête (`champs: null`) : il n'a pas d'outil,
         * donc pas de liste à lui.
         */
        lecture: { nature: 'integre', champs: null } as const,
        signal: AbortSignal.timeout(DELAI_APPEL_HTTP_MS),
        journal: deps.journalAppels
          ? {
            journal: deps.journalAppels,
            source: 'scenario',
            // Le libellé si on sait le lire, l'identifiant sinon : une ligne de journal incomplète vaut mieux que
            // pas de ligne.
            nom: (deps.libelleRequete ? await deps.libelleRequete(tenantId, requestId) : null) ?? requestId,
            // Un scénario n'ouvre aucune session d'agent et n'a aucun outil.
            sessionId: null,
            toolId: null,
          }
          : null,
      });
      if (r.ok === false) {
        // eslint-disable-next-line no-console
        console.warn(`workflow appelHttp: ${requestId} a echoue pour ${waId} (${r.erreur ?? 'sans raison'}), le champ est vide`);
        return { ok: false, valeur: '' };
      }
      return { ok: true, valeur: valeurPourChamp(r.contenu) };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`workflow appelHttp: ${requestId} a leve pour ${waId}:`, messageDe(err));
      return { ok: false, valeur: '' };
    }
  };
}
