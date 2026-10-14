import { journaliser } from '../lib/journal';
import type { EmetteurEmails } from '../emails-produit/emission';
import type { CleEmail } from '../emails-produit/catalogue';
import type { AvisAbonnement } from '../stripe/abonnements.pg';

/**
 * LES E-MAILS DE L'ABONNEMENT DU NUMÉRO FOURNI (lot 4, livraison B, spec `docs/superpowers/specs/2026-10-06-numero-impaye-design.md`
 * § 4.3) : à chaque admin de l'espace, à la suspension, 2 jours avant la libération et à la libération ; et l'annonce de
 * la suite du numéro à la fin prévue du Pro (lot 6, B2b).
 *
 * Depuis le lot 7, ils passent par les e-mails du produit (`src/emails-produit/`) : leurs textes (modèles `numero_*` et
 * `pro_suite_numero`) se modifient dans `/ops`, ils partent aux admins déjà connectés, dans leur langue.
 *
 * 🔴 UNE FOIS, ET RATÉ = REJOUÉ. L'avis se note (`abonnements_numero_avis`) dès que son émission est RÉSERVÉE au journal
 * (migration 0234) : la réservation est un envoi dû, que la file et son balayage portent jusqu'à Resend, avec ses
 * réessais. Une émission qui échoue (base injoignable) ne se note pas : le balayage suivant la rejoue. Aucun e-mail
 * n'empêche quoi que ce soit (la libération se fait sans lui). Ne lève jamais.
 *
 * 🔴 L'OCCASION PORTE LE JOUR, ET C'EST CE QUI LAISSE UNE SECONDE SUSPENSION PRÉVENIR. `abonnements_numero_avis` est
 * effacée EXPRÈS quand l'abonnement redevient actif (`majStatut`) ou au passage en Pro (`oublierAvisDeSuspension`),
 * pour qu'une nouvelle suspension du même abonnement envoie un nouvel e-mail. Le journal, lui, n'oublie rien : une
 * occasion `abonnement:avis` seule aurait fait tomber la seconde suspension en conflit, sans e-mail, et le numéro
 * aurait pu être libéré sans un mot (relecture du lot 7). Le jour garde le dédoublonnage d'un même tour rejoué
 * (`noterAvis` raté, balayage suivant), et deux suspensions d'un même abonnement ne tombent jamais le même jour.
 */

export type AvisMail = Extract<AvisAbonnement, 'suspension_mail' | 'rappel_liberation_mail' | 'liberation_mail'>;

/** Ce que les textes lisent de l'état : `finiLe` dit pourquoi l'espace est suspendu (fini, ou impayé). */
export interface EtatPourAvis {
  abonnementId: string;
  finiLe: Date | null;
  liberationLe: Date | null;
}

export interface DepsAvisAbonnement {
  emettre: EmetteurEmails['emettre'];
  /** La page « Connecter WhatsApp » de la console. */
  pageNumero: string;
  /** La page « Offre » de la console (lot 6, B2b) : là où l'on rend le numéro à la fin du Pro. */
  pageOffre: string;
  avisDejaParti(abonnementId: string, avis: AvisAbonnement): Promise<boolean>;
  noterAvis(abonnementId: string, avis: AvisAbonnement): Promise<boolean>;
  now?: () => Date;
}

export interface AvisAbonnementMail {
  /** `parti` : émis (ou personne à prévenir) et noté ; `deja` : noté avant ; `non_envoye` : à rejouer. */
  envoyer(tenantId: string, e: EtatPourAvis, avis: AvisMail): Promise<'parti' | 'deja' | 'non_envoye'>;
  /**
   * L'annonce de la suite du numéro à la fin prévue du Pro (lot 6, B2b). Rien n'est noté ici : le balayage note
   * l'annonce sur le Pro (`noterAnnonce`) quand elle est `parti`, donc une annonce ratée se rejoue au tour suivant.
   */
  annoncerSuite(tenantId: string, finPrevueLe: Date): Promise<'parti' | 'non_envoye'>;
}

/** Le modèle d'un avis : la suspension a deux textes, selon que l'abonnement est fini ou impayé. */
export function modeleDeLAvis(avis: AvisMail, e: EtatPourAvis): CleEmail {
  if (avis === 'suspension_mail') return e.finiLe !== null ? 'numero_suspendu_fin' : 'numero_suspendu_impaye';
  return avis === 'rappel_liberation_mail' ? 'numero_rappel_liberation' : 'numero_libere';
}

export function creerAvisAbonnement(d: DepsAvisAbonnement): AvisAbonnementMail {
  /** Le jour UTC de l'émission : voir l'en-tête, il distingue deux suspensions d'un même abonnement. */
  const jour = (): string => (d.now ? d.now() : new Date()).toISOString().slice(0, 10);
  return {
    async annoncerSuite(tenantId, finPrevueLe) {
      try {
        await d.emettre({
          cle: 'pro_suite_numero', tenantId, occasion: `fin_pro:${finPrevueLe.toISOString().slice(0, 10)}`,
          valeurs: { date_fin_pro: finPrevueLe.toISOString(), lien_offre: d.pageOffre }, a: 'admins',
        });
        journaliser('info', 'avis_abonnement_emis', { tenantId, avis: 'suite_du_pro' });
        return 'parti';
      } catch (err) {
        journaliser('error', 'avis_abonnement_impossible', { err, tenantId, avis: 'suite_du_pro' });
        return 'non_envoye';
      }
    },
    async envoyer(tenantId, e, avis) {
      try {
        if (await d.avisDejaParti(e.abonnementId, avis)) return 'deja';
        // Personne à prévenir : noté quand même, il n'y aura personne de plus au tour suivant.
        await d.emettre({
          cle: modeleDeLAvis(avis, e), tenantId, occasion: `${e.abonnementId}:${avis}:${jour()}`,
          valeurs: { date_liberation: e.liberationLe?.toISOString() ?? '', lien_numero: d.pageNumero }, a: 'admins',
        });
        await d.noterAvis(e.abonnementId, avis);
        journaliser('info', 'avis_abonnement_emis', { tenantId, avis });
        return 'parti';
      } catch (err) {
        journaliser('error', 'avis_abonnement_impossible', { err, tenantId, avis });
        return 'non_envoye';
      }
    },
  };
}
