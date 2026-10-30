import { changerLigneAbonnement, lireAbonnementStripe, lirePrixStripe, StripeError, type LigneAbonnement } from './client';
import { refusDeStripe } from './abonnement';
import type { StripeConfigure } from './paiement';
import { DROITS, PRIX_SIEGE_HT_CENTIMES } from '../offres/offres';
import { journaliser } from '../lib/journal';
import { refus, type Issue } from '../lib/issue';

/**
 * LES SIÈGES PAYANTS DU PRO (spec offres v2, livraison 7). Le Pro comprend 3 utilisateurs ; un siège en ajoute un, 15 € HT
 * par mois ou 150 € HT par an, selon la formule du Pro, en quantité sur son abonnement Stripe.
 *
 * 🔴 STRIPE D'ABORD, LA LIMITE ENSUITE. Un ajout facture le prorata sur le coup et ne s'applique que si cette facture est
 * payée (`pending_if_incomplete`) : un paiement refusé ne change rien, ni chez Stripe ni ici. La limite suit ce que Stripe
 * REND, jamais ce qu'on lui a demandé. Le webhook relit les sièges à chaque modification de l'abonnement (une facture
 * réglée plus tard sur sa page applique le changement en attente).
 *
 * Un retrait se fait sans remboursement ni prorata (spec, choix par défaut), et seulement si les membres actifs tiennent
 * dans ce qui reste : un retrait ne gèle personne.
 */
export interface DepsSieges {
  stripe: StripeConfigure | null;
  /** Les identifiants Stripe des deux prix du siège (`STRIPE_PRIX_SIEGE_MOIS`, `_AN`). Vides = pas en vente. */
  prixSiegeMois: string;
  prixSiegeAn: string;
  payeurAutorise(userId: string): Promise<boolean>;
  /** Le Pro vivant de l'espace (`PgAbonnementsOffreStore.deLEspace`, non fini) ; `null` sans Pro. */
  proVivant(tenantId: string): Promise<{ abonnementId: string; periodicite: 'mois' | 'an' } | null>;
  /** Les membres actifs, invitations en attente comprises (`PgOffresStore.usage`) : ceux que la limite compte. */
  membres(tenantId: string): Promise<number>;
  /** `PgAbonnementsOffreStore.noterSieges` : `null` si le Pro a fini entre-temps. */
  noterSieges(abonnementId: string, sieges: number): Promise<{ tenantId: string } | null>;
  /** L'offre en cache de l'espace : la limite neuve vaut tout de suite, pour l'invitation qui suit. */
  invalider(tenantId: string): void;
  alerter(texte: string): Promise<void>;
}

export const SIEGES_INDISPONIBLES = refus(503, 'Les utilisateurs en plus ne sont pas encore en vente : contactez-nous.', { code: 'sieges_indisponibles' });

/** La récurrence que doit porter chaque prix du siège chez Stripe. */
const RECURRENCE = { mois: 'month', an: 'year' } as const;

/**
 * Le changement demandé : d'où l'écran part (`depuis`, les sièges qu'il a lus) et où il va (`cible`), un siège à la fois
 * (contrôlé par la route). L'état de départ fait refuser une vue périmée : sans lui, une cible absolue lue dans un cache
 * changerait un « Ajouter » en retrait d'un siège payé (Y2 de la relecture).
 */
export interface DemandeSieges {
  depuis: number;
  cible: number;
}

/**
 * Porte les sièges du Pro de l'espace de `depuis` à `cible`. `payeur` est l'utilisateur de la session, jamais une valeur
 * du corps. Rend le nombre de sièges que Stripe a appliqué, relu après la modification.
 */
export async function changerSieges(d: DepsSieges, tenantId: string, demande: DemandeSieges, payeur: string): Promise<Issue<{ sieges: number }>> {
  const { depuis, cible } = demande;
  const s = d.stripe;
  if (s === null || d.prixSiegeMois === '' || d.prixSiegeAn === '') return SIEGES_INDISPONIBLES;
  if (!(await d.payeurAutorise(payeur))) return SIEGES_INDISPONIBLES;
  const pro = await d.proVivant(tenantId);
  if (pro === null) {
    return refus(409, 'Votre espace n’a pas de Pro en cours : les utilisateurs en plus s’ajoutent à un Pro.', { code: 'aucun_pro' });
  }
  const prixSiege = pro.periodicite === 'an' ? d.prixSiegeAn : d.prixSiegeMois;
  const estSiege = (l: LigneAbonnement) => l.prix === d.prixSiegeMois || l.prix === d.prixSiegeAn;
  try {
    const a = await lireAbonnementStripe(s.transport, { cle: s.cle, abonnementId: pro.abonnementId });
    if (a.statut !== 'active' && a.statut !== 'trialing') {
      return refus(409, 'Le paiement de votre formule Pro est en attente : réglez-le depuis la page Offre, puis ajoutez l’utilisateur.', { code: 'pro_en_retard' });
    }
    const lignes = a.lignes.filter(estSiege);
    // Une ligne posée à la main chez Stripe, dans l'autre formule ou en double : on ne devine pas laquelle changer.
    if (lignes.length > 1 || (lignes[0] !== undefined && lignes[0].prix !== prixSiege)) {
      journaliser('error', 'stripe_sieges_a_regler', { tenantId, abonnement: pro.abonnementId, lignes: lignes.map((l) => l.prix) });
      return refus(409, 'Les utilisateurs de votre formule Pro demandent un réglage de notre part : contactez-nous.', { code: 'sieges_a_regler' });
    }
    const ligne = lignes[0];
    const actuel = ligne?.quantite ?? 0;
    // Déjà fait (un second clic, l'autre onglet) : rien à écrire, la base se recale.
    if (cible === actuel) return noter(d, tenantId, pro.abonnementId, actuel, null);
    if (actuel !== depuis) {
      return refus(409, 'Le nombre d’utilisateurs de votre formule Pro a changé entre-temps : rechargez la page, puis recommencez.', { code: 'sieges_changes' });
    }

    if (cible < actuel) {
      const inclus = DROITS.pro.limites.utilisateurs ?? 0;
      const membres = await d.membres(tenantId);
      if (membres > inclus + cible) {
        return refus(409, `Votre espace compte ${membres} membres actifs (invitations en attente comprises) : désactivez-en d’abord, pour tenir dans ${inclus + cible} utilisateurs.`, { code: 'membres_en_trop' });
      }
      await changerLigneAbonnement(s.transport, {
        cle: s.cle, abonnementId: pro.abonnementId, ligne: { id: ligne!.id }, quantite: cible, facturerMaintenant: false,
        idempotence: `siege-${pro.abonnementId}-${actuel}-${cible}-${a.derniereFacture ?? 'aucune'}`,
      });
      return noter(d, tenantId, pro.abonnementId, await relire(s, pro.abonnementId, estSiege), `retiré (${actuel} vers ${cible})`);
    }

    // 🔴 Le prix configuré est relu chez Stripe AVANT d'écrire : 15 € par mois ou 150 € par an, en euros, sinon rien.
    const prix = await lirePrixStripe(s.transport, { cle: s.cle, prix: prixSiege });
    const attendu = PRIX_SIEGE_HT_CENTIMES[pro.periodicite];
    const recurrenceJuste = prix.recurrence?.intervalle === RECURRENCE[pro.periodicite] && prix.recurrence.nombre === 1;
    if (prix.montantCentimes !== attendu || prix.devise !== 'eur' || !recurrenceJuste) {
      journaliser('error', 'stripe_prix_siege_incoherent', {
        tenantId, periodicite: pro.periodicite, prix: prixSiege, attenduCentimes: attendu, luCentimes: prix.montantCentimes,
        devise: prix.devise, recurrence: prix.recurrence,
      });
      return refus(422, 'Les utilisateurs en plus sont momentanément indisponibles : leur tarif est en cours de correction. Réessayez plus tard, ou contactez-nous.',
        { code: 'prix_incoherent' });
    }
    // La clé dit l'état de départ (la quantité ET la dernière facture) : un double clic rejoue la même réponse, alors
    // qu'un nouvel achat après un retrait, même vers la même quantité, en a une autre.
    const r = await changerLigneAbonnement(s.transport, {
      cle: s.cle, abonnementId: pro.abonnementId, ligne: ligne ? { id: ligne.id } : { prix: prixSiege }, quantite: cible,
      facturerMaintenant: true, idempotence: `siege-${pro.abonnementId}-${actuel}-${cible}-${a.derniereFacture ?? 'aucune'}`,
    });
    if (r.enAttente) {
      return refus(402, 'Le paiement de l’utilisateur en plus n’a pas abouti : réglez la facture sur sa page, puis invitez de nouveau le membre.',
        { code: 'paiement_siege_incomplet', url: r.urlFacture });
    }
    // Relu, pas lu dans la réponse : un rejeu idempotent rend la réponse d'un appel plus ancien (Y10 de la relecture).
    return noter(d, tenantId, pro.abonnementId, await relire(s, pro.abonnementId, estSiege), `ajouté (${actuel} vers ${cible})`);
  } catch (err) {
    if (!(err instanceof StripeError)) throw err;
    // La même modification encore en vol chez Stripe (un double clic très rapproché) : à réessayer, pas un refus.
    if (err.code === 'idempotency_key_in_use') {
      return refus(409, 'Un changement des utilisateurs de votre formule Pro est déjà en cours : réessayez dans quelques secondes.', { code: 'sieges_en_cours' });
    }
    return refusDeStripe(err, tenantId, 'sieges');
  }
}

/** Les sièges de l'abonnement, relus chez Stripe. */
async function relire(s: StripeConfigure, abonnementId: string, estSiege: (l: LigneAbonnement) => boolean): Promise<number> {
  return compter((await lireAbonnementStripe(s.transport, { cle: s.cle, abonnementId })).lignes, estSiege);
}

const compter = (lignes: LigneAbonnement[], estSiege: (l: LigneAbonnement) => boolean): number =>
  lignes.filter(estSiege).reduce((n, l) => n + l.quantite, 0);

/**
 * Les sièges d'un abonnement, RELUS chez Stripe, pour le webhook (`customer.subscription.updated`) : toutes les lignes à un
 * prix de siège, quelle que soit leur formule. `null` quand les sièges ne sont pas en vente (rien à relire). Une panne de
 * Stripe lève : le webhook échoue et Stripe rejoue.
 */
export async function siegesChezStripe(
  d: Pick<DepsSieges, 'stripe' | 'prixSiegeMois' | 'prixSiegeAn' | 'alerter'>, abonnementId: string,
): Promise<number | null> {
  const s = d.stripe;
  if (s === null || d.prixSiegeMois === '' || d.prixSiegeAn === '') return null;
  try {
    return await relire(s, abonnementId, (l) => l.prix === d.prixSiegeMois || l.prix === d.prixSiegeAn);
  } catch (err) {
    // 🔴 Un refus DURABLE (4xx hors 429, réponse illisible) ne doit pas bloquer toute la mise à jour du Pro (fin prévue,
    // formule, fin d'essai) : Stripe rejouerait trois jours puis perdrait l'événement (Y8 de la relecture). Les sièges
    // déjà notés restent, Julien est prévenu. Une panne passagère (réseau, 5xx, 429) lève : Stripe rejouera.
    if (!(err instanceof StripeError) || err.status === null || err.status === 429 || err.status >= 500) throw err;
    journaliser('error', 'stripe_sieges_illisibles', { abonnement: abonnementId, status: err.status, code: err.code, err: err.message });
    await d.alerter(`Sièges du Pro ${abonnementId} illisibles chez Stripe (${err.status}) : ceux déjà notés restent, à vérifier.`);
    return null;
  }
}

/** La base suit ce que Stripe a rendu ; l'offre en cache est invalidée, et Julien est prévenu d'un changement. */
async function noter(d: DepsSieges, tenantId: string, abonnementId: string, sieges: number, geste: string | null): Promise<Issue<{ sieges: number }>> {
  await d.noterSieges(abonnementId, sieges);
  d.invalider(tenantId);
  if (geste !== null) await d.alerter(`Utilisateur du Pro ${geste} : espace ${tenantId} (${abonnementId}), ${sieges} payé${sieges > 1 ? 's' : ''} en plus des 3.`);
  return { ok: true, valeur: { sieges } };
}
