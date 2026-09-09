import { describe, it, expect } from 'vitest';
import { restreindreProposition, type Changement, type PropositionConstruction } from '../web/lib/api-agent-setup';

/**
 * GARDER, CORRIGER OU JETER CHAQUE RÈGLE SÉPARÉMENT.
 *
 * 🔴 CE QUE ÇA RÉPARE. Julien, 2026-08-28 : « il n'y a qu'un seul bouton Garder ou Jeter à la fin, alors que
 * potentiellement le mec ne veut en changer qu'une et le reste lui convient ». Un lot indivisible force à tout
 * refuser pour corriger une ligne, donc à relancer la conversation en espérant que le modèle ne défasse pas au
 * passage les cinq autres qui convenaient.
 *
 * 🔴 ET POURQUOI CE N'EST PAS UN SIMPLE FILTRE. Les deux textes d'un outil partent dans le MÊME
 * enregistrement. Omettre la ligne jetée la laisserait prendre la valeur proposée, c'est-à-dire exactement
 * celle qu'on venait de refuser : une ligne jetée doit donc réécrire la valeur ACTUELLE. C'est le piège de
 * cette feature, et c'est ce que ce fichier verrouille.
 */

const PROPOSITION: PropositionConstruction = {
  fiche: { objectif: 'Qualifier puis orienter.', ton: 'Vouvoiement, phrases courtes.' },
  outils: [{ handler: 'poser_tag', description: 'Tague les intéressés.', nePasUtiliser: 'Jamais deux fois.' }],
  connecteurs: [{ nom: 'erp', description: 'Pour lire un dossier.', nePasUtiliser: 'Pas pour les tarifs.' }],
};

const CHANGEMENTS: Changement[] = [
  { champ: 'fiche.objectif', label: 'Objectif', avant: 'Aider.', apres: 'Qualifier puis orienter.' },
  { champ: 'fiche.ton', label: 'Ton', avant: '', apres: 'Vouvoiement, phrases courtes.' },
  { champ: 'outil.poser_tag.description', label: 'Tag : quand l’appeler', avant: 'Ancienne.', apres: 'Tague les intéressés.' },
  { champ: 'outil.poser_tag.nePasUtiliser', label: 'Tag : quand NE PAS l’appeler', avant: 'Ancienne exception.', apres: 'Jamais deux fois.' },
  { champ: 'connecteur.erp.description', label: 'ERP : quand l’appeler', avant: 'Vieux texte.', apres: 'Pour lire un dossier.' },
  { champ: 'connecteur.erp.nePasUtiliser', label: 'ERP : quand NE PAS l’appeler', avant: 'Vieille exception.', apres: 'Pas pour les tarifs.' },
];

/** Tout est gardé au départ : c'est l'état initial de l'écran, et le geste courant. */
const tout = (): Map<string, string> => new Map(CHANGEMENTS.map((c) => [c.champ, c.apres]));

describe('garder, corriger ou jeter ligne par ligne', () => {
  it('tout garder rend exactement la proposition d’origine', () => {
    const r = restreindreProposition(PROPOSITION, CHANGEMENTS, tout());
    expect(r.fiche).toEqual(PROPOSITION.fiche);
    expect(r.outils).toEqual(PROPOSITION.outils);
    expect(r.connecteurs).toEqual(PROPOSITION.connecteurs);
  });

  it('une ligne de fiche jetée n’est pas envoyée du tout', () => {
    const g = tout();
    g.delete('fiche.ton');
    const r = restreindreProposition(PROPOSITION, CHANGEMENTS, g);
    expect(r.fiche).toEqual({ objectif: 'Qualifier puis orienter.' });
  });

  it('une ligne corrigée part avec le texte du CLIENT, pas celui du modèle', () => {
    const g = tout();
    g.set('fiche.objectif', 'Qualifier, puis passer la main.');
    const r = restreindreProposition(PROPOSITION, CHANGEMENTS, g);
    expect(r.fiche.objectif).toBe('Qualifier, puis passer la main.');
  });

  it('🔴 jeter UNE ligne d’outil réécrit sa valeur ACTUELLE, elle ne disparaît pas', () => {
    // LE piège. Les deux textes partent dans le même enregistrement : omettre celui qu'on a jeté le laisserait
    // prendre la valeur proposée, celle-là même que le client vient de refuser.
    const g = tout();
    g.delete('outil.poser_tag.nePasUtiliser');
    const r = restreindreProposition(PROPOSITION, CHANGEMENTS, g);
    expect(r.outils).toEqual([{
      handler: 'poser_tag',
      description: 'Tague les intéressés.',
      nePasUtiliser: 'Ancienne exception.',
    }]);
  });

  it('🔴 un outil dont TOUTES les lignes sont jetées n’est pas écrit, donc pas créé', () => {
    // Le réécrire avec ses valeurs actuelles CRÉERAIT quand même l'outil, alors que le client vient de
    // refuser l'ajout ligne à ligne.
    const g = tout();
    g.delete('outil.poser_tag.description');
    g.delete('outil.poser_tag.nePasUtiliser');
    const r = restreindreProposition(PROPOSITION, CHANGEMENTS, g);
    expect(r.outils).toEqual([]);
    // Les autres familles ne sont pas emportées au passage.
    expect(r.connecteurs).toHaveLength(1);
    expect(r.fiche.objectif).toBe('Qualifier puis orienter.');
  });

  it('un connecteur dont tout est jeté n’est pas patché', () => {
    const g = tout();
    g.delete('connecteur.erp.description');
    g.delete('connecteur.erp.nePasUtiliser');
    expect(restreindreProposition(PROPOSITION, CHANGEMENTS, g).connecteurs).toEqual([]);
  });

  it('tout jeter ne laisse rien à écrire', () => {
    const r = restreindreProposition(PROPOSITION, CHANGEMENTS, new Map());
    expect(r).toEqual({ fiche: {}, outils: [], connecteurs: [] });
  });

  it('un champ SANS ligne de diff est envoyé tel quel : il est déjà identique à l’existant', () => {
    // `differences` n'émet pas de ligne pour une valeur inchangée. L'absence de ligne ne doit donc pas se lire
    // comme un refus, sinon un tour qui recopie un champ à l'identique l'effacerait.
    const p: PropositionConstruction = { fiche: { objectif: 'Aider.' }, outils: [] };
    const r = restreindreProposition(p, [], new Map());
    expect(r.fiche).toEqual({ objectif: 'Aider.' });
  });

  it('les règles d’arrêt se gardent ou se jettent, sans être réécrites depuis le texte affiché', () => {
    // Cette ligne porte PLUSIEURS règles dans un seul texte. La relire pour reconstruire la liste ferait
    // dépendre un enregistrement d'un format que le client peut casser en tapant.
    const p: PropositionConstruction = { fiche: { sorties: [{ code: 'rdv_pris', label: 'Rendez-vous pris' }] }, outils: [] };
    const c: Changement[] = [{ champ: 'fiche.sorties', label: 'Règles d’arrêt', avant: '', apres: 'rdv_pris : Rendez-vous pris' }];
    const gardee = restreindreProposition(p, c, new Map([['fiche.sorties', 'texte massacré par le client']]));
    expect(gardee.fiche.sorties).toEqual([{ code: 'rdv_pris', label: 'Rendez-vous pris' }]);
    expect(restreindreProposition(p, c, new Map()).fiche.sorties).toBeUndefined();
  });
});

/**
 * L'ENTRETIEN CONDUIT PAR LE SERVEUR (2026-08-31).
 *
 * Ces règles sont ce qui rend le questionnement déterministe. Avant, la couverture était une DÉCLARATION du
 * modèle, et un modèle pressé se déclarait couvert après une phrase : le ton, l'identité et la base de
 * connaissance n'étaient jamais demandés.
 */

/**
 * LE RÉGLAGE D'ANNONCE D'IA, qui n'est ni dans la fiche ni dans un outil (2026-09-09).
 *
 * 🔴 IL A FAILLI ÊTRE OUBLIÉ ICI, et le défaut aurait été parfaitement muet : l'entretien pose la question,
 * le diff l'affiche, et appliquer ne changeait rien. C'est le hook de rayon de souffle qui l'a signalé, en
 * nommant ce fichier comme lecteur de `differences`.
 */
describe('Le régime d’annonce d’IA dans une proposition', () => {
  const AVEC = { ...PROPOSITION, mentionIaFrequence: 'jamais' as const };
  const LIGNE: Changement[] = [{ champ: 'mentionIaFrequence', label: 'Annonce « je suis une IA »', avant: 'une fois par conversation', apres: 'jamais' }];

  it('🔴 GARDÉE, la valeur proposée part', () => {
    const r = restreindreProposition(AVEC, LIGNE, new Map([['mentionIaFrequence', 'jamais']]));
    expect(r.mentionIaFrequence).toBe('jamais');
  });

  it('🔴 JETÉE, le champ est OMIS : la colonne reste inchangée', () => {
    // Et surtout pas réécrit depuis `avant` : le diff ne porte que des libellés en français, pas le code.
    const r = restreindreProposition(AVEC, LIGNE, new Map());
    expect(r.mentionIaFrequence).toBeUndefined();
  });

  it('sans proposition sur ce point, rien n’est envoyé', () => {
    const r = restreindreProposition(PROPOSITION, [], new Map());
    expect(r.mentionIaFrequence).toBeUndefined();
  });
});
