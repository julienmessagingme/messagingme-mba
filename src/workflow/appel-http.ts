import { creerAppelConnecteur, type DepsResolveurHttp } from '../agent/resolvers/http';

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
        signal: AbortSignal.timeout(DELAI_APPEL_HTTP_MS),
      });
      if (r.ok === false) {
        // eslint-disable-next-line no-console
        console.warn(`workflow appelHttp: ${requestId} a echoue pour ${waId} (${r.erreur ?? 'sans raison'}), le champ est vide`);
        return { ok: false, valeur: '' };
      }
      return { ok: true, valeur: valeurPourChamp(r.contenu) };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`workflow appelHttp: ${requestId} a leve pour ${waId}:`, err instanceof Error ? err.message : err);
      return { ok: false, valeur: '' };
    }
  };
}
