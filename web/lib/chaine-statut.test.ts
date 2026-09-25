import { describe, it, expect } from 'vitest';
import { classesPastille, etatPublication, texteAvertissement } from './chaine-statut';

/**
 * L'état affiché d'une publication de chaîne.
 *
 * Ce que ces tests protègent, et qui ne se voit pas à la lecture :
 *
 *  1. 🔴 Une valeur INCONNUE se rend telle quelle, en ton neutre. Le vocabulaire appartient au fournisseur
 *     et il peut en ajouter demain : la ranger de force dans « Publiée » ferait attendre à un client des
 *     conversations qui ne viendront jamais, sans qu'il aille chercher pourquoi.
 *  2. Un REFUS a son propre ton, distinct de l'attente. C'est la raison d'être du module : « en attente »
 *     et « refusée » n'appellent pas la même action.
 *  3. Les trois avertissements de publication arrivent avec un SUCCÈS (201). Aucun ne doit inviter à
 *     republier : un second envoi partirait à toute l'audience.
 */

describe('etatPublication : ce que le fournisseur dit, et ce qu’on en montre', () => {
  it('traduit les statuts connus, avec le bon ton', () => {
    expect(etatPublication('published', 'fr')).toEqual({ libelle: 'Publiée', ton: 'publie' });
    expect(etatPublication('pending', 'fr')).toEqual({ libelle: 'En attente', ton: 'attente' });
    expect(etatPublication('rejected', 'fr')).toEqual({ libelle: 'Refusée', ton: 'refus' });
  });

  it('traduit en anglais quand la console est en anglais', () => {
    expect(etatPublication('published', 'en').libelle).toBe('Published');
    expect(etatPublication('failed', 'en').libelle).toBe('Rejected');
  });

  it('ignore la casse : le fournisseur est en Rails, rien ne garantit le minuscule', () => {
    expect(etatPublication('PUBLISHED', 'fr').ton).toBe('publie');
    expect(etatPublication('Failed', 'fr').ton).toBe('refus');
  });

  it('🔴 un statut INCONNU se rend TEL QUEL, en ton neutre, jamais rangé dans « Publiée »', () => {
    expect(etatPublication('moderation_hold', 'fr')).toEqual({ libelle: 'moderation_hold', ton: 'neutre' });
    // La faute que ce test interdit : tout ce qui n'est pas un échec connu compté comme un succès.
    expect(etatPublication('moderation_hold', 'fr').ton).not.toBe('publie');
  });

  it('un statut ABSENT n’est pas un échec : « non communiqué », en neutre', () => {
    // `message` vaut null quand le fournisseur est muet ou ne connaît plus ce message. Ce n'est pas un refus.
    expect(etatPublication(null, 'fr')).toEqual({ libelle: 'Non communiqué', ton: 'neutre' });
    expect(etatPublication(undefined, 'fr').ton).toBe('neutre');
    expect(etatPublication('   ', 'fr').ton).toBe('neutre');
    expect(etatPublication(null, 'en').libelle).toBe('Not reported');
  });

  it('l’attente et le refus ne partagent NI ton NI libellé', () => {
    const attente = etatPublication('queued', 'fr');
    const refus = etatPublication('failed', 'fr');
    expect(attente.ton).not.toBe(refus.ton);
    expect(attente.libelle).not.toBe(refus.libelle);
  });
});

describe('classesPastille : les quatre tons restent distinguables', () => {
  it('rend une classe différente pour chacun des quatre tons', () => {
    const tons = ['publie', 'attente', 'refus', 'neutre'] as const;
    const classes = tons.map(classesPastille);
    expect(new Set(classes).size).toBe(4);
  });
});

describe('texteAvertissement : un post parti, et ce qu’il reste à faire', () => {
  it('🔴 seul l’allumage raté est RÉPARABLE : c’est le bouton mort, invisible autrement', () => {
    const a = texteAvertissement('automation_non_allumee', 'fr');
    expect(a.reparable).toBe(true);
    expect(texteAvertissement('trace_manquante', 'fr').reparable).toBe(false);
    expect(texteAvertissement('reponse_inattendue', 'fr').reparable).toBe(false);
  });

  it('🔴 AUCUN des trois n’INVITE à republier : un second envoi irait à toute l’audience', () => {
    // ⚠️ La garde porte sur l’INVITATION, pas sur le mot. Une première version interdisait « republie »
    // tout court, et refusait donc « ne republie pas », qui est exactement ce qu’on veut dire. Interdire un
    // mot au lieu d’une intention aurait poussé à retirer l’avertissement le plus utile des trois.
    for (const a of ['automation_non_allumee', 'trace_manquante', 'reponse_inattendue'] as const) {
      for (const l of ['fr', 'en'] as const) {
        const texte = texteAvertissement(a, l).texte.toLowerCase();
        // On retire d’abord les MISES EN GARDE (« ne republiez pas », « do not publish again »), puis on
        // cherche une invitation dans ce qui reste. Sans ce retrait, la garde refusait la phrase qui dit
        // exactement le contraire de ce qu’elle interdit, dans les deux langues.
        const sansMiseEnGarde = texte.replace(/ne republiez pas|do not publish again/g, '');
        // Les deux personnes de chaque verbe : le texte est au « vous » depuis la passe 3 de la refonte.
        expect(sansMiseEnGarde).not.toMatch(/republi|réessa|reessa|try again|publish again|renvoie le message|renvoyez le message/);
      }
    }
  });

  it('🔴 le cas « réponse inattendue » dit EXPLICITEMENT de ne pas republier', () => {
    // C’est le plus dangereux des trois : le message est parti, on n’a aucun identifiant pour le prouver, et
    // l’écran n’en gardera aucune trace. Sans cette phrase, le réflexe naturel est de recommencer.
    expect(texteAvertissement('reponse_inattendue', 'fr').texte).toContain('Ne republiez pas');
    expect(texteAvertissement('reponse_inattendue', 'en').texte).toContain('Do not publish again');
  });

  it('dit dans les deux langues que la publication EST partie', () => {
    expect(texteAvertissement('automation_non_allumee', 'fr').texte).toContain('est partie');
    expect(texteAvertissement('automation_non_allumee', 'en').texte).toContain('went out');
  });
});
