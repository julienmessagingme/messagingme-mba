import { describe, it, expect } from 'vitest';
import { sortiesDeLaFiche } from '../src/agent/agent-store.pg';

/**
 * Lecture des règles d'arrêt d'une fiche d'agent. `fiche` est du jsonb écrit par l'IA de construction, donc
 * opaque : c'est la logique la plus subtile du lot, et elle décide de ce que le builder dessine.
 *
 * Deux exigences opposées, et l'ordre entre elles est le sujet. TOLÉRER une fiche mal formée, parce qu'une
 * seule ligne bancale ne doit pas rendre tout un scénario inéditable. Mais REJETER un code qui ne peut pas
 * servir de handle d'arête, parce qu'un handle exotique produit des écarts silencieux entre ce que le builder
 * dessine et ce que le moteur route.
 */
describe('sortiesDeLaFiche', () => {
  it('lit les règles bien formées, dans l ordre', () => {
    expect(sortiesDeLaFiche({ sorties: [{ code: 'besoin_cerne', label: 'Besoin cerné' }, { code: 'hors_sujet', label: 'Hors sujet' }] }))
      .toEqual([{ code: 'besoin_cerne', label: 'Besoin cerné' }, { code: 'hors_sujet', label: 'Hors sujet' }]);
  });

  it('un libellé absent ou vide retombe sur le code, jamais sur une ligne muette', () => {
    // Une sortie sans nom serait un point à relier dont personne ne saurait ce qu'il fait.
    expect(sortiesDeLaFiche({ sorties: [{ code: 'rdv' }, { code: 'devis', label: '   ' }] }))
      .toEqual([{ code: 'rdv', label: 'rdv' }, { code: 'devis', label: 'devis' }]);
  });

  it('🔴 un code qui ne peut pas servir de handle est REJETÉ', () => {
    // Espaces, accents, majuscules, ponctuation : tout ce qui rendrait `sortie:<code>` ambigu d'un côté ou de
    // l'autre. La casse, elle, est ramenée en bas plutôt que rejetée : c'est une faute de saisie courante.
    const s = sortiesDeLaFiche({
      sorties: [
        { code: 'Besoin Cerné' }, { code: 'avec espace' }, { code: 'ponctuation!' }, { code: '' },
        { code: 'a'.repeat(33) }, { code: 42 }, { code: 'BESOIN', label: 'Besoin' },
      ],
    });
    expect(s).toEqual([{ code: 'besoin', label: 'Besoin' }]);
  });

  it('les doublons sont écartés : deux sorties du même code en cacheraient une', () => {
    // Deux poignées du même nom sur un bloc : la seconde serait inatteignable, et l'arête tirée dessus
    // désignerait la première.
    expect(sortiesDeLaFiche({ sorties: [{ code: 'rdv', label: 'Premier' }, { code: 'RDV', label: 'Second' }] }))
      .toEqual([{ code: 'rdv', label: 'Premier' }]);
  });

  it('une fiche vide, absente ou d une forme inattendue ne LÈVE jamais', () => {
    // Le builder tomberait, et le client ne pourrait plus éditer AUCUN bloc de son scénario.
    for (const fiche of [null, undefined, {}, { sorties: null }, { sorties: 'texte' }, { sorties: [null, 3, 'x'] }, 'pas un objet', 42]) {
      expect(sortiesDeLaFiche(fiche)).toEqual([]);
    }
  });
});
