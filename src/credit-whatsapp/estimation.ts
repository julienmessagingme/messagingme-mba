import { paysDuNumero } from '../crm/phone';
import { prixMessage, type CategorieMeta, type GrilleMeta } from './grille';
import type { ConditionsCredit } from './garde';
import type { LigneCredit } from './lignes.pg';

/**
 * L'ESTIMATION D'UNE CAMPAGNE AU LANCEMENT (plan du Crédit WhatsApp, tâche 6) : ce que ses destinataires en attente sur un
 * étage WhatsApp coûteraient au prix de la grille, commission comprise, comparé au solde. Le lancement est refusé quand
 * il manque du crédit, plutôt que de s'arrêter au milieu ; une campagne programmée est mise en pause à son départ.
 *
 * Une ESTIMATION, comme les modèles du mois : la garde de la fabrique décide à chaque envoi. Le pays se lit sur le numéro
 * (`paysDuNumero`), au plus cher quand il est illisible ; la catégorie sur le modèle de l'étage, ou celui qui ouvre le
 * scénario (`modeleDOuverture`), au plus cher des modèles quand rien ne la dit. Un modèle n'est jamais dans la franchise
 * des messages de service.
 */
export interface GroupeAEstimer {
  /** Un numéro du groupe : ses numéros partagent l'indicatif et les chiffres qui départagent un pays. */
  exemple: string;
  /** Le modèle d'un étage à modèle ; `null` pour un étage à scénario. */
  modele: { name: string; language: string } | null;
  workflowId: string | null;
  n: number;
}

export interface EstimationCredit {
  montantMicroEur: number;
  soldeMicroEur: number;
  /** Ce qu'il faut ajouter au solde pour que tout parte ; 0 si le solde couvre l'estimation. */
  manqueMicroEur: number;
}

export interface DepsEstimation {
  numeroDeLEspace(tenantId: string): Promise<string | null>;
  lignes: { ligneDuNumero(phoneNumberId: string): Promise<LigneCredit | null> };
  conditions(tenantId: string): Promise<ConditionsCredit>;
  grille(): Promise<GrilleMeta | null>;
  categorieDuModele(tenantId: string, name: string, language: string): Promise<CategorieMeta | null>;
  /** Le modèle qui ouvre un scénario ; `null` s'il n'en ouvre aucun. */
  modeleDuScenario(tenantId: string, workflowId: string): Promise<{ name: string; language: string } | null>;
  groupes(campaignId: string, tenantId: string): Promise<GroupeAEstimer[]>;
  solde(tenantId: string): Promise<number>;
}

/** `null` hors de la ligne (ou ligne arrêtée, que la pause `ligne_credit_inactive` dit à l'envoi), en open bar, sans grille. */
export type EstimerCampagne = (tenantId: string, campaignId: string) => Promise<EstimationCredit | null>;

export function creerEstimationCampagne(d: DepsEstimation): EstimerCampagne {
  return async (tenantId, campaignId) => {
    const numero = await d.numeroDeLEspace(tenantId);
    if (numero === null) return null;
    const ligne = await d.lignes.ligneDuNumero(numero);
    if (ligne === null || ligne.tenantId !== tenantId || ligne.arreteeLe !== null) return null;
    const { openBar, commissionPct } = await d.conditions(tenantId);
    if (openBar) return null;
    const grille = await d.grille();
    if (grille === null) return null;

    // Une lecture de catégorie par contenu d'étage, quel que soit le nombre de groupes qui le partagent.
    const categories = new Map<string, Promise<CategorieMeta | null>>();
    const categorieDe = (g: GroupeAEstimer): Promise<CategorieMeta | null> => {
      const cle = g.modele ? `m:${g.modele.name}:${g.modele.language}` : `w:${g.workflowId ?? ''}`;
      let c = categories.get(cle);
      if (c === undefined) {
        c = (async () => {
          const modele = g.modele ?? (g.workflowId === null ? null : await d.modeleDuScenario(tenantId, g.workflowId));
          return modele === null ? null : d.categorieDuModele(tenantId, modele.name, modele.language);
        })();
        categories.set(cle, c);
      }
      return c;
    };

    let montant = 0;
    for (const g of await d.groupes(campaignId, tenantId)) {
      const prix = prixMessage(grille, paysDuNumero(g.exemple), await categorieDe(g), commissionPct);
      if (prix !== null) montant += prix * g.n;
    }
    const solde = await d.solde(tenantId);
    // Rien à envoyer sur WhatsApp ne manque de rien, même sur un solde négatif (une régularisation due).
    return { montantMicroEur: montant, soldeMicroEur: solde, manqueMicroEur: montant > 0 ? Math.max(0, montant - solde) : 0 };
  };
}

/** Des micro-euros en euros, arrondis au centime SUPÉRIEUR : acheter le montant affiché suffit. */
export function eurosManquants(microEur: number): string {
  return (Math.ceil(microEur / 10_000) / 100).toFixed(2).replace('.', ',');
}

/** Un solde en euros, arrondi au centime INFÉRIEUR : jamais plus que ce qui est disponible. */
export function eurosDisponibles(microEur: number): string {
  return (Math.floor(microEur / 10_000) / 100).toFixed(2).replace('.', ',');
}

/** Le refus d'un lancement, le même pour la console et pour Claude. */
export function messageManqueCredit(manqueMicroEur: number): string {
  return `Crédit WhatsApp insuffisant pour cette campagne : il vous manque ${eurosManquants(manqueMicroEur)} € HT. `
    + 'Un administrateur peut recharger le crédit depuis Paramètres > Offre, puis la relancer. Rien n’est parti.';
}
