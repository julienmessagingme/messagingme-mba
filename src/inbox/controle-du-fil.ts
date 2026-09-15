import { MetaApiError } from '../meta/errors';

/**
 * LES GESTES DE CONTRÔLE DU FIL chez Meta (`thread_control`) : le PRENDRE, le RENDRE, et depuis le
 * 2026-09-15 le REJEU d'une prise refusée pour une raison transitoire.
 *
 * ⚠️ Ce titre disait « LES DEUX GESTES » : le rejeu est arrivé pour la MÊME raison que les deux premiers,
 * décrite juste en dessous. Il vivait lui aussi dans une fermeture de `buildWorkflowRuntime`, donc sans
 * interface, donc sans aucun test possible sur ses quatre règles.
 *
 * 🔴 POURQUOI CE MODULE EXISTE, ALORS QUE LE GESTE ÉTAIT DÉJÀ ÉCRIT. Il vivait dans une fermeture de
 * `buildWorkflowRuntime`, donc atteignable du WORKER seulement. Le bouton de l'Inbox, lui, est servi par
 * l'API : il ne pouvait pas l'appeler, et il s'est contenté d'écrire notre état local pendant que Meta
 * continuait de croire que NOUS tenions le fil. Vécu le 2026-09-10 : Julien rend la main, écrit sur
 * WhatsApp, et l'agent de Meta reste muet. Recopier la fonction en aurait fait le troisième doublon de cette
 * famille, après le constructeur de composants Meta et la préparation des visuels de carousel, qui ont chacun
 * cassé la production le 2026-08-15.
 *
 * 🔴 CE FICHIER A AFFIRMÉ QU'IL N'Y AVAIT PAS D'ACTION `take`, ET C'ÉTAIT FAUX. Il s'appuyait sur le corpus
 * OpenAPI v1.0.0 téléchargé dans `mba documentation/`, qui n'énumère que `pass` et `release`. Mais un corpus
 * téléchargé est un INSTANTANÉ : Meta a réécrit la page le 2026-08-13 pour ajouter `take`, et la
 * documentation vivante, relue le 2026-09-11, l'énumère bien. Le prix de cette erreur a été exactement le
 * bug signalé par Julien ce soir-là : « Reprendre la main » n'éteignait pas l'agent de Meta, qui se
 * remettait à répondre au message suivant du client.
 *
 * ⚠️ LA LEÇON N'EST PAS « Meta bouge », C'EST QU'UN DOCUMENT TÉLÉCHARGÉ NE VIEILLIT PAS TOUT SEUL. Il a
 * l'air d'une source primaire et il n'en est plus une. Quand un point de contrat décide d'un comportement
 * produit, il se relit EN LIGNE.
 *
 * ⚠️ LES DEUX GESTES NE SONT PAS SYMÉTRIQUES POUR AUTANT. Rendre est un droit (« you must currently hold
 * thread control »), prendre est un PRIVILÈGE : Meta le réserve au « configured escalation partner », notion
 * qu'il ne définit nulle part. Un refus de `take` est donc un cas normal.
 *
 * 🔴 ET « ÉCRIRE PREND LE FIL À COUP SÛR » ÉTAIT ÉCRIT ICI COMME UNE PORTE DE SECOURS UNIVERSELLE. C'EST
 * FAUX, MESURÉ LE 2026-09-14. La mesure du 2026-09-10 qui le fondait portait sur un message de SESSION
 * envoyé depuis l'Inbox ; elle ne vaut pas pour un TEMPLATE de campagne. Chronologie relevée en production
 * sur la campagne « test4 » : template parti à 16:47:47, le contact répond à 16:48:14, et c'est l'agent de
 * Meta qui lui répond à 16:48:24 avant de rendre la main à 16:48:25. Écrire n'avait rien pris du tout.
 *
 * ⚠️ La leçon est la même que pour le corpus OpenAPI juste au-dessus, et elle se répète : une mesure vaut
 * pour LE CAS MESURÉ. Généralisée en règle (« à coup sûr », « dans tous les cas »), elle devient une
 * justification fausse, et une justification fausse est pire qu'aucune parce qu'elle sera recopiée. Celle-ci
 * a servi à ne pas appeler `take` là où il fallait.
 */

/**
 * Ce dont les gestes ont besoin. Interface étroite : satisfaite par le worker comme par l'API.
 *
 * ⚠️ `clientMba` promet les DEUX actes. Un client qui n'en porterait qu'un ne compile pas, ce qui est le
 * seul moyen d'éviter que la moitié du couple reparte vivre ailleurs.
 */
export interface ControleDuFilDeps {
  /** Numéro Meta du client. `null` = aucun numéro connecté, il n'y a aucun fil à contrôler. */
  numeroDuTenant(tenantId: string): Promise<string | null>;
  clientMba(tenantId: string): Promise<{
    releaseThread(phoneNumberId: string, waId: string): Promise<unknown>;
    takeThread(phoneNumberId: string, waId: string): Promise<unknown>;
  }>;
}

export function creerRendreLeFil(deps: ControleDuFilDeps) {
  /**
   * Rend `true` si Meta a CONFIRMÉ, `false` s'il n'y avait rien à rendre (aucun numéro).
   *
   * 🔴 LÈVE si Meta refuse, et c'est délibéré : l'appelant doit pouvoir refuser d'écrire son état local. Un
   * `catch` silencieux ici recréerait exactement le défaut qu'on répare, un état local qui annonce ce que
   * Meta n'a pas fait. Le balayage automatique, lui, est best-effort et attrape de son côté (un fil ne doit
   * pas rester gelé pour toujours à cause d'un hoquet réseau).
   */
  return async function rendreLeFil(tenantId: string, waId: string): Promise<boolean> {
    const phoneNumberId = await deps.numeroDuTenant(tenantId);
    if (!phoneNumberId) return false;
    const client = await deps.clientMba(tenantId);
    await client.releaseThread(phoneNumberId, waId);
    return true;
  };
}

export function creerPrendreLeFil(deps: ControleDuFilDeps) {
  /**
   * Prend le fil à l'agent de Meta SANS écrire au client. Rend `true` si Meta a confirmé, `false` s'il n'y
   * avait aucun numéro connecté.
   *
   * 🔴 LÈVE si Meta refuse, pour la MÊME raison que son jumeau, et elle compte davantage ici : un opérateur
   * qui croit avoir éteint l'agent de Meta ne surveille plus la conversation. Le silence serait le pire des
   * retours.
   */
  return async function prendreLeFil(tenantId: string, waId: string): Promise<boolean> {
    const phoneNumberId = await deps.numeroDuTenant(tenantId);
    if (!phoneNumberId) return false;
    const client = await deps.clientMba(tenantId);
    await client.takeThread(phoneNumberId, waId);
    return true;
  };
}

/**
 * L'attente entre les deux tentatives, quand Meta ne dit pas combien de temps patienter.
 *
 * ⚠️ ET SON PLAFOND, QUI EST LA VRAIE RÈGLE. On est dans la boucle d'envoi d'une campagne : une attente
 * longue ne retarde pas ce destinataire-là, elle retarde TOUS les suivants. Meta peut demander bien plus que
 * deux secondes dans son `Retry-After` ; on ne les lui accorde pas.
 */
export const REJEU_ATTENTE_DEFAUT_MS = 500;
export const REJEU_ATTENTE_MAX_MS = 2000;

/**
 * Le nombre TOTAL de tentatives : un essai, puis un rejeu. Jamais deux rejeux.
 *
 * 🔴 IL EST NOMMÉ PARCE QU'IL ÉTAIT ÉCRIT DEUX FOIS, ET QUE LES DEUX DEVAIENT RESTER COHÉRENTES. La boucle
 * d'origine disait `tentative < 2` et, à l'intérieur, `const derniere = tentative === 1` : porter la boucle à
 * trois n'aurait donné aucun troisième essai, puisque la deuxième se déclarait toujours dernière. C'est le
 * motif « deux constantes de deux endroits dont c'est l'écart qui porte l'invariant », et il a été trouvé en
 * MUTANT le code : la mutation n'a rien cassé, ce qui est le signe que le test ne tenait pas ce qu'on croyait.
 */
export const REJEU_TENTATIVES = 2;

/** Ce dont le rejeu a besoin, et rien de plus : le geste à rejouer, et une horloge. */
export interface PriseAvecRejeuDeps {
  /**
   * Prend le fil. LÈVE une `MetaApiError` si Meta refuse ; rend `false` s'il n'y avait aucun numéro connecté.
   * En production, c'est `creerPrendreLeFil(...)`.
   */
  prendre(tenantId: string, waId: string): Promise<boolean>;
  /**
   * Attendre, en millisecondes. INJECTÉE et requise : c'est une part observable du comportement (combien de
   * temps on patiente), donc un test doit pouvoir la regarder sans dormir. La laisser optionnelle avec
   * `setTimeout` par défaut rendrait la règle du plafond invérifiable, ce qui est précisément l'état dont ce
   * lot sort.
   */
  attendre(ms: number): Promise<void>;
}

/**
 * PRENDRE LE FIL, AVEC UN REJEU ET JAMAIS DEUX.
 *
 * 🔴 IL VIVAIT DANS UNE FERMETURE DE `buildWorkflowRuntime`, donc il n'avait aucune interface, donc personne
 * ne pouvait l'exercer : ses quatre règles (un seul rejeu, la classification du refus, le `Retry-After` de
 * Meta, son plafond) n'étaient vérifiables par aucun test. Il rejoint ici le geste qu'il rejoue, dans le
 * module créé le 2026-09-10 pour exactement ce motif.
 *
 * 🔴 CE QUE `true` SIGNIFIE : « META N'A PAS PROTESTÉ », et cela couvre DEUX cas, ce qui n'était écrit nulle
 * part. Meta nous a rendu le fil, OU il n'y avait aucun numéro connecté, donc aucun agent à qui le prendre.
 * La boucle d'origine jetait le booléen de `prendre` et rendait `true` dans les deux cas : le résultat est
 * juste (sans numéro, écrire notre état local est correct) mais il l'était par accident. Il est désormais
 * énoncé, et l'appelant (`reprendreLeFilPourLApp`) garde exactement le comportement qu'il avait.
 *
 * ⚠️ NE PAS le faire lever. L'appelant décide d'écrire ou non son état local selon ce booléen ; une exception
 * qui remonte ferait échouer tout le parcours là où l'intention est de ne PAS bouger le détenteur.
 *
 * 🔴 POURQUOI UN REJEU EXISTE, relevé en revue le 2026-09-14 et conservé mot pour mot depuis `wiring.ts`, où
 * cette justification était restée ORPHELINE après l'extraction. Ce geste existait pour UN appel à la fois
 * (le bouton « Reprendre la main » de l'Inbox, actionné par un humain). Câblé sur `reclaimControl`, il devient
 * UN APPEL PAR DESTINATAIRE de campagne. Or le client MBA ne rejoue RIEN : son appel lève sur tout
 * `!res.ok`, 429 compris. Sans ce rejeu, un plafond de débit atteint au milieu d'une campagne de masse ferait
 * échouer le scénario de TOUS les destinataires suivants, pour une raison purement transitoire.
 *
 * ⚠️ UN SEUL REJEU, JAMAIS UNE BOUCLE. `take` est un privilège que Meta réserve au « configured escalation
 * partner » : un refus DÉFINITIF (`retryable` faux) est un cas normal, et insister dessus n'ajouterait que
 * des appels inutiles à une campagne déjà en cours. C'est `classify` (`src/meta/errors.ts`) qui tranche, la
 * même règle que pour les envois, importée plutôt que réécrite.
 */
export function creerPrendreLeFilAvecUnRejeu(deps: PriseAvecRejeuDeps) {
  return async function prendreLeFilAvecUnRejeu(tenantId: string, waId: string): Promise<boolean> {
    for (let tentative = 0; tentative < REJEU_TENTATIVES; tentative += 1) {
      try {
        await deps.prendre(tenantId, waId);
        return true;
      } catch (err) {
        const derniere = tentative === REJEU_TENTATIVES - 1;
        const rejouable = err instanceof MetaApiError && err.retryable;
        if (!rejouable || derniere) {
          // eslint-disable-next-line no-console
          console.warn(`reclaimControl: Meta a REFUSÉ de nous rendre le fil pour ${waId} (${tenantId}) après ${tentative + 1} tentative(s), le détenteur ne change pas :`, err instanceof Error ? err.message : err);
          return false;
        }
        await deps.attendre(Math.min(err.retryAfterMs ?? REJEU_ATTENTE_DEFAUT_MS, REJEU_ATTENTE_MAX_MS));
      }
    }
    return false;
  };
}
