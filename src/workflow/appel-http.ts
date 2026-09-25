import { creerAppelConnecteur, type DepsResolveurHttp } from '../agent/resolvers/http';
import type { JournalAppels } from '../agent/catalog';
import { messageDe } from '../lib/erreur';

/**
 * Le bloc « Appel HTTP » d'un scénario : jouer un appel DÉJÀ mis au point dans Tools > Connecteurs API, et
 * ranger sa réponse dans un champ du contact.
 *
 * 🔴 IL NE DÉCRIT AUCUN APPEL, IL EN DÉSIGNE UN. L'adresse, la méthode, le corps, les variables et surtout le
 * FILTRE DE SORTIE vivent dans la bibliothèque, où ils sont éprouvés une fois pour toutes avec le bouton
 * « Essayer ». Laisser un bloc de scénario décrire son propre appel aurait fait exister une seconde façon de
 * déclarer un appel, avec ses propres gardes à écrire, à tester et à oublier.
 *
 * ⚠️ CE MODULE NE CONTIENT AUCUNE GARDE : elles sont toutes dans `creerAppelConnecteur`, partagé avec l'agent
 * IA et avec la poussée d'un opt-out (source active, filtre de sortie non vide, variables requises, adresse
 * interne, redirection, échéance, corps borné). Il n'y a ici que la traduction « réponse -> valeur de champ ».
 */

/** Plafond de lecture du corps pour ce chemin, en octets. Une réponse plus grosse est refusée, pas tronquée. */
export const MAX_OCTETS_APPEL_HTTP = 64 * 1024;

/**
 * Combien de temps un bloc de scénario attend son connecteur.
 *
 * ⚠️ PLUS COURT QUE CELUI DE L'AGENT IA (30 s) : un contact attend la suite de son parcours, pas une réponse
 * de modèle. Au-delà, le champ est vidé et le parcours continue, ce qui vaut mieux que de laisser quelqu'un
 * devant un silence.
 */
export const DELAI_APPEL_HTTP_MS = 10_000;

/**
 * La réponse d'un connecteur, telle qu'elle se range dans UN champ de contact.
 *
 * 🔴 UN SEUL CHAMP DÉCLARÉ -> SA VALEUR NUE. C'est le cas courant (« la commande est-elle expédiée »), et y
 * ranger `{"statut":"expédiée"}` obligerait le client à écrire une condition sur du JSON, ce que l'écran de
 * condition ne sait pas faire. Plusieurs champs -> l'objet JSON, parce qu'il n'y a alors aucune façon
 * honnête d'en choisir un.
 *
 * ⚠️ Une valeur ABSENTE de la réponse donne une chaîne vide, comme un échec : le scénario branche ensuite sur
 * « le champ est vide », et distinguer « pas reçu » de « reçu vide » demanderait un second champ que personne
 * n'a demandé.
 *
 * PURE, donc testable sans réseau.
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
   * Le journal des appels de connecteur (migration 0142).
   *
   * 🔴 IL MANQUAIT, ET LE CLIENT NE VOYAIT RIEN. Un connecteur qui refusait l'appel d'un scénario ne
   * laissait qu'un `console.warn` sur nos serveurs : le champ du contact restait vide, le parcours
   * continuait, et personne chez le client ne pouvait savoir que son système avait dit non.
   *
   * ⚠️ Optionnel : absent, on retombe exactement sur le comportement d'avant (le `console.warn` seul). Un
   * harnais de test qui ne le câble pas ne change donc rien.
   */
  journalAppels?: JournalAppels;
  /** Le LIBELLÉ de la requête jouée, pour que le journal nomme ce qu'un humain reconnaît. */
  libelleRequete?(tenantId: string, requestId: string): Promise<string | null>;
  /**
   * La projection du contact (`{nom, tags, champs}`), source des variables `champ` et `contact`.
   *
   * ⚠️ Elle est chargée À CHAQUE appel plutôt que portée par le contexte du parcours : le bloc peut suivre un
   * autre bloc qui vient d'écrire un champ, et servir une photo d'avant ferait envoyer l'ancienne valeur.
   */
  projectionContact(tenantId: string, waId: string): Promise<Record<string, unknown> | null>;
}

/**
 * Le câblage du bloc, prêt à être posé sur `WorkflowExecutorDeps.appelHttp`.
 *
 * ⚠️ IL N'ÉCHOUE JAMAIS VERS L'APPELANT : un connecteur en panne rend `{ok: false}`, que l'exécuteur traduit
 * en champ vidé. Laisser l'exception remonter arrêterait le parcours du contact au milieu, pour une panne qui
 * ne le concerne pas.
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
        // ⚠️ AUCUN ARGUMENT DE MODÈLE : un scénario n'a pas de modèle qui décide. Une requête qui déclare une
        // variable `modele` REQUISE sera refusée avec sa raison, ce qui est le bon comportement.
        args: {},
        /**
         * 🔴 UN SCÉNARIO INTÈGRE, ET IL LIT CEUX DE LA REQUÊTE (`champs: null`). Il n'a pas d'outil, donc pas
         * de liste à lui : la requête reste sa seule source, exactement comme avant la migration 0150. Le
         * bloc range ensuite la valeur dans un champ du contact, donc il lit pour de bon.
         */
        lecture: { nature: 'integre', champs: null } as const,
        signal: AbortSignal.timeout(DELAI_APPEL_HTTP_MS),
        journal: deps.journalAppels
          ? {
            journal: deps.journalAppels,
            source: 'scenario',
            // Le libellé si on sait le lire, l'identifiant sinon : une ligne de journal incomplète vaut
            // mieux que pas de ligne, c'est la même doctrine que `workflow_advance_failures`.
            nom: (deps.libelleRequete ? await deps.libelleRequete(tenantId, requestId) : null) ?? requestId,
            // Un scénario n'ouvre aucune session d'agent, et n'a aucun outil : c'est exactement ce que la
            // migration 0142 a rendu possible en relâchant `session_id`.
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
