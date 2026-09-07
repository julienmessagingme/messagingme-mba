import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * « Ce qui manque » doit nommer TOUTES les conditions qui grisent le bouton, pas seulement quelques-unes.
 *
 * 🔴 LE DÉFAUT QUE CE TEST EMPÊCHE DE REVENIR, et qui s'est produit le 2026-09-07. Le bloc partagé
 * `ListeManques` ne s'affiche que si sa liste est NON VIDE, alors que le bloc qu'il remplaçait dans
 * `FlowBuilder` s'affichait dès que le bouton était grisé. En n'y portant que quatre des sept conditions de
 * `canSubmit`, on a rendu le bouton MUET sur les trois autres, dans le composant même où le remède avait été
 * écrit. Un test de comportement ne pouvait pas le voir : le bloc s'affichait toujours pour les quatre cas
 * couverts.
 *
 * ⚠️ CE TEST LIT DU CODE SOURCE, et c'est assumé. Ces composants sont des `.tsx` : le vitest du front
 * n'inclut que `lib/`, et monter React ici pour cette seule vérification serait une dérive de pile. Le
 * dépôt a déjà ce motif (`tests/parcours-remplace-cablage.test.ts`). La contrepartie est connue : un
 * renommage de condition fait échouer ce test, ce qui est exactement le moment où il faut regarder.
 *
 * ⚠️ Il vérifie un CÂBLAGE, donc la seule question à lui poser est l'inverse de l'habituelle : que suppose
 * ce test des composants ? Qu'une condition de validation y est nommée par un identifiant, et que le même
 * identifiant apparaît dans le bloc des manques.
 */
const lire = (relatif: string): string => readFileSync(join(process.cwd(), relatif), 'utf8');

/** Le corps de `const canSubmit = ...;`, tel qu'il est écrit. */
function expressionCanSubmit(source: string): string {
  const i = source.indexOf('const canSubmit =');
  expect(i, 'canSubmit introuvable : le composant a changé de forme').toBeGreaterThan(-1);
  const fin = source.indexOf(';', i);
  return source.slice(i, fin);
}

/** Le bloc `<ListeManques ... />`, tel qu'il est écrit. */
function blocManques(source: string): string {
  const i = source.indexOf('<ListeManques');
  expect(i, 'ListeManques introuvable : le composant ne dit plus ce qui manque').toBeGreaterThan(-1);
  const fin = source.indexOf('/>', i);
  return source.slice(i, fin);
}

describe('le bloc « ce qui manque » couvre toutes les conditions du bouton', () => {
  /**
   * `busy` est exclu partout : il n'est pas un manque, c'est un envoi en cours. Le composant partagé le
   * reçoit en propriété et se tait pendant ce temps, parce que le bouton est alors grisé pour une raison
   * évidente. L'annoncer ferait douter.
   */
  const HORS_MANQUES = ['busy'];

  it('🔴 FlowBuilder : chaque condition de canSubmit est nommée dans les manques', () => {
    const source = lire('components/FlowBuilder.tsx');
    const conditions = expressionCanSubmit(source);
    const manques = blocManques(source);

    // Les identifiants que `canSubmit` consulte, hors mots-clés et littéraux.
    const identifiants = [...new Set(
      (conditions.match(/[A-Za-z_$][\w$]*/g) ?? []).filter(
        (m) => !['const', 'canSubmit', 'trim', 'length', 'every', 'elements', 'true', 'false'].includes(m),
      ),
    )].filter((m) => !HORS_MANQUES.includes(m));

    // Sept conditions au moment de l'écriture. Si ce compte baisse, c'est que l'extraction a cessé de
    // fonctionner (et le test passerait alors pour la mauvaise raison), pas que le composant a simplifié.
    expect(identifiants.length).toBeGreaterThanOrEqual(6);

    const oubliees = identifiants.filter((id) => !manques.includes(id));
    expect(
      oubliees,
      `Ces conditions grisent le bouton sans que rien ne le dise : ${oubliees.join(', ')}. `
      + 'ListeManques ne s’affiche que si sa liste est non vide, donc une condition absente d’ici rend le '
      + 'bouton MUET. Ajoute-lui une ligne.',
    ).toEqual([]);
  });

  it('🔴 TemplateForm et CarouselForm passent bien par le bloc partagé', () => {
    // Le bloc a été écrit trois fois dans ce dépôt avant d'être extrait, et les copies avaient divergé.
    // Un formulaire qui reviendrait à sa propre version rouvrirait le même cul-de-sac.
    for (const fichier of ['components/TemplateForm.tsx', 'components/CarouselForm.tsx', 'components/FlowBuilder.tsx']) {
      expect(lire(fichier), `${fichier} n’utilise plus ListeManques`).toContain('<ListeManques');
    }
  });

  it('preuve inverse : l’extraction voit vraiment une condition ajoutée', () => {
    // Sans ce sens-la, les deux tests ci-dessus passeraient aussi sur une extraction qui rend du vide.
    const faux = 'const canSubmit = name.trim() !== \'\' && jamaisNommee && !busy;';
    const identifiants = (expressionCanSubmit(faux).match(/[A-Za-z_$][\w$]*/g) ?? []);
    expect(identifiants).toContain('jamaisNommee');
    expect(blocManques('<ListeManques manques={[]} />')).toContain('manques');
  });
});
