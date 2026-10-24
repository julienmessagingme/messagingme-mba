import { journaliser } from '../lib/journal';
import { texteDe } from '../lib/erreur';
import { MAX_OPT_IN_SOURCE } from '../api/contacts-upsert';
import { envoyerMessageShopify, type DepsEnvoiShopify, type IssueShopify } from './envoi';
import { avecPrenomDeSecours } from './donnees';
import type { PgShopifyStore } from './store.pg';
import { moisDeParis, type QuotaModeles } from '../offres/compteurs';
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
 *
 * 🔴 SUR UN NUMÉRO RELIÉ PAR QR CODE (plan 2026-10-23, tâche 5), la relance est un texte qui part par la porte « écrire
 * en premier », comptée dans les messages du mois. Une limite atteinte ne doit consommer AUCUNE relance : les espaces
 * dont le mois est épuisé ne sont pas réclamés (`exclus`), et un panier refusé par la limite pendant le passage est
 * libéré (`libererPanier`) au lieu de recevoir son issue. Il reste dû, et expire normalement à une semaine.
 */

export interface DepsRelance extends DepsEnvoiShopify {
  store: Pick<PgShopifyStore, 'reclamerPaniersDus' | 'noterIssuePanier' | 'panierOuvert' | 'espacesAPaniersDusEnTexte' | 'libererPanier'>;
  /** Le reste des messages du mois, lu avant de réclamer : une ESTIMATION, la porte tranche à l'envoi. */
  quota: Pick<QuotaModeles, 'etatDuMois'>;
  /** La limite de contacts atteinte prévient les admins, une fois par mois, comme un message de commande (décision 6). */
  emails: { emettre(e: Emission): Promise<unknown> };
  pageOffre: string;
  maintenant?: () => number;
}

/** Les paniers relancés à chaque passage, au plus, par copie de l'API. Le reste attend le passage suivant. */
export const PANIERS_PAR_PASSAGE = 50;
/** Les espaces à relance en texte examinés avant de réclamer, au plus : leur reste du mois est lu un par un. */
export const ESPACES_EXAMINES_PAR_PASSAGE = 200;

export type IssueRelance = Exclude<IssueShopify, 'en_cours'> | 'donnee_manquante' | 'erreur' | 'ferme';

export interface BilanRelance {
  reclames: number;
  issues: Partial<Record<IssueRelance | 'en_cours', number>>;
}

/**
 * Les espaces d'un numéro relié par QR code qui n'ont plus de messages du mois, parmi ceux qui ont une relance en texte
 * due. Un espace de l'API n'en fait jamais partie (l'envoi public tranche pour lui, comme avant) ; un reste illisible
 * (`null`) n'exclut pas : la porte refusera, et le panier sera libéré.
 */
async function espacesEpuises(deps: DepsRelance): Promise<string[]> {
  const exclus: string[] = [];
  for (const t of await deps.store.espacesAPaniersDusEnTexte(ESPACES_EXAMINES_PAR_PASSAGE)) {
    if ((await deps.filiere(t)) !== 'application') continue;
    if ((await deps.quota.etatDuMois(t))?.reste === 0) exclus.push(t);
  }
  return exclus;
}

export async function relancerPaniers(deps: DepsRelance, limite = PANIERS_PAR_PASSAGE): Promise<BilanRelance> {
  const paniers = await deps.store.reclamerPaniersDus(limite, await espacesEpuises(deps));
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
        issue = await envoyerMessageShopify(deps, {
          tenantId: p.tenantId, cle: `shopify:${p.domaine}:checkouts/abandoned:${p.jeton}`.slice(0, 200),
          origine: 'shopify_panier', reference: p.jeton, evenement: 'checkout_abandoned',
          nomLigne: 'Shopify · panier abandonné', message: p, valeurs,
          telephone: p.telephone, sourceConsentement: `shopify:${p.domaine}`.slice(0, MAX_OPT_IN_SOURCE),
        });
      }
    } catch (err) {
      journaliser('error', 'shopify_relance_en_echec', { tenantId: p.tenantId, erreur: texteDe(err) });
      issue = 'erreur';
    }
    bilan.issues[issue] = (bilan.issues[issue] ?? 0) + 1;
    if (issue === 'limite_modeles' && p.texte !== null) {
      // 🔴 La porte a refusé le TEXTE faute de messages du mois : rien n'est parti, rien n'est compté, le panier redevient
      // dû. Seule la porte rend cette issue pour un texte ; un modèle refusé par l'envoi public garde la sienne, comme avant.
      await deps.store.libererPanier(p.tenantId, p.jeton).catch((err: unknown) => {
        journaliser('error', 'shopify_relance_non_liberee', { tenantId: p.tenantId, erreur: texteDe(err) });
      });
    } else if (issue !== 'en_cours') {
      // `en_cours` : un autre appel tient la même clé d'envoi, il notera l'issue.
      await deps.store.noterIssuePanier(p.tenantId, p.jeton, issue).catch(() => undefined);
    }
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
