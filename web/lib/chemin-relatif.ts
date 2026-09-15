/**
 * LE CHEMIN D'UN APPEL EST RELATIF À L'ADRESSE DU SYSTÈME, ET COLLER L'ADRESSE ENTIÈRE EST LE RÉFLEXE NORMAL.
 *
 * 🔴 CE QUE ÇA RÉPARE, VÉCU PAR JULIEN LE 2026-09-15. Il a collé `https://ai.messagingme.app/api/subscriber/
 * add-tag` dans le champ « Chemin », ce que fait n'importe qui avec une documentation d'API sous les yeux, et
 * l'écran a répondu « chemin refusé : le chemin doit être relatif à l'adresse de base » APRÈS avoir envoyé le
 * formulaire. Le refus est juste, le moment est faux, et le message ne dit pas le geste : l'adresse de base
 * est DÉJÀ déclarée sur le système, il ne faut garder que ce qui la suit.
 *
 * ⚠️ ON NE CORRIGE PAS EN SILENCE. Retirer la base toute seule serait deviner : le client a peut-être collé
 * l'adresse d'un AUTRE hôte, auquel cas il n'y a rien à rattraper et le refus est la bonne réponse. On montre
 * donc ce qu'on propose, et il clique.
 */

export type ProblemeChemin =
  /** Le chemin recommence par l'adresse du système : on sait exactement quoi retirer. */
  | 'base-recopiee'
  /** Le chemin porte une adresse absolue qui n'est PAS celle du système : rien à déduire, c'est un refus. */
  | 'adresse-absolue';

export interface LectureChemin {
  probleme: ProblemeChemin | null;
  /** Le chemin corrigé, quand on sait le déduire sans rien inventer. `null` sinon. */
  propose: string | null;
}

/** ⚠️ MÊME test que le serveur (`src/agent/http-cible.ts`) : un schéma explicite, ou `//hote`. */
const ABSOLUE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Dit si le chemin saisi porte une adresse, et ce qu'il faudrait mettre à la place.
 *
 * ⚠️ `baseUrl` VIDE ou illisible ne fait rien planter : on ne peut alors que constater l'adresse absolue,
 * sans savoir quoi retirer. Un écran qui lève parce qu'un système n'a pas encore d'adresse serait pire.
 */
export function lireChemin(chemin: string, baseUrl: string): LectureChemin {
  const c = chemin.trim();
  if (c === '') return { probleme: null, propose: null };

  const base = baseUrl.trim().replace(/\/+$/, '');
  if (base !== '' && (c === base || c.startsWith(`${base}/`) || c.startsWith(`${base}?`))) {
    const reste = c.slice(base.length);
    // Toujours un `/` en tête : c'est la forme que l'écran montre en exemple, et le serveur retire de toute
    // façon les barres de tête avant de rattacher le chemin sous la base.
    return { probleme: 'base-recopiee', propose: reste === '' ? '/' : reste.startsWith('/') ? reste : `/${reste}` };
  }

  if (ABSOLUE.test(c) || c.startsWith('//')) return { probleme: 'adresse-absolue', propose: null };
  return { probleme: null, propose: null };
}
