import type { TarifMeta } from '../webhooks/tarif-meta';
import { normaliserCategorie, prixMessage, type CategorieMeta, type GrilleMeta } from './grille';
import type { ConditionsCredit } from './garde';
import type { LigneCredit } from './lignes.pg';

/**
 * L'AJUSTEMENT À L'ACCUSÉ (plan du Crédit WhatsApp, tâche 7) : ce que Meta dit d'un message après l'envoi corrige sa
 * provision. Appelé pour chaque accusé d'un numéro, sur les deux files qui en voient (`webhook`, `webhook-status`), au
 * mieux (`processStatuses`) : un ajustement manqué laisse la provision telle quelle, la régularisation sur les volumes
 * de Meta tranche.
 *
 * - `failed` : rien n'a été livré, Meta ne facture pas, la provision est rendue.
 * - non facturable (fenêtre gratuite d'une publicité, franchise de service, exemption) : rendue, sauf une provision
 *   déjà nulle (un service compté dans la franchise du numéro reste compté, sinon la franchise se viderait).
 * - facturable : corrigée au prix de la grille pour la catégorie que Meta a facturée, dès que ce prix diffère du montant
 *   provisionné (un modèle reclassé, un service que nous avions compté dans la franchise, une catégorie illisible
 *   provisionnée au plus cher, une authentification provisionnée au plus cher des deux tarifs).
 * - `delivered` : la livraison est datée, la régularisation compare par jour de livraison (Meta facture à la livraison).
 * Tout est idempotent en base : un accusé rejoué, ou arrivé dans le désordre, ne bouge rien de plus, et un échec
 * l'emporte sur un tarif traité avant lui.
 */
export interface AccuseCredit {
  wamid: string;
  tarif: TarifMeta | null;
  /** `sent`, `delivered`, `read`, `failed`... ; `null` si l'accusé ne porte pas de statut lisible. */
  statut: string | null;
  /** L'instant de l'accusé selon Meta (ISO), `null` s'il est illisible. */
  livreLe: string | null;
}

export interface AjustementCreditSink {
  ajuster(phoneNumberId: string, a: AccuseCredit): Promise<void>;
}

export interface DepsAjustementCredit {
  lignes: { ligneDuNumero(phoneNumberId: string): Promise<LigneCredit | null> };
  credit: {
    provisionDuWamid(tenantId: string, wamid: string): Promise<{ categorie: CategorieMeta; pays: string | null; montantMicroEur: number; etat: string } | null>;
    rendreParWamid(tenantId: string, wamid: string): Promise<void>;
    corrigerParWamid(tenantId: string, wamid: string, categorie: CategorieMeta, montantMicroEur: number): Promise<void>;
    marquerLivre(tenantId: string, wamid: string, livreLe: Date): Promise<void>;
  };
  grille(): Promise<GrilleMeta | null>;
  conditions(tenantId: string): Promise<ConditionsCredit>;
}

export function creerAjustementCredit(d: DepsAjustementCredit): AjustementCreditSink {
  return {
    async ajuster(phoneNumberId, a) {
      // Un numéro hors de la ligne ne provisionne rien : une lecture en cache, rien d'autre.
      const ligne = await d.lignes.ligneDuNumero(phoneNumberId);
      if (ligne === null) return;
      const tenantId = ligne.tenantId;
      const p = await d.credit.provisionDuWamid(tenantId, a.wamid);
      // Rendue (échec, gratuité déjà lue) : plus rien à corriger ni à dater, un accusé de plus ne coûte que cette lecture.
      if (p === null || p.etat === 'rendu') return;
      if (a.statut === 'failed') {
        await d.credit.rendreParWamid(tenantId, a.wamid);
        return;
      }
      if (a.tarif !== null) {
        const gratuit = a.tarif.facturable === false || a.tarif.type.startsWith('free');
        if (gratuit) {
          if (p.montantMicroEur > 0) await d.credit.rendreParWamid(tenantId, a.wamid);
        } else {
          const categorie = normaliserCategorie(a.tarif.categorie);
          if (p.etat === 'provisionne' && categorie !== null) {
            const grille = await d.grille();
            const prix = grille === null ? null : prixMessage(grille, p.pays, categorie, (await d.conditions(tenantId)).commissionPct, 0, true);
            if (prix !== null && (categorie !== p.categorie || prix !== p.montantMicroEur)) {
              await d.credit.corrigerParWamid(tenantId, a.wamid, categorie, prix);
            }
          }
        }
      }
      if (a.statut === 'delivered' && a.livreLe !== null) await d.credit.marquerLivre(tenantId, a.wamid, new Date(a.livreLe));
    },
  };
}
