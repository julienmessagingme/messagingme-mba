import { describe, it, expect } from 'vitest';
import { restreindreProposition, type Changement, type PropositionConstruction } from '../web/lib/api-agent-setup';
import { AGENDA, agendaEffectif, fusionner, manquesDeCouverture, prochainsPoints } from '../src/agent/setup/couverture';

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
describe('couverture de l’ordre du jour', () => {
  const codes = AGENDA.filter((p) => !p.debloquePar).map((p) => p.code);
  const repondreTout = () => codes.map((point) => ({ point, valeur: 'dit' }));

  it('rien de posé, rien de répondu : tous les points de base manquent', () => {
    expect(manquesDeCouverture({ poses: [], reponses: [] })).toEqual(codes);
  });

  it('🔴 une réponse SANS que le point ait été POSÉ ne couvre rien', () => {
    // C'est la garantie centrale : on s'assure d'avoir fait le tour, pas que le modèle a bien deviné. Une
    // réponse donnée d'avance est gardée (elle sert à faire confirmer en une phrase), elle ne compte pas.
    expect(manquesDeCouverture({ poses: [], reponses: repondreTout() })).toEqual(codes);
  });

  it('🔴 un point POSÉ mais sans réponse ne couvre rien non plus', () => {
    expect(manquesDeCouverture({ poses: codes, reponses: [] })).toEqual(codes);
  });

  it('posé ET répondu : couvert', () => {
    expect(manquesDeCouverture({ poses: codes, reponses: repondreTout() })).toEqual([]);
  });

  it('🔴 un code INVENTÉ ne couvre rien', () => {
    // Les réponses viennent d'un modèle, donc d'une source non fiable : s'il suffisait d'inventer des codes
    // pour se déclarer complet, l'entretien ne serait qu'une suggestion.
    const etat = { poses: codes, reponses: [{ point: 'tout_le_reste', valeur: 'dit' }, { point: 'mission', valeur: 'dit' }] };
    expect(manquesDeCouverture(etat)).toEqual(codes.filter((c) => c !== 'mission'));
  });

  it('une réponse VIDE ne couvre pas', () => {
    const etat = { poses: codes, reponses: [{ point: 'mission', valeur: '   ' }] };
    expect(manquesDeCouverture(etat)).toContain('mission');
  });

  it('🔴 « l’agent le fait tout seul » OUVRE le point du moyen, et il devient obligatoire', () => {
    // Le creusement demandé par Julien : savoir que l'agent agit seul ne dit pas COMMENT. Sans ce point,
    // l'entretien se terminait sur une intention sans outil pour la réaliser.
    const sansOutil = { poses: codes, reponses: repondreTout() };
    expect(agendaEffectif(sansOutil.reponses).map((p) => p.code)).not.toContain('quel_outil');
    expect(manquesDeCouverture(sansOutil)).toEqual([]);

    const avecOutil = {
      poses: codes,
      reponses: repondreTout().map((r) => (r.point === 'bascules' ? { ...r, action: 'outil' as const } : r)),
    };
    expect(agendaEffectif(avecOutil.reponses).map((p) => p.code)).toContain('quel_outil');
    expect(manquesDeCouverture(avecOutil)).toEqual(['quel_outil']);
  });

  it('une autre action n’ouvre PAS le point du moyen (la garde ne déborde pas)', () => {
    for (const action of ['bloc_scenario', 'humain', 'continuer'] as const) {
      const etat = { poses: codes, reponses: repondreTout().map((r) => (r.point === 'bascules' ? { ...r, action } : r)) };
      expect(manquesDeCouverture(etat), action).toEqual([]);
    }
  });

  it('🔴 se raviser REFERME le point du moyen', () => {
    // Le client a le droit de changer d'avis ; l'entretien doit suivre, sinon il resterait bloqué sur une
    // question devenue sans objet et ne se terminerait jamais.
    const avecOutil = fusionner([], repondreTout().map((r) => (r.point === 'bascules' ? { ...r, action: 'outil' as const } : r)));
    expect(manquesDeCouverture({ poses: codes, reponses: avecOutil })).toEqual(['quel_outil']);
    const revenu = fusionner(avecOutil, [{ point: 'bascules', valeur: 'il continue de répondre', action: 'continuer' }]);
    expect(manquesDeCouverture({ poses: codes, reponses: revenu })).toEqual([]);
  });

  it('fusionner : une nouvelle réponse remplace l’ancienne, et l’état se relit dans l’ordre du questionnaire', () => {
    const etat = fusionner([{ point: 'ton', valeur: 'formel' }], [{ point: 'mission', valeur: 'prendre rdv' }, { point: 'ton', valeur: 'tutoiement' }]);
    expect(etat.map((r) => r.point)).toEqual(['mission', 'ton']); // ordre de l'AGENDA, pas d'arrivée
    expect(etat.find((r) => r.point === 'ton')?.valeur).toBe('tutoiement');
  });

  it('🔴 le point OUVERT et le SUIVANT, jamais plus : l’entretien avance d’un cran par tour', () => {
    // Un seul point ferait reposer une question à laquelle le client vient de répondre (le serveur choisit
    // AVANT de le lire) ; toute la liste laisserait le modèle la survoler.
    const [ouvert, suivant] = prochainsPoints({ poses: [], reponses: [] });
    expect(ouvert?.code).toBe(codes[0]);
    expect(suivant?.code).toBe(codes[1]);
  });

  it('dernier point : il n’y a pas de suivant, et le suivant du néant est null', () => {
    const presqueFini = { poses: codes, reponses: repondreTout().slice(0, -1) };
    const [ouvert, suivant] = prochainsPoints(presqueFini);
    expect(ouvert?.code).toBe(codes[codes.length - 1]);
    expect(suivant).toBeNull();
    expect(prochainsPoints({ poses: codes, reponses: repondreTout() })).toEqual([null, null]);
  });
});
