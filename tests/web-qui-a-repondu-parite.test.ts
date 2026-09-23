import { describe, it, expect } from 'vitest';
import { ORIGINES } from '../src/inbox/origine';
import { repondeursDe, REPONDEURS } from '../web/lib/qui-a-repondu';

/**
 * CHAQUE ORIGINE DE MESSAGE SORTANT A SON BADGE, OU FIGURE DANS UNE LISTE D'ABSENCES VOULUES.
 *
 * 🔴 CE TEST N'EXISTAIT PAS, ET SON ABSENCE A COÛTÉ UN DÉFAUT LE JOUR MÊME (2026-09-23). La septième
 * origine (`api`, l'API publique du client, migration 0166) a été ajoutée côté serveur ; `DE_L_ORIGINE`,
 * dans `web/lib/qui-a-repondu.ts`, ne la connaissait pas. Une conversation répondue par l'API n'aurait donc
 * porté AUCUN badge, c'est-à-dire que l'écran aurait affiché « personne n'a répondu » sur une conversation
 * où quelqu'un a répondu. Ce fichier-là promet exactement l'inverse : « une liste vide veut dire PERSONNE
 * N'A RÉPONDU, et c'est une information ».
 *
 * 🔴 DEUX CONSTANTES DE FICHIERS DIFFÉRENTS QUI DOIVENT RESTER ALIGNÉES, et c'est l'invariant qu'aucun des
 * deux fichiers ne peut porter seul : chacune est parfaitement plausible isolément, seul leur ÉCART est
 * faux. Ni le compilateur (le `Record<string, ...>` accepte n'importe quelle clé) ni un test de l'un ou de
 * l'autre ne peut le voir. Le défaut a été trouvé par le hook de rayon de souffle, pas par la suite.
 *
 * ⚠️ IL NE DOUBLONNE PAS `web/lib/qui-a-repondu.test.ts`, QUI EXISTE, et la distinction vaut la peine :
 * celui-la eprouve les COMPORTEMENTS (une conversation hybride porte plusieurs badges, l'ordre est stable,
 * `mcp` est un agent IA, `campagne` n'est pas un repondeur). Aucun de ses cas ne pouvait voir une origine
 * MANQUANTE, parce qu'ils nomment tous l'origine qu'ils testent. Celui-ci ne teste aucun comportement : il
 * teste la COUVERTURE. Il vit dans `tests/` et non dans `web/lib/` parce qu'il traverse la frontiere
 * serveur/front, comme les autres paritees du depot (`web-rcs-limits-parity`, `web-agent-sorties-parity`).
 *
 * ⚠️ IL SE DÉRIVE, IL NE SE RECOPIE PAS : la liste vient d'`ORIGINES`. Une huitième origine ajoutée demain
 * fait tomber ce test tant qu'elle n'a pas été TRANCHÉE, badge ou absence assumée.
 */

/**
 * LES ORIGINES QUI N'ONT DÉLIBÉRÉMENT PAS DE BADGE, et la raison de chacune.
 *
 * ⚠️ UNE LISTE EXPLICITE, PAS UN `?? 'scripte'` DE REPLI. Un repli rangerait silencieusement toute origine
 * future sous un badge arbitraire, ce qui est précisément la panne qu'on ferme : on veut que l'ajout se
 * VOIE et qu'il soit tranché.
 */
const SANS_BADGE_VOULU: Record<string, string> = {
  // Un envoi de campagne OUVRE l'échange, il ne répond à rien. Le compter en « scripté » ferait porter un
  // badge « on vous a répondu » à toute conversation née d'une campagne, y compris celles où personne n'a
  // jamais répondu. La raison complète vit dans le docblock de `qui-a-repondu.ts`.
  campagne: 'une campagne ouvre l’échange, elle ne répond pas',
};

describe('parité : les origines du serveur et les badges de l’écran', () => {
  it('🔴 chaque origine déclarée a un badge, ou une absence ASSUMÉE et nommée', () => {
    const sansBadge = ORIGINES.filter((o) => repondeursDe([o]).length === 0);
    expect(
      sansBadge.filter((o) => SANS_BADGE_VOULU[o] === undefined),
      'origine(s) sans badge et sans raison écrite : trancher dans `web/lib/qui-a-repondu.ts`, ou les déclarer ici',
    ).toEqual([]);
  });

  it('🔴 et l’inverse : aucune absence déclarée ne porte en fait un badge', () => {
    // Sans ce sens-là, une origine qu'on finirait par mapper resterait listée comme « sans badge », et la
    // liste des raisons deviendrait un texte faux que le prochain lecteur croirait.
    for (const [origine, raison] of Object.entries(SANS_BADGE_VOULU)) {
      expect(repondeursDe([origine]), `« ${origine} » porte un badge alors qu’on écrit : ${raison}`).toEqual([]);
    }
  });

  it('🔴 `api` répond, à la différence d’une campagne', () => {
    // Le cas qui a motivé ce fichier. Un message d'API n'existe QUE dans la fenêtre de 24 h, donc il ne
    // peut arriver qu'APRÈS que la personne a écrit : il répond par construction.
    expect(repondeursDe(['api'])).toEqual(['scripte']);
    expect(repondeursDe(['campagne'])).toEqual([]);
  });

  it('une origine INCONNUE du serveur ne casse rien et ne porte aucun badge', () => {
    // Le repli du front face à une valeur qu'il ne connaît pas encore : la page reste lisible.
    expect(repondeursDe(['valeur-de-demain', null, undefined])).toEqual([]);
  });

  it('les badges restent au nombre de quatre, dans leur ordre d’affichage', () => {
    // Un cinquième badge est une décision produit, pas un effet de bord d'un ajout de colonne.
    expect([...REPONDEURS]).toEqual(['scripte', 'humain', 'mba', 'agent']);
  });
});
