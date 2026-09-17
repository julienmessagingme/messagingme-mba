import { describe, it, expect } from 'vitest';
import { etatResume, phraseResumeAbsent, type SourceResume } from './resume-conversation';

/**
 * LES QUATRE CAUSES D'UN RESUME ABSENT, et le fait qu'elles ne se disent pas pareil.
 *
 * 🔴 CE QUE CES TESTS TIENNENT, ET QU'AUCUN AUTRE NE PEUT VOIR. Un ecran qui confondrait ces quatre etats
 * en un vide unique passerait toutes les verifications de rendu : il afficherait quelque chose, sans
 * erreur, et ce quelque chose serait faux. Le seul endroit ou la difference existe, c'est ici.
 */

const base: SourceResume = { texte: null, conversations: 0, analysee: false };
const t = (fr: string) => fr;

describe('etatResume', () => {
  it('aucune conversation -> le champ ne s affiche pas du tout', () => {
    expect(etatResume({ ...base, conversations: 0 })).toBe('aucune-conversation');
  });

  it('la reponse absente (route 503, instance en retard) se comporte comme aucune conversation', () => {
    // La fiche doit s'ouvrir sur une instance qui ne sert pas encore cette route. Le bloc disparait,
    // la fiche reste.
    expect(etatResume(null)).toBe('aucune-conversation');
  });

  it('une conversation, pas encore analysee -> on le dit au PRESENT', () => {
    expect(etatResume({ ...base, conversations: 1, analysee: false })).toBe('pas-analysee');
  });

  it('analysee sans resume -> on le dit au PASSE, c est definitif', () => {
    expect(etatResume({ texte: null, conversations: 2, analysee: true })).toBe('sans-resume');
  });

  it('un resume -> resume', () => {
    expect(etatResume({ texte: 'Elle demandait un devis.', conversations: 1, analysee: true })).toBe('resume');
  });

  /**
   * 🔴 L'ORDRE DES TESTS EST LE SUJET DE CETTE FONCTION. Un contact importe d'un CSV qui n'a jamais rien
   * echange a `analysee: false` comme celui dont l'analyse tourne : commencer par l'analyse promettrait au
   * premier un resume qui ne viendra jamais, faute de quoi que ce soit a analyser.
   */
  it('zero conversation GAGNE sur pas-analysee, jamais l inverse', () => {
    expect(etatResume({ texte: null, conversations: 0, analysee: false })).toBe('aucune-conversation');
  });

  /**
   * Une chaine vide vaut absence, exactement comme a l'ecriture (`src/analysis/store.pg.ts`) : le modele
   * peut rendre le champ vide plutot que de l'omettre, et la laisser passer afficherait un resume blanc,
   * c'est-a-dire un ecran qui a l'air casse sans l'etre.
   */
  it('un resume fait d espaces vaut absence, pas un resume vide', () => {
    expect(etatResume({ texte: '   \n  ', conversations: 1, analysee: true })).toBe('sans-resume');
  });

  /**
   * 🔴 UNE REPONSE TRONQUEE NE DOIT PAS INVENTER UN ETAT, et ce cas a ete trouve en lisant l'attrape-tout
   * d'une spec Playwright, qui rend `{}` pour toute route non simulee. `undefined <= 0` vaut `false` : la
   * premiere ecriture de la garde laissait donc passer un objet vide jusqu'a « pas encore analysee », et la
   * fiche promettait une analyse sur un contact dont elle ne savait rien. Meme situation en vrai qu'en test :
   * une instance en retard, un proxy, une reponse partielle.
   */
  it('🔴 une reponse tronquee se comporte comme aucune conversation, jamais comme pas-analysee', () => {
    expect(etatResume({} as unknown as SourceResume)).toBe('aucune-conversation');
    expect(etatResume({ conversations: NaN } as unknown as SourceResume)).toBe('aucune-conversation');
    expect(etatResume({ conversations: 'deux' } as unknown as SourceResume)).toBe('aucune-conversation');
  });

  it('🔴 un texte qui n est pas une chaine ne devient pas un resume', () => {
    // Meme famille : `{texte: 42}` ne doit pas arriver jusqu'a un `<p>` qui affiche « 42 » en guise de resume.
    expect(etatResume({ texte: 42, conversations: 1, analysee: true } as unknown as SourceResume)).toBe('sans-resume');
  });
});

describe('phraseResumeAbsent', () => {
  it('rend null quand il n y a rien a expliquer', () => {
    // `resume` a un texte a montrer ; `aucune-conversation` n'a meme pas de bloc.
    expect(phraseResumeAbsent('resume', t)).toBeNull();
    expect(phraseResumeAbsent('aucune-conversation', t)).toBeNull();
  });

  /**
   * 🔴 LE TEMPS DU VERBE PORTE TOUTE L'INFORMATION. « n'est pas encore analysee » dit d'attendre,
   * « a ete analysee avant que le resume n'existe » dit de ne pas attendre. Les intervertir enverrait un
   * utilisateur rafraichir une fiche pour un resume qui n'arrivera jamais.
   */
  it('distingue le temporaire du definitif', () => {
    expect(phraseResumeAbsent('pas-analysee', t)).toContain('pas encore');
    expect(phraseResumeAbsent('sans-resume', t)).toContain('avant que');
  });

  /**
   * 🔴 LA PHRASE DE `sans-resume` EST CELLE QUE LA FICHE D'ANALYSE AFFICHE DEPUIS LA MIGRATION 0100, au
   * caractere pres, apostrophe typographique comprise. C'est le seul point ou la reprise se verifie : les
   * deux ecrans l'appellent maintenant, mais rien d'autre n'empeche de la reecrire un jour « au propre »
   * et de creer deux formulations pour un meme etat.
   */
  it('reprend mot pour mot la phrase de la fiche d analyse', () => {
    expect(phraseResumeAbsent('sans-resume', t)).toBe(
      'Pas de résumé : cette conversation a été analysée avant que le résumé n’existe.',
    );
  });

  it('rend l anglais quand le traducteur le demande', () => {
    const en = (_fr: string, a?: string) => a ?? _fr;
    expect(phraseResumeAbsent('sans-resume', en)).toBe('No summary: this conversation was analyzed before summaries existed.');
  });
});
