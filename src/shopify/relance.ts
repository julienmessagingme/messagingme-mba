import { journaliser } from '../lib/journal';
import { texteDe } from '../lib/erreur';
import { MAX_OPT_IN_SOURCE } from '../api/contacts-upsert';
import { envoyerShopify, type EnvoyerPublic, type IssueEnvoi } from './envoi';
import { avecPrenomDeSecours } from './donnees';
import type { PgShopifyStore } from './store.pg';
import { moisDeParis } from '../offres/compteurs';
import type { Emission } from '../emails-produit/emission';

/**
 * LA RELANCE DES PANIERS ABANDONNÉS (plan 2026-10-21, lot 2), un passage du balayage.
 *
 * 🔴 DANS L'API, PAS DANS LE WORKER, pour la même raison que le traitement des webhooks : l'envoi public n'existe
 * qu'ici. La minuterie d'une minute de `src/index.ts` le lance à chaque copie ; la réclamation pose `relance_le` dans la
 * même écriture (`reclamerPaniersDus`), donc deux copies ne relancent jamais le même panier.
 *
 * 🔴 UNE SEULE RELANCE, et elle peut se perdre (décision de Julien, plan § lot 2) : un envoi qui échoue APRÈS la
 * réclamation laisse le panier réclamé, avec son issue, et il ne repart pas. Pour un message marketing, une relance
 * manquée vaut mieux qu'une relance en double.
 *
 * Le consentement est celui que le marchand a affirmé (la réclamation l'exige) : la fiche naît consentante, avec la
 * source `shopify:<boutique>`, et l'envoi public applique ensuite le STOP, `optInAllows` et les limites de l'offre.
 */

export interface DepsRelance {
  store: Pick<PgShopifyStore, 'reclamerPaniersDus' | 'noterIssuePanier' | 'panierOuvert'>;
  envoyer: EnvoyerPublic;
  /** La limite de contacts atteinte prévient les admins, une fois par mois, comme un message de commande (décision 6). */
  emails: { emettre(e: Emission): Promise<unknown> };
  pageOffre: string;
  maintenant?: () => number;
}

/** Les paniers relancés à chaque passage, au plus, par copie de l'API. Le reste attend le passage suivant. */
export const PANIERS_PAR_PASSAGE = 50;

export type IssueRelance = Exclude<IssueEnvoi, 'en_cours'> | 'donnee_manquante' | 'erreur' | 'ferme';

export interface BilanRelance {
  reclames: number;
  issues: Partial<Record<IssueRelance | 'en_cours', number>>;
}

export async function relancerPaniers(deps: DepsRelance, limite = PANIERS_PAR_PASSAGE): Promise<BilanRelance> {
  const paniers = await deps.store.reclamerPaniersDus(limite);
  const bilan: BilanRelance = { reclames: paniers.length, issues: {} };
  for (const p of paniers) {
    let issue: IssueRelance | 'en_cours';
    try {
      // Un prénom absent prend son mot de secours (facultatif chez Shopify). Le lien ne manque pas (la réclamation l'exige) ;
      // la garde des données manquantes reste pour un modèle qui en demanderait une autre.
      const valeurs = avecPrenomDeSecours({ ...(p.lien ? { checkout_url: p.lien } : {}), ...(p.nom ? { first_name: p.nom } : {}) }, p.langue);
      // Relu juste avant l'envoi : une commande a pu fermer le panier depuis sa réclamation (relecture du lot 2).
      if (!(await deps.store.panierOuvert(p.tenantId, p.jeton))) issue = 'ferme';
      else if (p.variables.some((v) => valeurs[v] === undefined)) issue = 'donnee_manquante';
      else {
        issue = await envoyerShopify(deps.envoyer, {
          tenantId: p.tenantId, cle: `shopify:${p.domaine}:checkouts/abandoned:${p.jeton}`.slice(0, 200),
          nomLigne: 'Shopify · panier abandonné', modele: p.modele, langue: p.langue, variables: p.variables, valeurs,
          telephone: p.telephone, sourceConsentement: `shopify:${p.domaine}`.slice(0, MAX_OPT_IN_SOURCE),
        });
      }
    } catch (err) {
      journaliser('error', 'shopify_relance_en_echec', { tenantId: p.tenantId, erreur: texteDe(err) });
      issue = 'erreur';
    }
    bilan.issues[issue] = (bilan.issues[issue] ?? 0) + 1;
    // `en_cours` : un autre appel tient la même clé d'envoi, il notera l'issue.
    if (issue !== 'en_cours') await deps.store.noterIssuePanier(p.tenantId, p.jeton, issue).catch(() => undefined);
    if (issue === 'limite_contacts') {
      await deps.emails.emettre({
        cle: 'shopify_limite_contacts', tenantId: p.tenantId, a: 'admins',
        occasion: moisDeParis((deps.maintenant ?? Date.now)()), valeurs: { boutique: p.domaine, lien_offre: deps.pageOffre },
      }).catch(() => undefined);
    }
  }
  if (paniers.length === limite) journaliser('info', 'shopify_relance_passage_plein', { reclames: paniers.length });
  return bilan;
}
