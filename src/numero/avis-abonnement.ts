import { DEFAULT_TIMEZONE } from '../settings/store.pg';
import { journaliser } from '../lib/journal';
import type { AvisAbonnement } from '../stripe/abonnements.pg';

/**
 * LES E-MAILS DE L'ABONNEMENT DU NUMÉRO FOURNI (lot 4, livraison B, spec `docs/superpowers/specs/2026-10-06-numero-impaye-design.md`
 * § 4.3), sur le modèle de l'alerte de crédit (`src/repondeur/alerte-credit.ts`) : à chaque admin actif de l'espace, par
 * Resend, à la suspension, 2 jours avant la libération et à la libération.
 *
 * 🔴 UNE FOIS, ET RATÉ = REJOUÉ. L'avis ne se note (`abonnements_numero_avis`) qu'APRÈS un envoi réussi à au moins un
 * admin : un Resend en panne ne perd pas l'e-mail, le balayage suivant le rejoue. Le prix est un doublon si le worker
 * meurt entre l'envoi et la note. Aucun e-mail n'empêche quoi que ce soit (la libération se fait sans lui).
 * Ne lève jamais.
 */

export type AvisMail = Extract<AvisAbonnement, 'suspension_mail' | 'rappel_liberation_mail' | 'liberation_mail'>;

/** Ce que les textes lisent de l'état : `finiLe` dit pourquoi l'espace est suspendu (fini, ou impayé). */
export interface EtatPourAvis {
  abonnementId: string;
  finiLe: Date | null;
  liberationLe: Date | null;
}

export interface DepsAvisAbonnement {
  /** Les adresses des administrateurs actifs de l'espace. */
  admins(tenantId: string): Promise<string[]>;
  /** Le fuseau IANA de l'espace : les dates s'écrivent dans l'heure que le client lit. */
  fuseau(tenantId: string): Promise<string>;
  /** Resend ; `null` = pas configuré sur l'instance (rien ne part, rien ne se note). */
  envoyer: ((m: { to: string; subject: string; text: string; html: string }) => Promise<void>) | null;
  /** La page « Connecter WhatsApp » de la console. */
  pageNumero: string;
  avisDejaParti(abonnementId: string, avis: AvisAbonnement): Promise<boolean>;
  noterAvis(abonnementId: string, avis: AvisAbonnement): Promise<boolean>;
}

export interface AvisAbonnementMail {
  /** `parti` : envoyé (ou personne à prévenir) et noté ; `deja` : noté avant ; `non_envoye` : à rejouer. */
  envoyer(tenantId: string, e: EtatPourAvis, avis: AvisMail): Promise<'parti' | 'deja' | 'non_envoye'>;
}

function dateLisible(d: Date | null, fuseau: string): string {
  if (d === null) return '';
  const o: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' };
  try {
    return d.toLocaleDateString('fr-FR', { ...o, timeZone: fuseau });
  } catch {
    return d.toLocaleDateString('fr-FR', { ...o, timeZone: DEFAULT_TIMEZONE });
  }
}

/** Le texte d'un avis, en clair et en HTML. Le lien et la date sont les seuls éléments variables. */
export function messageAvis(avis: AvisMail, e: EtatPourAvis, pageNumero: string, fuseau: string): { subject: string; text: string; html: string } {
  const date = dateLisible(e.liberationLe, fuseau);
  const envois = 'réponses de l’Inbox, campagnes, scénarios, agents IA et API';
  let subject: string;
  let lignes: string[];
  if (avis === 'suspension_mail' && e.finiLe !== null) {
    subject = 'Votre numéro WhatsApp n’envoie plus de messages';
    lignes = [
      `L’abonnement du numéro WhatsApp fourni à votre espace Messaging Me est terminé : ses envois sont coupés (${envois}).`,
      `Le numéro reste réservé à votre espace jusqu’au ${date}. Pour le garder, réabonnez-vous avant cette date depuis la page « Connecter WhatsApp » de la console, ou demandez-le à Claude : vous retrouvez le même numéro, sans rien reconfigurer.`,
      'Passé cette date, il sera libéré et ne pourra plus être rendu.',
    ];
  } else if (avis === 'suspension_mail') {
    subject = 'Votre numéro WhatsApp n’envoie plus de messages';
    lignes = [
      `Le renouvellement de l’abonnement du numéro WhatsApp fourni à votre espace Messaging Me n’a pas été payé depuis 7 jours : ses envois sont coupés (${envois}).`,
      'Réglez la facture depuis la page « Connecter WhatsApp » de la console (« Gérer mon abonnement »), ou demandez-le à Claude : les envois reprennent dès le paiement.',
    ];
  } else if (avis === 'rappel_liberation_mail') {
    subject = `Votre numéro WhatsApp sera libéré le ${date}`;
    lignes = [
      `L’abonnement du numéro WhatsApp fourni à votre espace Messaging Me est terminé, et le numéro sera libéré le ${date} : il quittera votre espace et ne pourra plus être rendu.`,
      'Pour le garder, réabonnez-vous avant cette date depuis la page « Connecter WhatsApp » de la console, ou demandez-le à Claude.',
    ];
  } else {
    subject = 'Votre numéro WhatsApp a été libéré';
    lignes = [
      'L’abonnement du numéro WhatsApp fourni à votre espace Messaging Me étant terminé depuis 7 jours, le numéro a été libéré : il ne fait plus partie de votre espace et ne peut plus être rendu.',
      'Pour continuer sur WhatsApp, connectez un autre numéro depuis la page « Connecter WhatsApp » de la console.',
    ];
  }
  const corps = ['Bonjour,', ...lignes];
  const text = [...corps, pageNumero].join('\n\n');
  const html = corps.map((l) => `<p>${l}</p>`).join('') + `<p><a href="${pageNumero}">Ouvrir « Connecter WhatsApp »</a></p>`;
  return { subject, text, html };
}

export function creerAvisAbonnement(d: DepsAvisAbonnement): AvisAbonnementMail {
  return {
    async envoyer(tenantId, e, avis) {
      try {
        if (await d.avisDejaParti(e.abonnementId, avis)) return 'deja';
        if (!d.envoyer) {
          journaliser('warn', 'avis_abonnement_sans_resend', { tenantId, avis });
          return 'non_envoye';
        }
        const admins = await d.admins(tenantId);
        if (admins.length === 0) {
          // Personne à prévenir, et il n'y en aura pas davantage au tour suivant : noté, pour ne pas le rejouer.
          journaliser('warn', 'avis_abonnement_sans_admin', { tenantId, avis });
          await d.noterAvis(e.abonnementId, avis);
          return 'parti';
        }
        const m = messageAvis(avis, e, d.pageNumero, await d.fuseau(tenantId));
        let partis = 0;
        // Un envoi par admin, isolé : une adresse refusée ne prive pas les autres.
        for (const to of admins) {
          try {
            await d.envoyer({ to, ...m });
            partis += 1;
          } catch (err) {
            journaliser('error', 'avis_abonnement_non_envoye', { err, tenantId, avis });
          }
        }
        if (partis === 0) return 'non_envoye';
        await d.noterAvis(e.abonnementId, avis);
        journaliser('info', 'avis_abonnement_envoye', { tenantId, avis, admins: partis });
        return 'parti';
      } catch (err) {
        journaliser('error', 'avis_abonnement_impossible', { err, tenantId, avis });
        return 'non_envoye';
      }
    },
  };
}
