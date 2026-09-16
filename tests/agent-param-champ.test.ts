import { describe, it, expect } from 'vitest';
import { paramsOutil, toolParamsToJsonSchema } from '../src/agent/llm/tool-schema';
import { CHAMPS_CONTACT_AUTORISES, champDuContact } from '../src/agent/champs-contact';

/**
 * CLOUER UN PARAMÈTRE À UN CHAMP DU MINI-CRM (`source: 'champ'`).
 *
 * 🔴 POURQUOI CE CAS MANQUAIT, ET POURQUOI IL COMPTE POUR MCP. `source: 'contact'` ne peut désigner que
 * `wa_id` et `nom` : une liste fermée, délibérément. C'est trop étroit pour un serveur MCP, dont beaucoup
 * d'outils identifient par e-mail ou par référence client. Sans ce cas, ces paramètres-là retomberaient sur
 * le MODÈLE, c'est-à-dire précisément là où on ne les veut pas : un contact peut alors demander la donnée
 * d'un autre en changeant l'identifiant.
 *
 * 🔴 ET CE N'EST PAS UN CHEMIN LIBRE DÉGUISÉ, ce que la fermeture de `champs-contact.ts` interdit. La
 * différence tient en un mot, et elle est déjà écrite dans `src/agent/variables.ts` pour les variables de
 * requête : l'espace des clés de champs personnalisés est déclaré PAR LE CLIENT, pour ses contacts, et ne
 * contient par construction rien d'autre. `CHAMPS_CONTACT_AUTORISES` n'est donc PAS élargie, et un cas
 * ci-dessous le vérifie.
 */
describe('un parametre cloue a un champ personnalise', () => {
  it('est coerce avec sa cle', () => {
    const [p] = paramsOutil([{ name: 'email_client', type: 'string', source: 'champ', cle: 'email' }]);
    expect(p).toMatchObject({ name: 'email_client', source: 'champ', cle: 'email' });
  });

  it('🔴 n est JAMAIS expose au modele', () => {
    // La garde du module : tout ce qui n est pas rempli par le modele est invisible pour lui. Un champ
    // personnalise expose serait un champ que le contact peut faire changer en le demandant.
    const schema = toolParamsToJsonSchema([
      { name: 'ville', type: 'string', source: 'modele' },
      { name: 'email_client', type: 'string', source: 'champ', cle: 'email' },
    ]);
    expect(Object.keys(schema.properties)).toEqual(['ville']);
    expect(JSON.stringify(schema)).not.toContain('email');
  });

  it('🔴 un `champ` SANS cle est ECARTE, pas conserve a moitie', () => {
    // Un parametre `champ` sans cle ne designe rien : le garder produirait un argument que personne ne
    // remplit, donc un appel au systeme du client avec un trou dedans.
    expect(paramsOutil([{ name: 'x', type: 'string', source: 'champ' }])).toEqual([]);
    expect(paramsOutil([{ name: 'x', type: 'string', source: 'champ', cle: '   ' }])).toEqual([]);
  });

  it('🔴 un nom declare a la fois en `champ` et en `modele` se tranche en faveur du RUNTIME', () => {
    // 🔴 LE CAS QUE `reserves` FERME, et il devait etre elargi a `champ` en meme temps que le reste. Si la
    // declaration `champ` est ecartee (cle absente) pendant qu une declaration `modele` du MEME nom
    // survit, le modele reprend la main sur la cible : c est l IDOR exact que ce module existe pour fermer.
    const p = paramsOutil([
      { name: 'client_id', type: 'string', source: 'champ' }, // cassee : pas de cle
      { name: 'client_id', type: 'string', source: 'modele' },
    ]);
    expect(p).toEqual([]);
    expect(Object.keys(toolParamsToJsonSchema([
      { name: 'client_id', type: 'string', source: 'champ', cle: 'ref' },
      { name: 'client_id', type: 'string', source: 'modele' },
    ]).properties)).toEqual([]);
  });

  it('⚠️ la liste des attributs de fiche N EST PAS elargie', () => {
    // Ce cas ouvre une porte VOISINE, il n affaiblit pas celle qui existe. Un `contactPath` libre ferait
    // deriver un parametre de n importe quelle cle future de la projection, y compris d une qu on aurait
    // ajoutee pour tout autre chose.
    expect([...CHAMPS_CONTACT_AUTORISES]).toEqual(['wa_id', 'nom']);
  });
});

describe('lire la valeur d un champ personnalise sur la projection du contact', () => {
  const contact = { nom: 'Ada', tags: ['vip'], champs: { email: 'ada@exemple.test', points: 42, actif: true } };

  it('rend la valeur scalaire', () => {
    expect(champDuContact(contact, 'email')).toBe('ada@exemple.test');
    expect(champDuContact(contact, 'points')).toBe(42);
    expect(champDuContact(contact, 'actif')).toBe(true);
  });

  it('⚠️ un champ ABSENT rend null, et l appel partira sans : le serveur decide', () => {
    // Decision de Julien du 2026-09-16. Refuser l appel serait faux pour un parametre facultatif : un outil
    // qui refuse de chercher parce que le contact n a pas renseigne sa ville serait absurde. L avertissement
    // se pose au moment du CLOUAGE, sur les parametres que le schema distant declare obligatoires.
    expect(champDuContact(contact, 'inconnu')).toBeNull();
    expect(champDuContact(null, 'email')).toBeNull();
    expect(champDuContact({ nom: 'Ada' }, 'email')).toBeNull();
  });

  it('🔴 une valeur NON SCALAIRE rend null, jamais l objet', () => {
    // Un parametre d outil est scalaire. Laisser passer un objet enverrait au systeme du client une
    // structure qu il n attend pas, et surtout ferait voyager une donnee qu on n a pas regardee.
    expect(champDuContact({ champs: { bloc: { interne: 'secret' } } }, 'bloc')).toBeNull();
    expect(champDuContact({ champs: { liste: ['a', 'b'] } }, 'liste')).toBeNull();
  });

  it('⚠️ ne lit QUE sous `champs`, jamais a la racine de la projection', () => {
    // La projection porte aussi `nom` et `tags`. Les rendre atteignables par ce chemin creerait une seconde
    // facon de lire `nom`, et surtout ouvrirait toute cle future de la projection.
    expect(champDuContact(contact, 'nom')).toBeNull();
    expect(champDuContact(contact, 'tags')).toBeNull();
  });
});
