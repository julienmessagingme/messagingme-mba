import type { AvisAbonnement, EtatDeLEspace } from '../stripe/abonnements.pg';
import type { IssueLiberation } from './liberation.pg';
import type { AvisAbonnementMail } from './avis-abonnement';
import { journaliser } from '../lib/journal';

/**
 * LE BALAYAGE DES ABONNEMENTS DU NUMÉRO (lot 4, spec `docs/superpowers/specs/2026-10-06-numero-impaye-design.md`).
 *
 * L'état se CALCULE sur des dates (`src/stripe/etat-abonnement.ts`) : « suspendu » est vrai dès que la date passe, que
 * ce balayage tourne ou non. Il ne fait que les GESTES, chacun une seule fois par abonnement (`abonnements_numero_avis`),
 * et un geste raté se rejoue au tour suivant (l'avis ne se note qu'une fois le geste réussi) :
 *  - à la suspension, l'alerte à Julien (Telegram) et l'e-mail aux admins ;
 *  - 2 jours avant la libération, le rappel aux admins ;
 *  - 7 jours après la fin, la libération (`src/numero/liberation.pg.ts`), puis l'alerte et l'e-mail de libération ;
 *  - la levée des pauses `numero_suspendu` d'un espace qui n'est plus suspendu (un paiement tombé dans la fenêtre du
 *    cache de la garde, ou un événement de Stripe perdu) ; le paiement les lève d'ordinaire lui-même.
 * Rôle principal, toutes les 15 minutes (`src/worker.ts`). Un espace qui échoue n'arrête pas les autres.
 */
export interface DepsBalayageAbonnements {
  /** Les espaces dont l'abonnement COURANT porte un échec, une fin ou une libération récente à annoncer. */
  aSurveiller(): Promise<string[]>;
  /** La SEULE lecture de l'état (`PgAbonnementsNumeroStore.etatDeLEspace`). */
  etat(tenantId: string): Promise<EtatDeLEspace | null>;
  avisDejaParti(abonnementId: string, avis: AvisAbonnement): Promise<boolean>;
  noterAvis(abonnementId: string, avis: AvisAbonnement): Promise<boolean>;
  /** Prévient Julien (Telegram). `false` = rien n'est parti : l'avis ne se note pas, il se rejoue. */
  alerter(texte: string): Promise<boolean>;
  /** Les e-mails aux admins (`src/numero/avis-abonnement.ts`). */
  mails: AvisAbonnementMail;
  /** Libère l'abonnement s'il est dû (`PgLiberationStore.liberer`, DIDWW câblé). Lève sur un échec. */
  liberer(tenantId: string, abonnementId: string): Promise<IssueLiberation>;
  /** Un numéro rendu à la réserve va d'abord à l'abonné qui attend le sien (jamais à `sauf`). */
  servirAbonneEnAttente(sauf: string): Promise<void>;
  /** Les espaces qui ont une campagne en pause `numero_suspendu`. */
  espacesEnPauseSuspension(): Promise<string[]>;
  /** Lève ces pauses (`PgNumeroDelieStore.leverPausesSuspension`). */
  leverPausesSuspension(tenantId: string): Promise<number>;
  maintenant?: () => Date;
}

/** Le rappel aux admins part 2 jours avant la libération (spec § 4.3). */
export const RAPPEL_AVANT_LIBERATION_MS = 2 * 24 * 3_600_000;

const jour = (d: Date | null): string => (d === null ? '?' : d.toISOString().slice(0, 10));

function texteLiberation(tenantId: string, abonnementId: string, r: IssueLiberation | null): string {
  const tete = `Numéro fourni libéré : espace ${tenantId} (${abonnementId})`;
  if (r?.fait === 'resilie') return `${tete}, ${r.numero} résilié chez DIDWW${r.retire ? ' et retiré de l’espace' : ' (jamais relié)'}.`;
  if (r?.fait === 'libre') return `${tete}, ${r.numero} jamais vu de Meta, rendu à la réserve.`;
  return `${tete}.`;
}

/** Un tour du balayage. Rend le nombre de gestes faits. */
export async function balayerAbonnements(d: DepsBalayageAbonnements): Promise<number> {
  const maintenant = d.maintenant ?? (() => new Date());
  let gestes = 0;

  /** Une alerte une seule fois : notée seulement si elle est partie (jaune 6 de la relecture de A). */
  const alerterUneFois = async (abonnementId: string, avis: AvisAbonnement, texte: string): Promise<void> => {
    if (await d.avisDejaParti(abonnementId, avis)) return;
    if (!(await d.alerter(texte))) return;
    await d.noterAvis(abonnementId, avis);
    gestes += 1;
  };
  const envoyerMail = async (tenantId: string, e: EtatDeLEspace, avis: 'suspension_mail' | 'rappel_liberation_mail' | 'liberation_mail') => {
    if ((await d.mails.envoyer(tenantId, e, avis)) === 'parti') gestes += 1;
  };

  for (const tenantId of await d.aSurveiller()) {
    try {
      let e = await d.etat(tenantId);
      if (e === null) continue;
      if (e.etat === 'suspendu') {
        await alerterUneFois(e.abonnementId, 'suspension_telegram', e.finiLe !== null
          ? `Numéro fourni suspendu : espace ${tenantId} (${e.abonnementId}), abonnement terminé. Ses envois sont coupés ; libération le ${jour(e.liberationLe)} sans réabonnement.`
          : `Numéro fourni suspendu : espace ${tenantId} (${e.abonnementId}), impayé depuis 7 jours. Ses envois sont coupés jusqu'au paiement.`);
        await envoyerMail(tenantId, e, 'suspension_mail');
        if (e.finiLe !== null && e.liberationLe !== null
          && maintenant().getTime() >= e.liberationLe.getTime() - RAPPEL_AVANT_LIBERATION_MS) {
          await envoyerMail(tenantId, e, 'rappel_liberation_mail');
        }
      }
      // La libération : fini depuis 7 jours, pas encore libéré. Suspendu, ou « libéré » faute de numéro à couper (rendu
      // par « Abandonner », ou un numéro apporté) : la ligne se libère quand même, le magasin décide de ce qu'il y a à faire.
      let issue: IssueLiberation | null = null;
      if (e.libereLe === null && e.finiLe !== null && e.liberationLe !== null && maintenant() >= e.liberationLe) {
        try {
          issue = await d.liberer(tenantId, e.abonnementId);
        } catch (err) {
          journaliser('error', 'liberation_numero_echec', { tenantId, abonnementId: e.abonnementId, err });
          await d.alerter(`Libération du numéro en échec : espace ${tenantId} (${e.abonnementId}) : ${err instanceof Error ? err.message : String(err)}. Elle se rejoue toutes les 15 minutes.`);
          continue;
        }
        if (issue.fait === 'sans_numero') {
          // Aucun numéro n'a quitté l'espace : rien à annoncer, ni à Julien ni aux admins.
          await d.noterAvis(e.abonnementId, 'liberation_telegram');
          await d.noterAvis(e.abonnementId, 'liberation_mail');
        }
        if (issue.fait !== 'rien') gestes += 1;
        if (issue.fait === 'libre') await d.servirAbonneEnAttente(tenantId);
        e = (await d.etat(tenantId)) ?? e;
      }
      if (e.libereLe !== null) {
        await alerterUneFois(e.abonnementId, 'liberation_telegram', texteLiberation(tenantId, e.abonnementId, issue));
        await envoyerMail(tenantId, e, 'liberation_mail');
      }
    } catch (err) {
      journaliser('error', 'balayage_abonnements_espace', { tenantId, err });
    }
  }
  for (const tenantId of await d.espacesEnPauseSuspension()) {
    try {
      if ((await d.etat(tenantId))?.etat === 'suspendu') continue;
      gestes += await d.leverPausesSuspension(tenantId);
    } catch (err) {
      journaliser('error', 'balayage_abonnements_reprise', { tenantId, err });
    }
  }
  return gestes;
}
