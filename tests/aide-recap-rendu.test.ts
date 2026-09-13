import { describe, it, expect, vi } from 'vitest';
import {
  meriteUnModele, gabarit, nombresDuRecap, nombresInventes, creerRedacteurRecap,
} from '../src/aide/recap-rendu';
import type { Recap } from '../src/aide/recap.pg';

/**
 * LE RENDU DU RÉCAP.
 *
 * 🔴 DEUX CHOSES COMPTENT ICI. Le modèle n'est appelé que les jours où il achète quelque chose (le reste du
 * temps, un gabarit dit la même chose gratuitement), et il ne peut PAS écrire un nombre qui n'était pas dans
 * son entrée : un récap qui affiche un chiffre plausible et faux est pire que pas de récap, parce que les
 * gens agissent dessus.
 */
function recap(o: Partial<Recap> = {}): Recap {
  return {
    jour: '2026-09-12',
    conversations: 42,
    conversationsNouvelles: 6,
    conversationsAnalysees: 25,
    messagesEntrants: 128,
    messagesSortants: 96,
    themes: [{ topic: 'retard de livraison', n: 12 }],
    semainePrecedente: { conversations: 40, messagesEntrants: 130, themes: ['retard de livraison'] },
    ...o,
  };
}

describe('mérite-t-il un modèle ?', () => {
  it('sans écart notable, aucun appel de modèle', () => {
    expect(meriteUnModele(recap())).toBe(false);
  });

  it('un volume qui double mérite une phrase', () => {
    expect(meriteUnModele(recap({ conversations: 84 }))).toBe(true);
  });

  it('un effondrement aussi : l écart compte dans les deux sens', () => {
    expect(meriteUnModele(recap({ conversations: 10 }))).toBe(true);
  });

  it('un volume de messages qui s envole compte, même à conversations stables', () => {
    expect(meriteUnModele(recap({ messagesEntrants: 400 }))).toBe(true);
  });

  /**
   * ⚠️ LE PLANCHER. Sans lui, passer de 1 à 3 conversations est une hausse de 200 % : on paierait un appel
   * de modèle pour commenter le bruit d'un petit espace, tous les jours.
   */
  it('⚠️ trois conversations contre une ne méritent rien : c est du bruit', () => {
    expect(meriteUnModele(recap({
      conversations: 3, messagesEntrants: 4, themes: [],
      semainePrecedente: { conversations: 1, messagesEntrants: 2, themes: ['sav'] },
    }))).toBe(false);
  });

  it('un sujet absent la semaine d avant mérite une phrase', () => {
    expect(meriteUnModele(recap({
      themes: [{ topic: 'panne du site', n: 3 }],
    }))).toBe(true);
  });

  /**
   * ⚠️ ...MAIS PAS QUAND LA SEMAINE D'AVANT N'A AUCUN SUJET. Tout serait alors « nouveau », et un espace qui
   * vient d'activer l'analyse paierait un appel de modèle chaque jour pour l'apprendre.
   */
  it('⚠️ un sujet n est pas « nouveau » quand la semaine d avant n en a aucun', () => {
    expect(meriteUnModele(recap({
      themes: [{ topic: 'panne du site', n: 3 }],
      semainePrecedente: { conversations: 40, messagesEntrants: 130, themes: [] },
    }))).toBe(false);
  });

  it('un jour sans aucune conversation ne mérite rien : il n y a rien à raconter', () => {
    expect(meriteUnModele(recap({
      conversations: 0, messagesEntrants: 0, messagesSortants: 0, conversationsAnalysees: 0, themes: [],
    }))).toBe(false);
  });
});

describe('le gabarit', () => {
  /**
   * 🔴 LE GABARIT DIT CE QU'IL NE SAIT PAS. L'analyse ne tourne qu'à l'inactivité : sans cette phrase, il
   * sous-déclare en silence et quelqu'un conclura que le sujet dont il se préoccupe n'est pas remonté.
   */
  it('🔴 il écrit combien de conversations n ont pas encore de thème', () => {
    expect(gabarit(recap(), 'fr')).toMatch(/17 .* pas encore analysée/);
  });

  it('et il se tait quand tout est analysé', () => {
    expect(gabarit(recap({ conversationsAnalysees: 42 }), 'fr')).not.toMatch(/pas encore analysée/);
  });

  it('un jour sans activité le dit en une phrase', () => {
    expect(gabarit(recap({
      conversations: 0, conversationsNouvelles: 0, conversationsAnalysees: 0,
      messagesEntrants: 0, messagesSortants: 0, themes: [],
    }), 'fr')).toMatch(/aucune conversation/i);
  });

  it('il porte les volumes, les nouvelles et les sujets', () => {
    const t = gabarit(recap(), 'fr');
    expect(t).toContain('42 conversations');
    expect(t).toContain('dont 6 nouvelles');
    expect(t).toContain('128 messages reçus');
    expect(t).toContain('retard de livraison (12)');
  });

  it('il nomme le jour en toutes lettres, pas en YYYY-MM-DD', () => {
    expect(gabarit(recap(), 'fr')).toContain('samedi 12 septembre');
    expect(gabarit(recap(), 'en')).toContain('Saturday 12 September');
  });

  it('l anglais existe et ne laisse pas passer de français', () => {
    const t = gabarit(recap(), 'en');
    expect(t).toContain('42 conversations');
    expect(t).not.toMatch(/conversation[s]? re[çc]u/);
  });
});

describe('les nombres que le modèle a le droit d écrire', () => {
  it('ceux du récap, plus la date, plus l écart déjà écrit par le gabarit', () => {
    const n = nombresDuRecap(recap());
    for (const attendu of [42, 6, 25, 17, 128, 96, 12, 40, 130, 2026, 9, 12]) {
      expect(n.has(attendu), String(attendu)).toBe(true);
    }
  });

  it('🔴 un pourcentage calculé par le modèle est repéré', () => {
    // « les conversations ont augmenté de 110 % » : 110 n'est nulle part dans l'entrée.
    expect(nombresInventes('Hausse de 110 % sur 42 conversations.', nombresDuRecap(recap()))).toEqual([110]);
  });

  it('un texte qui ne cite que ses données ne déclenche rien', () => {
    expect(nombresInventes('42 conversations, 128 messages reçus, 17 sans sujet.', nombresDuRecap(recap()))).toEqual([]);
  });

  /**
   * ⚠️ « 1 234 » EST UN NOMBRE, PAS DEUX. Sans cette normalisation, tout récap d'un gros espace serait
   * refusé parce que son propre volume, écrit avec un séparateur de milliers, paraîtrait inventé.
   */
  it('⚠️ un séparateur de milliers ne coupe pas le nombre en deux', () => {
    const r = recap({ messagesEntrants: 1234 });
    expect(nombresInventes('1 234 messages reçus.', nombresDuRecap(r))).toEqual([]);
    expect(nombresInventes('1 234 messages reçus.', nombresDuRecap(r))).toEqual([]);
  });

  it('une comparaison EN MOTS passe, c est ce qu on demande au modèle', () => {
    expect(nombresInventes('Deux fois plus qu’il y a une semaine.', nombresDuRecap(recap()))).toEqual([]);
  });
});

describe('le rédacteur', () => {
  const reponseChat = (args: Record<string, unknown>) => ({
    texte: '',
    appelsOutils: [{ nom: 'rediger_recap', argumentsJson: JSON.stringify(args) }],
  });

  it('🔴 n appelle PAS le modèle quand il n y a rien à signaler', async () => {
    const completer = vi.fn();
    const r = await creerRedacteurRecap({ completer: completer as never, modele: 'm' })(recap(), 'fr');
    expect(completer).not.toHaveBeenCalled();
    expect(r).toEqual({ texte: gabarit(recap(), 'fr'), redigeParModele: false });
  });

  it('l appelle quand il y a un écart, et rend son texte', async () => {
    const r = await creerRedacteurRecap({
      completer: async () => reponseChat({ texte: 'Deux fois plus de conversations qu’il y a une semaine.' }) as never,
      modele: 'm',
    })(recap({ conversations: 84 }), 'fr');
    expect(r).toEqual({ texte: 'Deux fois plus de conversations qu’il y a une semaine.', redigeParModele: true });
  });

  /**
   * 🔴 LA GARDE. Un seul nombre étranger à l'entrée et le texte est jeté : c'est ce qui fait que « le modèle
   * ne compte jamais » est une garantie et pas une consigne.
   */
  it('🔴 un texte qui cite un nombre inventé retombe sur le gabarit', async () => {
    const donnees = recap({ conversations: 84 });
    const r = await creerRedacteurRecap({
      completer: async () => reponseChat({ texte: 'Les conversations ont bondi de 110 % cette semaine.' }) as never,
      modele: 'm',
    })(donnees, 'fr');
    expect(r).toEqual({ texte: gabarit(donnees, 'fr'), redigeParModele: false });
  });

  it('une PANNE du modèle retombe sur le gabarit, jamais sur une erreur', async () => {
    const donnees = recap({ conversations: 84 });
    const r = await creerRedacteurRecap({
      completer: async () => { throw new Error('gateway 503'); },
      modele: 'm',
    })(donnees, 'fr');
    expect(r).toEqual({ texte: gabarit(donnees, 'fr'), redigeParModele: false });
  });

  it('une sortie illisible ou vide retombe sur le gabarit', async () => {
    const donnees = recap({ conversations: 84 });
    const redacteur = creerRedacteurRecap({
      completer: async () => reponseChat({ texte: '   ' }) as never,
      modele: 'm',
    });
    expect((await redacteur(donnees, 'fr')).redigeParModele).toBe(false);
    const sansOutil = creerRedacteurRecap({
      completer: async () => ({ texte: 'blabla', appelsOutils: [] }) as never,
      modele: 'm',
    });
    expect((await sansOutil(donnees, 'fr')).redigeParModele).toBe(false);
  });
});
