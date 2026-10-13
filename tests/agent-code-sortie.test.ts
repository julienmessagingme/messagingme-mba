import { describe, it, expect } from 'vitest';
import { CODE_SORTIE_RE, ficheAgentSchema, normaliserCodeSortie } from '../src/agent/fiche';

/**
 * Le CODE d'une règle d'arrêt : ce que la normalisation produit, et ce que le schéma de la fiche accepte.
 *
 * La règle est partagée par la console (qui l'applique sous les yeux du client) et le serveur (dont l'assistant de
 * construction ramène un code proposé dans l'alphabet). 🔴 Ce qui reste à prouver, c'est que la normalisation ne
 * produit jamais un code que le schéma refuserait : sinon le client saisit tranquillement, et l'enregistrement échoue
 * en 400 sur un champ qu'il croyait bon.
 */
describe('code d une règle d arrêt : la normalisation mène à ce que le schéma accepte', () => {
  it('🔴 tout ce que la normalisation produit est ACCEPTÉ par le schéma de la fiche', () => {
    const saisies = [
      'Besoin cerné', 'BESOIN_CERNÉ', '  rendez-vous  ', 'a', 'devis 2026', 'ça marche !',
      'trop___de___underscores', 'déjà-vu', 'x'.repeat(80), '123', 'a_b_c',
      'coordonnees transmises au conseiller', 'demande_transmise_au_service_client_ab',
      // Une troncature qui tombe PILE sur un souligné (la borne du défaut du 2026-09-17) : le code ne doit pas finir
      // par lui.
      'a'.repeat(31) + '_bbbb', 'a'.repeat(32) + '_bbbb',
    ];
    for (const brut of saisies) {
      const code = normaliserCodeSortie(brut);
      if (code === '') continue; // rien à ajouter : le bouton reste désactivé
      expect(CODE_SORTIE_RE.test(code), `« ${brut} » -> « ${code} »`).toBe(true);
      // Et la fiche entière l'accepte, pas seulement la regex prise isolément.
      expect(ficheAgentSchema.safeParse({ sorties: [{ code, label: 'x' }] }).success).toBe(true);
    }
  });

  it('une saisie qui ne donne AUCUN code exploitable rend une chaîne vide, jamais un code bancal', () => {
    // Le bouton « Ajouter » est alors désactivé : mieux vaut ne rien pouvoir ajouter qu'ajouter « _ ».
    for (const brut of ['', '   ', '!!!', '___', '- -']) {
      expect(normaliserCodeSortie(brut)).toBe('');
    }
  });

  it('la normalisation ne change rien à un code DÉJÀ valide', () => {
    // Sinon rouvrir une fiche déplacerait ses codes, donc casserait les arêtes déjà tirées dans le builder.
    for (const code of ['besoin_cerne', 'rdv', 'devis2026', 'a_b_c']) {
      expect(normaliserCodeSortie(code)).toBe(code);
    }
  });

  it('la troncature à 32 caractères ne laisse jamais de souligné final', () => {
    expect(normaliserCodeSortie('a'.repeat(31) + '_bbbb')).toBe('a'.repeat(31));
    expect(normaliserCodeSortie('x'.repeat(80))).toBe('x'.repeat(32));
  });
});
