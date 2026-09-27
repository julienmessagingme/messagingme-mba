import { MetaApiError } from '../meta/errors';
import { messageDe } from '../lib/erreur';

/**
 * Les gestes de contrôle du fil chez Meta (`thread_control`) : le prendre, le rendre, et le rejeu d'une prise
 * refusée pour une raison transitoire. Un module partagé par le worker et l'API : le bouton de l'Inbox doit
 * agir chez Meta, pas seulement écrire notre état local.
 *
 * L'action `take` existe (la documentation en ligne l'énumère, un corpus OpenAPI téléchargé plus ancien l'ignore) :
 * un point de contrat qui décide d'un comportement se relit en ligne. Les deux gestes ne sont pas symétriques :
 * rendre est un droit, prendre un privilège réservé au « configured escalation partner », donc un refus de `take`
 * est un cas normal.
 *
 * Écrire au client ne prend pas le fil à coup sûr : un template de campagne ne le prend pas (l'agent de Meta a
 * répondu après lui). Il faut appeler `take`.
 */

/**
 * Ce dont les gestes ont besoin, satisfait par le worker comme par l'API. Le client MBA promet les deux actes : un
 * client qui n'en porterait qu'un ne compile pas.
 */
export interface ControleDuFilDeps {
  /** Numéro Meta du client. `null` = aucun numéro connecté, il n'y a aucun fil à contrôler. */
  numeros: { getTenantPhoneNumberId(tenantId: string): Promise<string | null> };
  meta: {
    mbaClientForTenant(tenantId: string): Promise<{
      releaseThread(phoneNumberId: string, waId: string): Promise<unknown>;
      takeThread(phoneNumberId: string, waId: string): Promise<unknown>;
    }>;
  };
}

export function creerRendreLeFil(deps: ControleDuFilDeps) {
  /**
   * Rend `true` si Meta a confirmé, `false` s'il n'y avait rien à rendre (aucun numéro). Lève si Meta refuse :
   * l'appelant doit pouvoir refuser d'écrire son état local. Le balayage automatique, best-effort, attrape de
   * son côté.
   */
  return gesteSurLeFil(deps, 'releaseThread');
}

export function creerPrendreLeFil(deps: ControleDuFilDeps) {
  /**
   * Prend le fil à l'agent de Meta sans écrire au client. `true` si Meta a confirmé, `false` sans numéro. Lève
   * si Meta refuse : un opérateur qui croit avoir éteint l'agent de Meta ne surveille plus la conversation.
   */
  return gesteSurLeFil(deps, 'takeThread');
}

/** Le geste commun aux deux jumeaux : le numéro de l'espace (aucun : `false`), puis l'acte chez Meta. */
function gesteSurLeFil(deps: ControleDuFilDeps, acte: 'releaseThread' | 'takeThread') {
  return async (tenantId: string, waId: string): Promise<boolean> => {
    const phoneNumberId = await deps.numeros.getTenantPhoneNumberId(tenantId);
    if (!phoneNumberId) return false;
    const client = await deps.meta.mbaClientForTenant(tenantId);
    await client[acte](phoneNumberId, waId);
    return true;
  };
}

/**
 * L'attente entre les deux tentatives quand Meta ne dit pas combien patienter, et son plafond : dans la boucle
 * d'envoi d'une campagne, une attente longue retarde tous les destinataires suivants.
 */
export const REJEU_ATTENTE_DEFAUT_MS = 500;
export const REJEU_ATTENTE_MAX_MS = 2000;

/**
 * Le nombre total de tentatives : un essai, puis un rejeu. Nommé pour que la boucle et le test « dernière
 * tentative » restent cohérents.
 */
export const REJEU_TENTATIVES = 2;

/** Ce dont le rejeu a besoin, et rien de plus : le geste à rejouer, et une horloge. */
export interface PriseAvecRejeuDeps {
  /** Prend le fil. Lève une `MetaApiError` si Meta refuse ; `false` sans numéro (`creerPrendreLeFil`). */
  prendre(tenantId: string, waId: string): Promise<boolean>;
  /**
   * Attendre, en millisecondes. Injectée et requise : la durée d'attente est un comportement observable, et un
   * test doit pouvoir vérifier le plafond sans dormir.
   */
  attendre(ms: number): Promise<void>;
}

/**
 * Prendre le fil, avec un rejeu et jamais deux.
 *
 * `true` = Meta n'a pas protesté : il nous a rendu le fil, ou il n'y avait aucun numéro connecté (écrire notre
 * état local est alors correct). Ne lève pas : l'appelant décide d'écrire son état local selon ce booléen.
 *
 * Le rejeu existe parce que ce geste, câblé sur `reclaimControl`, devient un appel par destinataire de
 * campagne, et le client MBA ne rejoue rien (il lève sur tout `!res.ok`, 429 compris) : sans lui, un plafond de
 * débit ferait échouer le scénario de tous les destinataires suivants. Un seul rejeu, jamais une boucle : un
 * refus définitif est un cas normal. `classify` (`src/meta/errors.ts`) tranche, comme pour les envois.
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
          console.warn(`reclaimControl: Meta a REFUSÉ de nous rendre le fil pour ${waId} (${tenantId}) après ${tentative + 1} tentative(s), le détenteur ne change pas :`, messageDe(err));
          return false;
        }
        await deps.attendre(Math.min(err.retryAfterMs ?? REJEU_ATTENTE_DEFAUT_MS, REJEU_ATTENTE_MAX_MS));
      }
    }
    return false;
  };
}
