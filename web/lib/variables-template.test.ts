import { describe, expect, it } from 'vitest';
import {
  SEL_DEFAUT, appliquerIndices, lignesAvecIndices, lignesParDefaut,
  problemeDAssociation, selForSource, selToSource, versParamMapping,
} from './variables-template';
import type { UserFieldDef } from './api';

/**
 * L'ASSOCIATION DES VARIABLES, ÉPROUVÉE SEULE.
 *
 * 🔴 CES FONCTIONS DÉCIDENT DE CE QUI PART À DE VRAIES PERSONNES, et elles servent DEUX écrans depuis ce
 * lot (l'ancien formulaire et l'assistant). Elles vivaient dans un `.tsx`, donc exerçables uniquement par
 * un e2e qui monte un serveur Next : un cas de travers y coûtait une minute et se lisait dans une capture.
 */

const PERSO: UserFieldDef[] = [
  { key: 'societe', label: 'Société', type: 'text' },
  { key: 'ville', label: 'Ville', type: 'text' },
];

describe('selToSource', () => {
  it('un champ de base rend sa source declaree, pas une source devinee', () => {
    // ⚠️ `prenom` est un champ SYSTÈME de type `field` (il vit dans `contacts.fields`), pas un attribut :
    // une implémentation qui déduirait le type depuis le préfixe `sys:` le rendrait toujours vide.
    expect(selToSource('sys:prenom', '')).toEqual({ type: 'field', key: 'prenom' });
    expect(selToSource('sys:phone', '')).toEqual({ type: 'attribute', key: 'phone' });
  });

  it('un champ perso rend sa cle, un texte fixe rend sa valeur, la date rend now', () => {
    expect(selToSource('field:societe', '')).toEqual({ type: 'field', key: 'societe' });
    expect(selToSource('literal', 'Paris')).toEqual({ type: 'literal', value: 'Paris' });
    expect(selToSource('now', '')).toEqual({ type: 'now' });
  });

  // ⚠️ Une option inconnue (état restauré d'un brouillon d'une version d'avant) ne doit pas produire une
  // source inventée : elle retombe sur « Nom », qui existe toujours.
  it('une option inconnue retombe sur un champ de base, jamais sur rien', () => {
    expect(selToSource('sys:inconnu', '')).toEqual({ type: 'attribute', key: 'name' });
  });
});

describe('selForSource', () => {
  it('un indice vers un champ perso REEL le preselectionne', () => {
    expect(selForSource({ type: 'field', key: 'societe' }, PERSO)).toBe('field:societe');
  });

  /**
   * 🔴 UN INDICE VERS UN CHAMP DISPARU RETOMBE SUR LE DÉFAUT. Sans ce repli, le `<select>` afficherait sa
   * première option tout en gardant en interne une clé fantôme : l'écran montrerait « Nom » et l'envoi
   * chercherait un champ qui n'existe plus, donc sauterait le contact sans rien montrer.
   */
  it('un indice vers un champ SUPPRIME retombe sur le defaut', () => {
    expect(selForSource({ type: 'field', key: 'supprime' }, PERSO)).toBe(SEL_DEFAUT);
  });

  it('un indice vers un champ systeme le reconnait comme tel', () => {
    expect(selForSource({ type: 'field', key: 'prenom' }, PERSO)).toBe('sys:prenom');
  });
});

describe('lignesParDefaut et lignesAvecIndices', () => {
  it('autant de lignes que de variables, toutes au defaut', () => {
    expect(lignesParDefaut(2)).toEqual([{ sel: SEL_DEFAUT, value: '' }, { sel: SEL_DEFAUT, value: '' }]);
    expect(lignesParDefaut(0)).toEqual([]);
  });

  it('les indices remplacent les positions qu ils designent', () => {
    const lignes = lignesAvecIndices(2, [{ position: 2, source: { type: 'literal', value: 'Paris' } }], PERSO);
    expect(lignes).toEqual([{ sel: SEL_DEFAUT, value: '' }, { sel: 'literal', value: 'Paris' }]);
  });

  /**
   * 🔴 UN INDICE HORS BORNES EST IGNORÉ, PAS APPLIQUÉ EN BOUT DE LISTE. Les indices sont stockés avec le
   * modèle et son corps a pu changer depuis : une position 4 sur un modèle à deux variables n'est pas
   * « la dernière », et la poser ailleurs associerait une variable à la source d'une autre.
   */
  it('un indice hors bornes ne deplace aucune autre variable', () => {
    const lignes = lignesAvecIndices(2, [{ position: 4, source: { type: 'literal', value: 'Paris' } }], PERSO);
    expect(lignes).toEqual(lignesParDefaut(2));
  });

  /**
   * ⚠️ `appliquerIndices` ÉCRASE LES POSITIONS INDIQUÉES, ET ELLES SEULES. Les indices arrivent par le
   * réseau, après l'affichage : reconstruire depuis les défauts à leur retour effacerait ce que
   * l'opérateur aurait changé entre-temps sur une position qu'aucun indice ne couvre.
   */
  it('les lignes deja choisies survivent a l arrivee des indices', () => {
    const deja = [{ sel: 'field:ville', value: '' }, { sel: SEL_DEFAUT, value: '' }];
    const lignes = appliquerIndices(deja, [{ position: 2, source: { type: 'now' } }], PERSO);
    expect(lignes[0]).toEqual({ sel: 'field:ville', value: '' });
    expect(lignes[1]).toEqual({ sel: 'now', value: '' });
  });
});

describe('versParamMapping', () => {
  it('numerote les positions a partir de 1, dans l ordre des lignes', () => {
    expect(versParamMapping([{ sel: 'sys:prenom', value: '' }, { sel: 'literal', value: 'Paris' }])).toEqual([
      { position: 1, source: { type: 'field', key: 'prenom' } },
      { position: 2, source: { type: 'literal', value: 'Paris' } },
    ]);
  });

  it('aucune ligne, aucun parametre', () => {
    expect(versParamMapping([])).toEqual([]);
  });
});

describe('problemeDAssociation', () => {
  it('le compte exact ne retient rien', () => {
    expect(problemeDAssociation(lignesParDefaut(2), 2)).toBeNull();
  });

  // 🔴 C'est le refus dont le coût est GLOBAL : Meta compare le nombre de paramètres fournis à celui du
  // modèle approuvé et refuse la CAMPAGNE, pas le destinataire.
  it('une liste plus courte que le modele est refusee', () => {
    expect(problemeDAssociation(lignesParDefaut(1), 2)).toMatch(/2 variable/);
  });

  it('une liste plus LONGUE est refusee aussi', () => {
    // ⚠️ L'autre sens compte autant : un modèle raccourci chez Meta ferait envoyer un paramètre de trop,
    // que Meta refuse de la même façon. Une garde `<` seulement passerait le cas du dessus sans voir celui-ci.
    expect(problemeDAssociation(lignesParDefaut(3), 2)).not.toBeNull();
  });

  it('un texte fixe laisse a blanc est refuse, et la raison DIT laquelle', () => {
    const lignes = [{ sel: SEL_DEFAUT, value: '' }, { sel: 'literal', value: '   ' }];
    expect(problemeDAssociation(lignes, 2)).toMatch(/\{\{2\}\}/);
  });

  // ⚠️ Un champ de contact vide n'est PAS ce cas : il est traité à la construction des destinataires, qui
  // ÉCARTE la fiche. Les confondre refuserait un lancement valide parce qu'un contact sur mille n'a pas
  // son prénom.
  it('une source par contact ne peut pas etre « vide » ici', () => {
    expect(problemeDAssociation([{ sel: 'field:societe', value: '' }], 1)).toBeNull();
  });
});
