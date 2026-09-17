import { describe, it, expect } from 'vitest';
import { normaliserCodeSortie, MAX_SORTIES as MAX_FRONT } from '../web/lib/agent-sorties';
import {
  CODE_SORTIE_RE, MAX_SORTIES, ficheAgentSchema, normaliserCodeSortie as normaliserServeur,
} from '../src/agent/fiche';

/**
 * Parité du CODE d'une règle d'arrêt, entre ce que le front normalise et ce que le serveur accepte.
 *
 * 🔴 CE QUI SE PASSE SI ELLE DIVERGE. Trop STRICT côté front : le client ne peut pas saisir un code que le
 * serveur aurait accepté, il ne le saura jamais. Trop LARGE : il saisit tranquillement, et l'enregistrement
 * échoue en 400 sur un champ qu'il croyait bon. Dans les deux cas la faute est invisible en relecture, parce
 * que les deux règles sont écrites dans deux fichiers que personne ne lit ensemble.
 */
describe('code d une règle d arrêt : le front normalise vers ce que le serveur accepte', () => {
  it('🔴 tout ce que la normalisation produit est ACCEPTÉ par le schéma serveur', () => {
    const saisies = [
      'Besoin cerné', 'BESOIN_CERNÉ', '  rendez-vous  ', 'a', 'devis 2026', 'ça marche !',
      'trop___de___underscores', 'déjà-vu', 'x'.repeat(80), '123', 'a_b_c',
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

  it('le plafond de règles d arrêt est le même des deux côtés', () => {
    expect(MAX_FRONT).toBe(MAX_SORTIES);
  });

  /**
   * 🔴 LES DEUX NORMALISATIONS RENDENT LE MÊME CODE, CARACTÈRE POUR CARACTÈRE (2026-09-17).
   *
   * Le serveur en a une depuis que l'assistant de construction s'en sert pour ramener un code proposé dans
   * l'alphabet, au lieu de refuser toute la proposition. Deux implémentations d'une même règle finissent par
   * diverger : le jour où elles le feraient, le code qu'un client voit dans le diff de l'assistant cesserait
   * d'être celui que son formulaire aurait produit pour la même phrase, et les arêtes du builder
   * désigneraient des sorties qui n'existent pas.
   *
   * ⚠️ Le comparatif porte sur les cas qui SÉPARENT les implémentations : accents, majuscules, ponctuation,
   * soulignés en tête et en queue, et surtout la TRONCATURE à 32 caractères, qui est la borne que le défaut
   * du 2026-09-17 a révélée.
   */
  it('🔴 le serveur et le front normalisent EXACTEMENT pareil', () => {
    const saisies = [
      'Besoin cerné', 'BESOIN_CERNÉ', '  rendez-vous  ', 'déjà-vu', 'ça marche !', 'trop___de___underscores',
      'coordonnees transmises au conseiller', 'demande_transmise_au_service_client_ab', 'x'.repeat(80),
      '', '   ', '!!!', '___', '- -', 'a', '123', 'a_b_c', 'devis 2026',
      // Une troncature qui tombe PILE sur un souligné : le code ne doit pas finir par lui.
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_bbbb',
    ];
    for (const brut of saisies) {
      expect(normaliserServeur(brut), `« ${brut} »`).toBe(normaliserCodeSortie(brut));
    }
  });
});
