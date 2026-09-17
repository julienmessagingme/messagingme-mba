import { describe, it, expect } from 'vitest';
import { basculesRcs, FENETRE_BASCULE_MS } from '../src/stats/rcs-conversationnel';

/**
 * QUAND UN RCS DEVIENT CONVERSATIONNEL, ET CE QUE CA FAIT BASCULER.
 *
 * La regle est de Julien (2026-09-17) : « un RCS non conversationnel c'est un RCS seul et pas associe a un
 * scenario. Si un RCS est envoye avec un scenario, si le client appuie sur un bouton ou repond et declenche
 * le scenario ca devient un RCS conversationnel. Si le client n'appuie sur rien, cela reste un RCS non
 * conversationnel. » Puis : « ce qui passe dans 8 cts = le RCS initial et tous les messages qui suivent et
 * qui sont envoyes sur RCS (quick answer and so on). Pas de facturation de message de service comme sur
 * WhatsApp. »
 *
 * 🔴 CE QUE CES TESTS PROTEGENT, ET QUI NE SE VOIT PAS EN LISANT LE CODE : le prix d'un message change
 * APRES son envoi. C'est le seul endroit du produit ou un cout passe est mouvant, et sans borne le total
 * de janvier bougerait encore en juillet sans que personne ne puisse dire pourquoi. La borne de sept jours
 * n'est pas un nombre choisi ici : c'est celle d'`engagementsParCampagne`, reprise telle quelle pour qu'une
 * SEULE regle serve deux ecrans du meme onglet.
 */

const E = (id: string, conv: string, at: string, waId = '336') => ({ id, conversationId: conv, waId, at });

describe('un RCS bascule en conversationnel quand le contact reagit', () => {
  it('🔴 sans reaction, il reste NON conversationnel', () => {
    // Le cas par defaut, et de loin le plus frequent. « Si le client n'appuie sur rien, cela reste un RCS
    // non conversationnel. »
    expect(basculesRcs([E('m1', 'c1', '2026-09-01T10:00:00Z')], []).size).toBe(0);
  });

  it('🔴 une reaction fait basculer TOUT l echange, pas le seul message declencheur', () => {
    // « Le RCS initial ET tous les messages qui suivent. » Deux tarifs dans le meme fil auraient demande
    // une explication a chaque lecture, et le total n aurait plus correspondu a aucune facture simple.
    const envois = [E('m1', 'c1', '2026-09-01T10:00:00Z'), E('m2', 'c1', '2026-09-01T10:05:00Z')];
    expect([...basculesRcs(envois, [{ waId: '336', at: '2026-09-01T10:02:00Z' }])]).toEqual(['c1']);
  });

  it('🔴 une reaction APRES sept jours ne fait rien basculer', () => {
    // Sans borne haute, le cout d'un mois clos continuerait de monter indefiniment. Julien : « aucune
    // personne ne reagira au bout d'une semaine ou d'un mois, tout se joue dans les 24 h max », donc sept
    // jours est tres au-dessus du comportement reel, et surtout c'est une regle qui existe deja.
    const envois = [E('m1', 'c1', '2026-09-01T10:00:00Z')];
    expect(basculesRcs(envois, [{ waId: '336', at: '2026-09-09T10:00:00Z' }]).size).toBe(0);
  });

  it('⚠️ juste AVANT la borne, ca bascule encore ; juste APRES, non', () => {
    // La borne se teste des DEUX cotes, sinon on ne sait pas si elle est a sept jours ou a l infini.
    const t0 = Date.parse('2026-09-01T10:00:00Z');
    const envois = [E('m1', 'c1', '2026-09-01T10:00:00Z')];
    const juste = new Date(t0 + FENETRE_BASCULE_MS - 1000).toISOString();
    const apres = new Date(t0 + FENETRE_BASCULE_MS + 1000).toISOString();
    expect(basculesRcs(envois, [{ waId: '336', at: juste }]).size).toBe(1);
    expect(basculesRcs(envois, [{ waId: '336', at: apres }]).size).toBe(0);
  });

  it('🔴 une reaction AVANT l envoi ne compte pas', () => {
    // Elle appartient a un echange anterieur. Sans borne basse, tout fil deja actif basculerait pour
    // toujours, et le tarif conversationnel deviendrait le tarif par defaut de tout client bavard.
    const envois = [E('m1', 'c1', '2026-09-01T10:00:00Z')];
    expect(basculesRcs(envois, [{ waId: '336', at: '2026-08-30T10:00:00Z' }]).size).toBe(0);
  });

  it('🔴 la reaction d un AUTRE contact ne fait pas basculer cet echange', () => {
    // La garde d isolation la plus betement oubliable : sans le rapprochement par numero, la reaction de
    // n importe qui ferait basculer les envois de tout le monde, et le cout RCS de l espace exploserait.
    const envois = [E('m1', 'c1', '2026-09-01T10:00:00Z', '336')];
    expect(basculesRcs(envois, [{ waId: '337', at: '2026-09-01T10:02:00Z' }]).size).toBe(0);
  });

  it('plusieurs echanges : seuls ceux dont le contact a reagi basculent', () => {
    const envois = [
      E('m1', 'c1', '2026-09-01T10:00:00Z', '336'),
      E('m2', 'c2', '2026-09-01T11:00:00Z', '337'),
      E('m3', 'c3', '2026-09-01T12:00:00Z', '338'),
    ];
    const bascules = basculesRcs(envois, [
      { waId: '336', at: '2026-09-01T10:30:00Z' },
      { waId: '338', at: '2026-09-02T09:00:00Z' },
    ]);
    expect([...bascules].sort()).toEqual(['c1', 'c3']);
  });

  it('⚠️ un horodatage ILLISIBLE ne fait pas basculer, et ne jette pas', () => {
    // Une donnee de base peut etre nulle ou mal formee. Le bon comportement est de ne pas facturer le tarif
    // le plus cher sur une valeur qu'on n'a pas su lire : dans le doute, on ne majore pas le client.
    const envois = [E('m1', 'c1', 'pas-une-date')];
    expect(basculesRcs(envois, [{ waId: '336', at: '2026-09-01T10:02:00Z' }]).size).toBe(0);
    expect(basculesRcs([E('m1', 'c1', '2026-09-01T10:00:00Z')], [{ waId: '336', at: 'nawak' }]).size).toBe(0);
  });

  it('⚠️ la fenetre est EXACTEMENT celle des engagements : sept jours', () => {
    // Ecrit ici pour qu'une modification distraite echoue bruyamment. Deux fenetres differentes sur le meme
    // ecran feraient diverger le numerateur et le denominateur du cout par engage.
    expect(FENETRE_BASCULE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
