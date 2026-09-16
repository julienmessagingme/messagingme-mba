import { describe, it, expect } from 'vitest';
import { paramsOutil, toolParamsToJsonSchema } from '../src/agent/llm/tool-schema';

/**
 * Le contrat que la migration 0152 ajoute au catalogue.
 *
 * 🔴 CE QUI SE VÉRIFIE ICI, ET CE QUI NE PEUT PAS. L'écriture de `source_kind` et le refus du croisement
 * vivent dans une requête SQL : ils sont éprouvés par `tests/integration/outil-source-kind.integration.test.ts`,
 * contre un vrai Postgres. Ce fichier-ci garde ce qui est vrai sans base : la forme du paramètre `cheminMcp`,
 * et surtout le fait qu'il ne parte JAMAIS au modèle.
 */
describe('cheminMcp, le chemin dans le schema distant', () => {
  it('survit a la coercion : sans lui, on ne sait plus recomposer l objet imbrique', () => {
    const [p] = paramsOutil([{ name: 'filtres_ville', type: 'string', source: 'modele', cheminMcp: 'filtres.ville' }]);
    expect(p!.cheminMcp).toBe('filtres.ville');
  });

  it('🔴 n est JAMAIS expose au modele', () => {
    // 🔴 Le schema envoye au modele ne porte que des noms PLATS. Y laisser filtrer un chemin distant
    // apprendrait au modele la forme interne du systeme du client, et surtout ferait croire qu il peut
    // viser une sous-cle lui-meme.
    const schema = toolParamsToJsonSchema([
      { name: 'filtres_ville', type: 'string', source: 'modele', cheminMcp: 'filtres.ville' },
    ]);
    expect(Object.keys(schema.properties)).toEqual(['filtres_ville']);
    expect(JSON.stringify(schema)).not.toContain('filtres.ville');
  });

  it('n est PAS trime, contrairement aux autres champs', () => {
    // C est un chemin du schema DISTANT : un espace y appartient au nom de la propriete du serveur, et le
    // nettoyer ferait viser une cle qui n existe pas chez lui.
    const [p] = paramsOutil([{ name: 'a', type: 'string', source: 'modele', cheminMcp: ' curieux .cle ' }]);
    expect(p!.cheminMcp).toBe(' curieux .cle ');
  });

  it('un chemin vide ou non textuel est ECARTE, pas conserve a moitie', () => {
    for (const mauvais of ['', 42, null, {}]) {
      const [p] = paramsOutil([{ name: 'a', type: 'string', source: 'modele', cheminMcp: mauvais }]);
      expect(p!.cheminMcp).toBeUndefined();
    }
  });

  it('un parametre CLOUE garde son chemin ET reste invisible du modele', () => {
    // Le cas qui compte pour la garde d identite : la feuille imbriquee est remplie par le runtime, et le
    // modele ne sait meme pas qu elle existe.
    const params = paramsOutil([
      { name: 'filtres_ville', type: 'string', source: 'modele', cheminMcp: 'filtres.ville' },
      { name: 'client_id', type: 'string', source: 'contact', contactPath: 'wa_id', cheminMcp: 'client.id' },
    ]);
    expect(params.find((p) => p.name === 'client_id')!.cheminMcp).toBe('client.id');
    const schema = toolParamsToJsonSchema(params);
    expect(Object.keys(schema.properties)).toEqual(['filtres_ville']);
  });
});
