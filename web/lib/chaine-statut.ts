import type { Locale } from './locale';
import type { AvertissementPost } from './api-chaine';

/**
 * Le statut d'une publication de chaîne, tel qu'il s'affiche.
 *
 * 🔴 LE STATUT N'EST PAS STOCKÉ CHEZ NOUS. Il est lu en direct chez le fournisseur à chaque affichage, et
 * son vocabulaire lui appartient : il peut ajouter une valeur demain sans nous prévenir. D'où la règle qui
 * gouverne ce module : **une valeur inconnue se rend TELLE QUELLE, en ton neutre, jamais rangée de force
 * dans « Publiée »**. Un client qui lit « Publiée » sur un post refusé attend des conversations qui ne
 * viendront jamais, et ne va pas chercher pourquoi.
 *
 * Un statut ABSENT n'est pas un échec : c'est « non communiqué », gris, comme `mmLiteBadge` le fait déjà
 * dans `format.ts`.
 */

export type TonPublication = 'publie' | 'attente' | 'refus' | 'neutre';

export interface EtatPublication {
  libelle: string;
  ton: TonPublication;
}

/**
 * Les valeurs connues du fournisseur, rangées par ton.
 *
 * ⚠️ Cette table est une CONNAISSANCE PARTIELLE, pas un contrat. Aucune liste exhaustive n'a été mesurée
 * chez le fournisseur : ce qui n'y figure pas tombe dans le ton neutre, ce qui est le comportement voulu et
 * pas un trou à combler au jugé. Les clés sont comparées en minuscules.
 */
const CONNUS: Record<string, TonPublication> = {
  published: 'publie',
  sent: 'publie',
  delivered: 'publie',
  draft: 'attente',
  pending: 'attente',
  queued: 'attente',
  scheduled: 'attente',
  processing: 'attente',
  failed: 'refus',
  rejected: 'refus',
  error: 'refus',
};

const LIBELLES: Record<TonPublication, { fr: string; en: string }> = {
  publie: { fr: 'Publiée', en: 'Published' },
  attente: { fr: 'En attente', en: 'Pending' },
  refus: { fr: 'Refusée', en: 'Rejected' },
  neutre: { fr: 'Non communiqué', en: 'Not reported' },
};

export function etatPublication(statut: string | null | undefined, locale: Locale): EtatPublication {
  const brut = (statut ?? '').trim();
  if (brut === '') {
    const l = LIBELLES.neutre;
    return { libelle: locale === 'en' ? l.en : l.fr, ton: 'neutre' };
  }
  const ton = CONNUS[brut.toLowerCase()];
  if (ton === undefined) {
    // 🔴 Inconnu : on montre le mot du fournisseur, sans le traduire ni l'interpréter. Le client voit qu'il
    // se passe quelque chose qu'on ne sait pas nommer, ce qui est vrai, plutôt qu'un statut rassurant faux.
    return { libelle: brut, ton: 'neutre' };
  }
  const l = LIBELLES[ton];
  return { libelle: locale === 'en' ? l.en : l.fr, ton };
}

/** Les classes de la pastille. Un seul endroit, pour que les quatre tons restent distinguables entre eux. */
export function classesPastille(ton: TonPublication): string {
  switch (ton) {
    case 'publie':
      return 'bg-mint-50 text-mint-600';
    case 'attente':
      return 'bg-gold/10 text-gold';
    case 'refus':
      return 'bg-coral/10 text-coral';
    default:
      return 'bg-ink-100 text-ink-500';
  }
}

/**
 * Ce qu'un avertissement de publication veut dire pour l'utilisateur, et s'il y a quelque chose à faire.
 *
 * 🔴 CES TROIS CAS ARRIVENT AVEC UN 201, jamais avec une erreur : le post est PARTI. Aucun message ne doit
 * inviter à republier, un second envoi irait à toute l'audience. Un seul est actionnable, et c'est
 * précisément celui que rien n'affichait : un bouton mort ne se voit que dans les journaux du serveur.
 */
export function texteAvertissement(a: AvertissementPost, locale: Locale): { texte: string; reparable: boolean } {
  const en = locale === 'en';
  switch (a) {
    case 'automation_non_allumee':
      return {
        texte: en
          ? 'The post went out, but its button starts nothing: the link could not be switched on. Turn it on below.'
          : 'La publication est partie, mais son bouton ne démarre rien : le lien n’a pas pu être allumé. Allume-le ci-dessous.',
        reparable: true,
      };
    case 'trace_manquante':
      return {
        texte: en
          ? 'The post went out but was not recorded: it will not appear in this list.'
          : 'La publication est partie mais n’a pas été enregistrée : elle n’apparaîtra pas dans cette liste.',
        reparable: false,
      };
    default:
      return {
        texte: en
          ? 'The post went out. Channels Me answered something unexpected, so its status cannot be followed here. Do not publish again.'
          : 'La publication est partie. Channels Me a répondu quelque chose d’inattendu, son statut ne peut pas être suivi ici. Ne republie pas.',
        reparable: false,
      };
  }
}
