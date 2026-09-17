import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONTACT_IDENTITES_SQL, CONVERSATION_DU_CONTACT_SQL } from '../src/crm/contact-history.pg';

const RACINE = resolve(__dirname, '..');
/**
 * ⚠️ FINS DE LIGNE NORMALISEES, ET SANS CA CE FICHIER REND UN FAUX POSITIF. Les fichiers du depot sont en
 * CRLF sur ce poste, mais un LITTERAL GABARIT normalise ses retours a la ligne en LF (regle du langage) :
 * la chaine lue a l'execution ne correspond donc PAS, caractere pour caractere, au texte du fichier. Le
 * meme piege a fait accuser le code a tort dans `tests/agregats-jour.test.ts`.
 */
const SOURCE = readFileSync(join(RACINE, 'src', 'crm', 'contact-history.pg.ts'), 'utf8').split('\r\n').join('\n');

/**
 * LA FICHE D'UN CONTACT ET SON HISTORIQUE DOIVENT PARLER DES MEMES CONVERSATIONS.
 *
 * 🔴 CE QUE CE FICHIER PROTEGE, ET QUI N'EST VISIBLE DANS AUCUNE DES DEUX REQUETES. Rattacher une
 * conversation a un contact ne se fait PAS par `contact_id` : cette colonne est nullable et posee en
 * `coalesce`, donc une conversation ouverte AVANT que le contact existe la garde a null jusqu'au message
 * suivant. Il faut rattraper par `wa_id`. Deux requetes portent desormais cette regle : la liste des
 * conversations de l'onglet Historique, et le resume affiche en champ de base sur la fiche.
 *
 * 🔴 RECOPIEE, ELLE DIVERGERAIT EN SILENCE. Le symptome ne serait pas une erreur mais une incoherence : la
 * fiche montrerait le resume d'une conversation absente de sa propre liste d'historique, ou l'inverse, et
 * les deux ecrans etant sur deux onglets, personne ne les voit cote a cote.
 */
describe('la fiche et l historique d un contact ne peuvent pas diverger', () => {
  it('🔴 les deux fragments sont CITES par les DEUX requetes, jamais recopies', () => {
    // Deux citations chacun : `listConversations` et `resumeContact`. Une seule voudrait dire qu'une des
    // deux requetes s'en est detachee et porte desormais sa propre version de la regle.
    expect(SOURCE.split('${CONTACT_IDENTITES_SQL}').length - 1,
      'les identites du contact doivent etre citees par les deux requetes').toBe(2);
    expect(SOURCE.split('${CONVERSATION_DU_CONTACT_SQL}').length - 1,
      'le rattachement conversation-contact doit etre cite par les deux requetes').toBe(2);
  });

  it('🔴 aucune requete ne reecrit le rattachement a la main', () => {
    /**
     * La faute qu'on attrape : quelqu'un qui, plutot que de citer, reecrit `c.contact_id = ct.id or ...`
     * dans sa propre requete. Les deux rattacheraient les memes conversations le jour ou c'est ecrit, et
     * plus le lendemain.
     *
     * ⚠️ CELUI-CI ATTRAPE LA RECOPIE **REFORMULEE**, PAS LA RECOPIE AU CARACTERE PRES, et la nuance a ete
     * mesuree par mutation : on retire les fragments du texte avant de compter (le motif y est forcement,
     * c'est leur definition), donc une copie IDENTIQUE disparait avec eux. C'est le test precedent, celui
     * du nombre de citations, qui tient ce cas-la. Les deux se completent, aucun ne suffit seul.
     */
    const sansFragments = SOURCE.split(CONVERSATION_DU_CONTACT_SQL).join('').split(CONTACT_IDENTITES_SQL).join('');
    expect(sansFragments.match(/c\.contact_id = ct\.id/g) ?? [],
      'le rattachement est recopie au lieu d’etre cite').toHaveLength(0);
    expect(sansFragments.match(/array_remove\(array\[ct\.digits, ct\.bsuid\], null\)/g) ?? [],
      'la liste des identites est recopiee au lieu d’etre citee').toHaveLength(0);
  });

  /**
   * 🔴 LES IDENTITES SE DERIVENT EN SQL, ELLES NE VIENNENT JAMAIS DU CLIENT. Accepter un `wa_id` envoye par
   * le front ouvrirait la lecture des conversations de n'importe qui : c'est un IDOR, exactement celui que
   * le depot s'interdit depuis convanalyzer. Le fragment ne lit que `contacts`, scope par `$1`/`$2`.
   */
  it('🔴 les identites sont derivees du contact, et scopees a l espace', () => {
    expect(CONTACT_IDENTITES_SQL).toContain('from contacts where id = $2 and tenant_id = $1');
  });

  /**
   * 🔴 LE RESUME EST LU, JAMAIS RECOPIE DANS LA FICHE DU CONTACT. C'etait un choix de coherence (deux
   * verites divergent), la retention en a fait un choix de CONFORMITE : la purge efface la conversation et
   * son analyse en cascade, une copie posee dans `contacts.fields` y survivrait, et on garderait un texte
   * tire de ce que la personne a raconte au-dela de la duree qu'on s'est engage a tenir.
   */
  it('🔴 rien n ecrit le resume dans les champs du contact', () => {
    const ecritures = SOURCE.match(/update contacts set|insert into contacts/g) ?? [];
    expect(ecritures, 'ce store est en LECTURE seule : il ne doit rien ecrire sur le contact').toHaveLength(0);
  });

  /**
   * 🔴 LE RESUME N'EST PAS UNE VARIABLE DE MESSAGE, ET L'OUBLI SE PAIERAIT DEUX FOIS. `contactVars`
   * (`src/crm/render.ts`) est le chemin d'envoi d'une CAMPAGNE : une derivation par destinataire y couterait
   * une jointure par personne sur des envois de plusieurs milliers. Et surtout, envoyer a quelqu'un le
   * resume que notre modele a fait de sa propre conversation n'est pas un geste a rendre possible en un clic.
   */
  it('🔴 la table de substitution des messages ne connait pas le resume', () => {
    const render = readFileSync(join(RACINE, 'src', 'crm', 'render.ts'), 'utf8');
    expect(render.includes('summary'), 'le resume ne doit pas devenir une variable de message').toBe(false);
    expect(render.includes('conversation_analysis'), 'le rendu d’un message ne doit pas lire l’analyse').toBe(false);
  });
});
