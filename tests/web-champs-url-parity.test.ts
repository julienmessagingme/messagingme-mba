import { describe, it, expect } from 'vitest';
import { analyserChampsUrl as web, CLES_DE_BASE_URL as baseWeb, exempleUrl } from '../web/lib/champs-url';
import { analyserChampsUrl as api, CLES_DE_BASE_URL as baseApi } from '../src/links/champs-url';

// Les deux builds (Next et API) ne partagent aucun module : la règle des champs d'adresse est écrite deux fois. Ce
// test casse dès qu'elles divergent, sinon le formulaire accepterait une adresse que le serveur refuse (ou l'inverse),
// et le refus de l'hôte, qui ferme un redirecteur ouvert, pourrait n'exister que d'un côté.
const CAS: string[] = [
  'https://client.fr/promo',
  'https://client.fr/commande/{numero_commande}',
  'https://client.fr/c/{a}/{b}?x={a}#{telephone}',
  'https://client.fr?{a}',
  'https://client.fr#{a}',
  'https://{a}.client.fr/x',
  'https://client.{a}/x',
  'https://client.fr{a}/x',
  'https://{a}@client.fr/x',
  'https://client.fr:{a}/x',
  'http{a}://client.fr/x',
  'client.fr/{a}',
  'https://client.fr\\{a}',
  'https://client.fr/{a',
  'https://client.fr/a}',
  'https://client.fr/{}',
  'https://client.fr/{a-b}',
  'https://client.fr/{a}/{{1}}',
  'https://client.fr/produit/{{1}}',
  '  https://client.fr/{a}  ',
];

describe('parité analyserChampsUrl front / back', () => {
  it('les deux implémentations rendent le même verdict sur chaque cas', () => {
    for (const url of CAS) expect(web(url), url).toEqual(api(url));
  });

  it('les mêmes champs de base', () => {
    expect([...baseWeb]).toEqual([...baseApi]);
  });

  it('l’aperçu de la console encode comme la redirection', () => {
    expect(exempleUrl('https://client.fr/commande/{numero_commande}')).toBe('https://client.fr/commande/A1234');
    expect(exempleUrl('https://client.fr/?t={telephone}')).toBe('https://client.fr/?t=%2B33612345678');
    expect(exempleUrl('https://client.fr/promo')).toBeNull();
    expect(exempleUrl('https://{prenom}.client.fr/')).toBeNull();
  });
});
