import { describe, it, expect } from 'vitest';
import { isSendableButtonUrl as web } from '../web/lib/button-url';
import { isSendableButtonUrl as api } from '../src/meta/button-url';

// Les deux builds (Next et API) ne partagent aucun module : la règle est écrite deux fois. Ce test casse dès
// qu'elles divergent, sinon le formulaire accepterait une URL que le serveur refuse (ou l'inverse), et
// l'opérateur récupérerait le message de chemin JSON de Meta qu'on cherche justement à ne plus lui montrer.
const CAS: Array<[string, boolean]> = [
  ['https://exemple.fr', true],
  ['http://exemple.fr/page?a=1#b', true],
  ['https://sous.domaine.exemple.fr/chemin', true],
  ['exemple.fr', false],            // le cas réel : adresse sans schéma
  ['www.exemple.fr', false],
  ['', false],
  ['   ', false],
  ['https://', false],
  ['https://exemple', false],       // pas de domaine de premier niveau
  ['https://exemple.fr /x', false], // espace collée en fin de saisie
  ['ftp://exemple.fr', false],
  ['javascript:alert(1)', false],
  ['{{1}}', false],
  // URL DYNAMIQUE d'un bouton top-level : Meta l'accepte (le repo pose déjà son exemple), donc la règle
  // d'URL ne doit PAS la rejeter. Le refus des variables est propre au CAROUSEL, et vit ailleurs.
  ['https://exemple.fr/produit/{{1}}', true],
];

describe('parité isSendableButtonUrl front / back', () => {
  it('les deux implémentations rendent le même verdict sur chaque cas', () => {
    for (const [url, attendu] of CAS) {
      expect(web(url), `front sur « ${url} »`).toBe(attendu);
      expect(api(url), `back sur « ${url} »`).toBe(attendu);
    }
  });
});
