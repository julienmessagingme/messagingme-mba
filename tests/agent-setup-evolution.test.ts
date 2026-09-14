import { describe, it, expect } from 'vitest';
import { consigneDuTour, construireMessages, type ContexteConstruction } from '../src/agent/setup/conversation';
import {
  AGENDA, INVENTAIRE_VIDE, manquesDeCouverture, pointsSansContenu, prochainsPoints,
  type EtatEntretien,
} from '../src/agent/setup/couverture';
import { ficheVide, type FicheAgentContenu } from '../src/agent/fiche';

/**
 * L'ASSISTANT D'AGENT IA EN MODE ÉVOLUTION.
 *
 * 🔴 LA BUTÉE QU'ON RETIRE ICI EST CE QUI LE FAISAIT TAIRE. Tant que l'entretien n'était pas fini, il posait
 * des questions ; une fois fini, sa consigne devenait « ne pose plus de question, écris les champs ». Rouvrir
 * la conversation le lendemain le faisait donc repartir en proposant d'écrire des champs dont personne
 * n'avait parlé, sur un agent qui répond déjà à de vrais contacts.
 *
 * 🔴 ET LE GRAIN DU SIGNALEMENT EST L'ÉLÉMENT, PAS L'ENTRETIEN. Vider un champ dans le formulaire fait
 * parler de CE point-là, et de lui seul : relancer les dix questions pour un champ effacé ne se ferait pas
 * deux fois.
 *
 * 🔴 SIGNALER, ET SURTOUT PAS ROUVRIR. Le plan demandait qu'un point vidé « redevienne une question ». Écrit
 * ainsi, il ENFERME l'entretien : la couverture retient la proposition, et un champ ne se remplit qu'en
 * appliquant une proposition. Trouvé par les tests de la route, pas par le compilateur.
 */

/** Un entretien COMPLET : chaque point de l'agenda de base posé et répondu. */
function entretienComplet(): EtatEntretien {
  return {
    poses: AGENDA.map((p) => p.code),
    reponses: AGENDA.map((p) => ({ point: p.code, valeur: `réponse pour ${p.code}` })),
  };
}

/** Une fiche RENSEIGNÉE : c'est l'état d'un agent en service, celui du mode évolution. */
function ficheComplete(over: Partial<FicheAgentContenu> = {}): FicheAgentContenu {
  return {
    ...ficheVide(),
    nom: 'Léa', objectif: 'Renseigner et qualifier.', ton: 'Vouvoiement, phrases courtes.',
    personnalite: 'Calme', reglesTransfert: 'Sur demande explicite.',
    sorties: [{ code: 'rdv_pris', label: 'Rendez-vous pris' }],
    ...over,
  };
}

const CTX = (over: Partial<ContexteConstruction> = {}): ContexteConstruction => ({
  label: 'Conseiller séjours', mentionIaFrequence: 'session', inactiviteMinutes: 30,
  fiche: ficheComplete(), outils: [], titresConnaissance: [], ...over,
});

describe('la butée', () => {
  it('🔴 un agent complet ne fait plus taire l’assistant : il écoute', () => {
    const consigne = consigneDuTour(entretienComplet(), INVENTAIRE_VIDE);
    expect(consigne).not.toContain('ne pose plus de question');
    // Il attend une demande, il ne relance pas un entretien.
    expect(consigne).toContain('attends');
  });

  it('🔴 et il ne propose RIEN qu’on ne lui ait demandé', () => {
    // Sur un agent en service, une proposition non sollicitée change ce qu'un robot dit à de vrais clients.
    // Le diff ne protège que s'il est lu, donc que s'il est rare.
    const consigne = consigneDuTour(entretienComplet(), INVENTAIRE_VIDE);
    expect(consigne).toMatch(/ne demande rien, tu ne proposes rien/i);
  });

  it('⚠️ mais pendant la construction, rien ne change : la question du tour est toujours posée', () => {
    const consigne = consigneDuTour({ poses: [], reponses: [] }, INVENTAIRE_VIDE);
    expect(consigne).toContain('LE POINT OUVERT : mission');
  });

  it('la consigne d’évolution arrive jusqu’au mandat envoyé au modèle', () => {
    // Un faux câblage ne dit rien du vrai : on vérifie le message RÉELLEMENT construit.
    const m = construireMessages(CTX(), [{ role: 'user', content: 'bonjour' }], entretienComplet());
    expect(m[0]?.content).toContain('tu es en ÉVOLUTION');
  });
});

describe('un point redevenu vide', () => {
  it('🔴 est SIGNALÉ, et lui seul', () => {
    const etat = entretienComplet();
    // Les règles d'arrêt ont été effacées dans le formulaire, après l'entretien.
    const vides = pointsSansContenu(ficheComplete({ sorties: [] }));
    expect(vides).toEqual(['aboutissements']);
    const consigne = consigneDuTour(etat, INVENTAIRE_VIDE, vides);
    expect(consigne).toContain('VIDÉ depuis votre entretien : aboutissements');
    // 🔴 LUI SEUL : relancer tout l'entretien pour un champ effacé reposerait neuf questions tranchées.
    expect(consigne).not.toContain('ton,');
    // ⚠️ Et ce n'est PAS une question d'entretien : la réponse du client est toujours connue.
    expect(consigne).toContain('Ne repose pas la question');
  });

  it('🔴 il ne RETIENT PAS la proposition, sinon rien ne peut plus remplir le champ', () => {
    /**
     * LE BLOCAGE que ce lot a failli introduire, trouvé par les tests de la route. La couverture RETIENT la
     * proposition (« tant que l'ordre du jour n'est pas épuisé, aucun champ n'est montré ») ; or un champ ne
     * se remplit qu'en APPLIQUANT une proposition. Compter un champ vide comme un point non couvert enferme
     * donc l'entretien : champ vide -> pas de proposition -> champ vide.
     */
    const etat = entretienComplet();
    expect(manquesDeCouverture(etat, INVENTAIRE_VIDE)).toEqual([]);
    // Même avec une fiche entièrement vierge, c'est-à-dire un entretien fini dont le diff n'a jamais été
    // appliqué : la proposition doit sortir, c'est elle qui écrira les champs.
    expect(pointsSansContenu(ficheVide()).length).toBeGreaterThan(0);
    expect(prochainsPoints(etat, INVENTAIRE_VIDE)[0]).toBeNull();
  });

  it('🔴 et l’ordre du jour dit « VIDÉ DEPUIS », pas « À POSER »', () => {
    // La réponse du client est toujours là : c'est le CHAMP qui a été effacé ailleurs. « À poser » ferait
    // reposer la question comme si elle n'avait jamais été traitée.
    const m = construireMessages(
      CTX({ fiche: ficheComplete({ ton: '' }) }), [{ role: 'user', content: 'bonjour' }], entretienComplet(),
    );
    expect(m[0]?.content).toMatch(/ton\s+\[VIDÉ DEPUIS, à reproposer\]/);
  });

  it('⚠️ un champ sans état « vide » signifiant ne rouvre rien', () => {
    // `silence` et `annonce_ia` portent toujours une valeur, `connaissance` peut légitimement être vide
    // (« rien pour l'instant » est une réponse). Les surveiller rouvrirait des questions sans raison.
    expect(pointsSansContenu(ficheComplete())).toEqual([]);
    expect(pointsSansContenu(ficheComplete()).some((c) => ['silence', 'annonce_ia', 'connaissance'].includes(c)))
      .toBe(false);
  });

  it('⚠️ l’identité n’est vide que si le NOM et les traits le sont', () => {
    // Un agent sans nom mais avec une personnalité a bien répondu à la question.
    expect(pointsSansContenu(ficheComplete({ nom: '' }))).toEqual([]);
    expect(pointsSansContenu(ficheComplete({ nom: '', personnalite: '' }))).toEqual(['identite']);
  });

  it('🔴 PENDANT la construction, un champ vide ne signale rien : la question du tour passe avant', () => {
    /**
     * Au premier tour, le client vient de répondre à `mission`, mais la fiche est encore vierge (le diff
     * n'est appliqué qu'à l'acceptation). L'entretien continue son ordre du jour, et le signalement de
     * champ vidé n'existe que dans la branche d'ÉVOLUTION, donc une fois tous les points couverts.
     */
    const debut: EtatEntretien = { poses: ['mission'], reponses: [{ point: 'mission', valeur: 'Aider.' }] };
    const vides = pointsSansContenu(ficheVide());
    expect(vides).toContain('mission');
    expect(manquesDeCouverture(debut, INVENTAIRE_VIDE)[0]).toBe('perimetre');
    const consigne = consigneDuTour(debut, INVENTAIRE_VIDE, vides);
    expect(consigne).toContain('LE POINT OUVERT : perimetre');
    expect(consigne).not.toContain('VIDÉ depuis');
  });
});
