import { arreterAbonnementNumeroSeul, creerAbonnementNumeroSeul, StripeError, type TransportStripe } from '../stripe/client';
import type { AbonnementNumero, IssueEnregistrement } from '../stripe/abonnements.pg';
import type { RaisonFinOffre } from './abonnements-offre.pg';
import { lienTableauStripe } from '../stripe/liens';
import { journaliser } from '../lib/journal';

/**
 * LE NUMÉRO FOURNI INCLUS DANS LE PRO (lot 6, livraison B2b, tâche 12 du plan
 * `docs/superpowers/plans/2026-10-07-offres-et-limites.md`). Deux moments, appelés par le webhook du Pro
 * (`src/http/credit-stripe.ts`) :
 *  - le PASSAGE EN PRO : l'abonnement du numéro seul s'arrête tout de suite chez Stripe avec un avoir au prorata (le
 *    solde du client, que la facture suivante du Pro consomme) ; les avis de suspension déjà partis sont oubliés (J5 de la
 *    relecture de B1 : sinon la fin d'un Pro suspendrait sans prévenir) et les pauses `numero_suspendu` levées sans
 *    attendre le balayage (J6) ;
 *  - la FIN DU PRO : par résiliation, sans « rendre le numéro », l'abonnement du numéro seul est recréé sur la carte du
 *    Pro (3,50 € HT par mois) ; sinon (impayé, numéro rendu, création impossible), le numéro suit le chemin du lot 4 :
 *    envois coupés, 7 jours, puis libération (décisions de Julien du 2026-10-07 et du 2026-10-08).
 *
 * Pas de planning d'abonnement chez Stripe (ruling de la tâche 9 de B1) : il entrerait en conflit avec la résiliation en
 * fin de période du portail.
 *
 * Les deux sont REJOUABLES : le webhook les rejoue à chaque événement (Stripe rejoue tout événement non acquitté), et
 * chaque écriture chez Stripe porte une clé d'idempotence par abonnement. Un refus de Stripe ne lève jamais (Julien est
 * prévenu) ; une panne de base lève, donc 5xx, et Stripe rejoue.
 */
export interface DepsNumeroInclus {
  /** Stripe sur l'instance : la clé, son mode et le transport ; `null` = pas configuré. */
  stripe: { cle: string; livemode: boolean; transport: TransportStripe } | null;
  /** Le prix du numéro seul (`STRIPE_PRIX_NUMERO`) ; vide = pas en vente. */
  prixNumero: string;
  numero: {
    /** L'abonnement du numéro de l'espace : le vivant s'il y en a un (`PgAbonnementsNumeroStore.deLEspace`). */
    deLEspace(tenantId: string): Promise<AbonnementNumero | null>;
    /** L'espace a-t-il un numéro fourni attribué ? */
    numeroAttribue(tenantId: string): Promise<boolean>;
    /** L'espace envoie-t-il par un AUTRE numéro que son numéro fourni, le sien (`PgAbonnementsNumeroStore.numeroApporte`) ? */
    numeroApporte(tenantId: string): Promise<boolean>;
    /** Enregistre l'abonnement recréé, comme le webhook le ferait (`PgAbonnementsNumeroStore.enregistrer`). */
    enregistrer(a: { tenantId: string; abonnementId: string; livemode: boolean; periodeFin: Date | null }): Promise<IssueEnregistrement>;
    /** J5 : les avis de suspension et le rappel de libération de l'espace, effacés. */
    oublierAvisDeSuspension(tenantId: string): Promise<void>;
    /**
     * Un espace qui n'a JAMAIS eu d'abonnement du numéro (numéro attribué pendant le Pro) reçoit une ligne finie à la fin
     * du Pro, au nom du Pro : sans elle, le lot 4 n'aurait rien à suspendre ni à libérer. `false` : l'espace en avait
     * déjà une (la couverture du Pro y reporte déjà la fin).
     */
    porterLaFinParLePro(a: { tenantId: string; abonnementPro: string; livemode: boolean; finiLe: Date }): Promise<boolean>;
  };
  /** J6 : les campagnes en pause `numero_suspendu` repartent. */
  reprendreCampagnes(tenantId: string): Promise<void>;
  /** L'espace a-t-il un Pro vivant (`PgAbonnementsOffreStore.vivant`) ? */
  proVivant(tenantId: string): Promise<boolean>;
  /** Prévient Julien (Telegram). */
  alerter(texte: string): Promise<void>;
}

const vivant = (a: AbonnementNumero | null): a is AbonnementNumero => a !== null && a.statut !== 'resilie';

/**
 * J2 de la relecture : la MÊME écriture, sous la même clé d'idempotence, est déjà en cours chez Stripe (deux événements du
 * même abonnement traités ensemble). L'autre appel fait le travail : ce n'est pas un refus.
 */
const dejaEnCours = (err: StripeError): boolean => err.code === 'idempotency_key_in_use';

/** Le passage en Pro de l'espace (un Pro enregistré, rejoué compris). Ne lève que sur une panne de base. */
export async function surPassageEnPro(d: DepsNumeroInclus, tenantId: string): Promise<void> {
  await d.numero.oublierAvisDeSuspension(tenantId);
  await d.reprendreCampagnes(tenantId);
  const a = await d.numero.deLEspace(tenantId);
  if (!vivant(a)) return;
  const lien = lienTableauStripe('subscriptions', a.abonnementId, a.livemode);
  if (d.stripe === null || d.stripe.livemode !== a.livemode) {
    await d.alerter(`Espace ${tenantId} passé en Pro : son abonnement du numéro seul ${a.abonnementId} court encore, à arrêter à la main avec un avoir au prorata. ${lien}`);
    return;
  }
  try {
    // J7 de la relecture : une période impayée n'a rien à rendre, l'avoir créditerait un temps jamais payé.
    await arreterAbonnementNumeroSeul(d.stripe.transport, { cle: d.stripe.cle, abonnementId: a.abonnementId, avoir: a.statut !== 'en_retard' });
  } catch (err) {
    if (!(err instanceof StripeError)) throw err;
    if (dejaEnCours(err)) {
      journaliser('info', 'numero_inclus_arret_en_cours', { tenantId, abonnement: a.abonnementId });
      return;
    }
    journaliser('error', 'numero_inclus_arret_impossible', { tenantId, abonnement: a.abonnementId, status: err.status, code: err.code, err: err.message });
    await d.alerter(`Espace ${tenantId} passé en Pro : Stripe refuse d'arrêter son abonnement du numéro seul ${a.abonnementId} (${err.status ?? 'réseau'}${err.code ? `, ${err.code}` : ''}). À arrêter à la main avec un avoir au prorata. ${lien}`);
  }
}

/** Ce que la fin du Pro transmet : lu sur l'événement de Stripe et sur la ligne du Pro. */
export interface FinDuPro {
  tenantId: string;
  abonnementPro: string;
  livemode: boolean;
  raison: RaisonFinOffre;
  finiLe: Date;
  /** Le client a choisi de rendre son numéro à la fin de ce Pro (`abonnements_offre.rendre_numero`). */
  rendreNumero: boolean;
  /**
   * La fin PRÉVUE du Pro, celle que la console, Claude et l'e-mail ont annoncée (`abonnements_offre.fin_prevue_le`) ;
   * `null` si le Pro a été arrêté sans fin programmée.
   */
  finPrevueLe: Date | null;
  /** Le client Stripe de l'abonnement Pro, et la carte qu'il porte (`default_payment_method`) ; `null` s'ils manquent. */
  customerId: string | null;
  carte: string | null;
}

/**
 * `pro_vivant` : un AUTRE Pro de l'espace vit (un rejeu tardif de la fin), il couvre le numéro. `en_cours` : la même
 * création est déjà en cours chez Stripe. `a_verifier` : le numéro seul recréé n'a pas été enregistré, Julien vérifie.
 */
export type IssueFinDuPro = 'sans_numero' | 'pro_vivant' | 'deja_abonne' | 'recree' | 'a_verifier' | 'en_cours' | 'porte';

/**
 * L'écart toléré entre la fin effective du Pro et sa fin prévue pour la tenir pour « à sa fin prévue » : Stripe finit
 * l'abonnement à l'échéance, à quelques minutes près. Au-delà, le Pro a été arrêté tout de suite (R1 de la relecture).
 */
export const MARGE_FIN_PREVUE_MS = 24 * 3_600_000;

/** La fin effective du Pro de l'espace (rejouée comprise). Ne lève que sur une panne de base. */
export async function surFinDuPro(d: DepsNumeroInclus, f: FinDuPro): Promise<IssueFinDuPro> {
  // J5 de la relecture : la fin d'un Pro relivrée après la souscription d'un autre. Le Pro vivant couvre le numéro.
  if (await d.proVivant(f.tenantId)) return 'pro_vivant';
  if (!(await d.numero.numeroAttribue(f.tenantId))) return 'sans_numero';
  if (vivant(await d.numero.deLEspace(f.tenantId))) return 'deja_abonne';

  const porter = async (pourquoi: string | null): Promise<'porte'> => {
    await d.numero.porterLaFinParLePro({ tenantId: f.tenantId, abonnementPro: f.abonnementPro, livemode: f.livemode, finiLe: f.finiLe });
    if (pourquoi !== null) {
      await d.alerter(`Fin du Pro de l'espace ${f.tenantId} (${f.abonnementPro}) : ${pourquoi} Son numéro fourni suit le chemin d'un impayé (envois coupés, 7 jours pour s'abonner au numéro, puis libération).`);
    }
    return 'porte';
  };

  // Impayé, ou numéro rendu : le chemin du lot 4, sans rien demander à Stripe ; rien d'anormal à signaler. Un client qui
  // envoie par SON numéro (J8) n'utilise pas le numéro fourni : il n'est pas recréé, le lot 4 le libère 7 jours après.
  if (f.raison !== 'resiliation' || f.rendreNumero || (await d.numero.numeroApporte(f.tenantId))) return porter(null);
  // 🔴 R1 de la relecture : un Pro arrêté TOUT DE SUITE (Julien à la main, avant une suppression d'espace ou à la demande
  // d'un client) n'a rien annoncé. Prélever le numéro seul sur la carte d'un client qui part serait de l'argent pris à
  // tort : seule une fin à la fin PRÉVUE, donc annoncée, recrée le numéro seul.
  if (f.finPrevueLe === null || f.finiLe.getTime() < f.finPrevueLe.getTime() - MARGE_FIN_PREVUE_MS) {
    return porter('fin immédiate du Pro, sans fin annoncée : le numéro seul n’est pas recréé.');
  }
  const s = d.stripe;
  if (s === null || d.prixNumero === '' || s.livemode !== f.livemode) return porter('Stripe n’est pas configuré pour recréer le numéro seul.');
  if (f.customerId === null || f.carte === null) return porter('le Pro ne porte aucune carte pour le numéro seul.');
  try {
    const neuf = await creerAbonnementNumeroSeul(s.transport, {
      cle: s.cle, tenantId: f.tenantId, customerId: f.customerId, prix: d.prixNumero, carte: f.carte,
      idempotence: `numero-apres-pro-${f.abonnementPro}`,
    });
    const e = await d.numero.enregistrer({ tenantId: f.tenantId, abonnementId: neuf.id, livemode: f.livemode, periodeFin: neuf.periodeFin });
    // J5 de la relecture : un abonnement que l'enregistrement ne prend pas (déjà résilié chez nous, ou un autre numéro
    // seul vivant) ne « reprend » pas : Julien vérifie chez Stripe.
    if (e.etat !== 'enregistre') {
      await d.alerter(`Fin du Pro de l'espace ${f.tenantId} : le numéro seul recréé ${neuf.id} n'a pas été enregistré (${e.etat}). À vérifier chez Stripe. ${lienTableauStripe('subscriptions', neuf.id, f.livemode)}`);
      return 'a_verifier';
    }
    await d.alerter(`Fin du Pro de l'espace ${f.tenantId} : son numéro seul reprend sur la carte du Pro, 3,50 € HT par mois (${neuf.id}).`);
    return 'recree';
  } catch (err) {
    if (!(err instanceof StripeError)) throw err;
    if (dejaEnCours(err)) {
      journaliser('info', 'numero_inclus_creation_en_cours', { tenantId: f.tenantId, pro: f.abonnementPro });
      return 'en_cours';
    }
    journaliser('error', 'numero_inclus_creation_impossible', { tenantId: f.tenantId, pro: f.abonnementPro, status: err.status, code: err.code, err: err.message });
    return porter(`Stripe refuse de recréer le numéro seul (${err.status ?? 'réseau'}${err.code ? `, ${err.code}` : ''}).`);
  }
}
