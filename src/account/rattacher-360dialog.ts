import { journaliser } from '../lib/journal';
import { SecondNumeroRefuseError, TenantConflictError } from './es-store.pg';
import { Cle360dialogRefusee, Erreur360dialog, type Destination360 } from '../meta/config-360dialog';
import type { Fournisseur } from '../meta/credentials';

/**
 * RATTACHER UN NUMÉRO 360DIALOG À UN ESPACE, AVEC LA CLÉ D'API DU NUMÉRO : un seul exemplaire, pour l'exploitation
 * (`POST /ops/360dialog/:tenantId`) et pour l'admin de l'espace (le bouton « Onboard with 360dialog », lot 3,
 * `POST /tenants/:tenantId/360dialog/connecter`). Les deux ne diffèrent que par leur autorité et leur trace.
 *
 * Le numéro et le compte sont LUS chez 360dialog avec la clé, jamais saisis ; les gardes de l'Embedded Signup
 * s'appliquent (un seul numéro par espace, jamais le compte d'un autre espace) ; la clé est chiffrée comme un jeton
 * (`waba_credentials`, fournisseur `360dialog`) ; PUIS notre webhook est posé en GARDANT les destinations existantes.
 * Cet ordre rend la reprise sûre : rejouer après un échec du webhook ne recrée rien, et met à jour notre destination.
 * Rejouer avec une NOUVELLE clé du même numéro la remplace (`saveCredentials` repasse l'état à `active`) : c'est le
 * geste de réparation d'une clé refusée. 🔴 La clé n'est jamais renvoyée ni journalisée.
 */
export interface DepsRattachement360 {
  /** Le client de configuration pour une clé (`Config360dialogClient`). */
  config(cle: string): {
    lireNumero(): Promise<{ phoneNumberId: string; wabaId: string }>;
    poserWebhook(notre: Destination360): Promise<'allume' | 'ajoute' | 'mis_a_jour'>;
  };
  lierNumero(input: { tenantId: string; wabaId: string; phoneNumberId: string; displayPhoneNumber: string | null; verifiedName: string | null }): Promise<void>;
  saveCredentials(wabaId: string, tenantId: string, businessTokenEnc: string, pinEnc: string | null, fournisseur: Fournisseur): Promise<void>;
  chiffrer(cle: string): string;
  /** Notre destination pour ce numéro (`enteteDuNumero`), `null` sans `D360_WEBHOOK_SECRET` : rien n'est rattaché. */
  destination(phoneNumberId: string): Destination360 | null;
}

export type IssueRattachement360 =
  | { ok: true; phoneNumberId: string; wabaId: string; webhook: 'allume' | 'ajoute' | 'mis_a_jour' }
  | { ok: false; statut: 400 | 409 | 502 | 503; error: string; rattache?: { phoneNumberId: string; wabaId: string } };

/** Le contrôle de la clé collée : caractères visibles seuls (un retour à la ligne ferait lever `fetch`, un 500). */
export const CLE_360DIALOG = /^[!-~]{10,200}$/;

export async function rattacher360dialog(
  deps: DepsRattachement360,
  tenantId: string,
  cle: string,
  numeroAffiche: string | null,
): Promise<IssueRattachement360> {
  const config = deps.config(cle);
  let numero: { phoneNumberId: string; wabaId: string };
  try {
    numero = await config.lireNumero();
  } catch (err) {
    if (err instanceof Cle360dialogRefusee) return { ok: false, statut: 400, error: 'clé refusée par 360dialog' };
    // Une réponse illisible, un délai dépassé, une panne réseau : 360dialog n'a pas répondu, rien n'est rattaché.
    return { ok: false, statut: 502, error: err instanceof Erreur360dialog ? err.message : '360dialog ne répond pas pour le moment, réessayez dans un instant' };
  }
  const destination = deps.destination(numero.phoneNumberId);
  if (destination === null) {
    return { ok: false, statut: 503, error: 'la réception des numéros 360dialog n’est pas configurée sur ce serveur' };
  }

  try {
    await deps.lierNumero({
      tenantId, wabaId: numero.wabaId, phoneNumberId: numero.phoneNumberId,
      displayPhoneNumber: numeroAffiche, verifiedName: null,
    });
    await deps.saveCredentials(numero.wabaId, tenantId, deps.chiffrer(cle), null, '360dialog');
  } catch (err) {
    if (err instanceof TenantConflictError) return { ok: false, statut: 409, error: 'ce numéro est déjà relié à un autre espace' };
    if (err instanceof SecondNumeroRefuseError) return { ok: false, statut: 409, error: 'cet espace a déjà un numéro : déconnectez-le d’abord pour en relier un autre' };
    throw err;
  }

  try {
    return { ok: true, ...numero, webhook: await config.poserWebhook(destination) };
  } catch (err) {
    // Le numéro EST rattaché : seule la réception reste à brancher, et le même geste la rebranche sans rien recréer.
    const cause = err instanceof Erreur360dialog || err instanceof Cle360dialogRefusee ? err.message : '360dialog ne répond pas';
    journaliser('error', 'rattachement_360dialog_webhook', { tenantId, ...numero, erreur: cause });
    return { ok: false, statut: 502, error: `numéro relié, mais la réception des messages n’a pas pu être branchée (${cause}) : refaites le même geste`, rattache: numero };
  }
}
