import { describe, it, expect } from 'vitest';
import { AGENDA } from '../src/agent/setup/couverture';
import { SCHEMA_PROPOSITION } from '../src/agent/setup/proposition';

/**
 * CHAQUE QUESTION POSÉE AU CLIENT DOIT AVOIR UN ENDROIT OÙ RANGER SA RÉPONSE.
 *
 * 🔴 C'EST L'INVARIANT QUE JULIEN A NOMMÉ, et il vaut plus que le compte des points : « il faut alors que le
 * câblage derrière soit cohérent ». Une question sans destination est pire qu'une question absente, parce
 * qu'elle fait travailler le client pour rien et lui laisse croire que son réglage est posé.
 *
 * ⚠️ DEUX POINTS N'ÉCRIVENT PAS DANS LA FICHE, ET C'EST LE CAS FRAGILE : `annonce_ia` et `silence` visent des
 * COLONNES de l'agent, donc des champs à part du schéma de proposition. Les oublier ne casse rien de visible.
 */
describe('L’ordre du jour de l’entretien', () => {
  it('🔴 les points HORS FICHE ont leur champ dans le schéma montré au modèle', () => {
    // Sans ce champ, le modèle n'a aucun moyen de rendre la réponse : on pose la question, il répond au
    // client, et le réglage garde sa valeur d'usine. Muet de bout en bout.
    const proprietes = Object.keys((SCHEMA_PROPOSITION as { properties: Record<string, unknown> }).properties);
    const horsFiche: Array<[string, string]> = [
      ['annonce_ia', 'mentionIaFrequence'],
      ['silence', 'inactiviteMinutes'],
    ];
    for (const [point, champ] of horsFiche) {
      expect(AGENDA.some((p) => p.code === point), `le point « ${point} » a disparu de l’ordre du jour`).toBe(true);
      expect(proprietes, `le point « ${point} » n’a nulle part où ranger sa réponse`).toContain(champ);
    }
  });

  it('chaque point a un code UNIQUE, une question et ce qu’il faut en obtenir', () => {
    // Un code en double ferait qu'un point marqué couvert en couvrirait un autre, donc sauterait une
    // question sans que rien ne le dise.
    expect(new Set(AGENDA.map((p) => p.code)).size).toBe(AGENDA.length);
    for (const p of AGENDA) {
      expect(p.question.trim().length, `${p.code} : pas de question`).toBeGreaterThan(10);
      expect(p.aObtenir.trim().length, `${p.code} : rien à en obtenir`).toBeGreaterThan(10);
    }
  });

  it('l’ordre place le SILENCE après les aboutissements et avant l’humain', () => {
    // On demande à quoi ressemble une conversation réussie, PUIS ce qui se passe quand il n'y en a pas,
    // PUIS qui reprend. Poser le silence avant les aboutissements ferait parler d'échec avant de savoir ce
    // qu'est un succès.
    const rang = (code: string) => AGENDA.findIndex((p) => p.code === code);
    expect(rang('aboutissements')).toBeLessThan(rang('silence'));
    expect(rang('silence')).toBeLessThan(rang('humain'));
  });
});
