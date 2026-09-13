import { describe, it, expect } from 'vitest';
import { estDemandeArret, estPeutEtreUnArret, classerDemandeArret } from '../src/crm/consentement';

/**
 * LA RÈGLE ÉLARGIE, EN OBSERVATION.
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE N'EST PAS « la règle reconnaît bien les refus », C'EST QU'ELLE N'AGIT PAS.
 * Mesure du 2026-09-13 sur la base de production : sur 135 messages entrants porteurs de texte, ZÉRO reconnu
 * par la règle ancrée, ZÉRO par une règle élargie candidate. Il n'y a rien sur quoi calibrer, donc élargir
 * au jugé serait exactement ce que le code déconseille. La règle OBSERVE, un humain tranchera au vu de vrais
 * messages, et ce test est ce qui empêche l'observation de se transformer en désabonnement un jour de
 * distraction.
 */
describe('la règle qui AGIT ne bouge pas', () => {
  it('🔴 « stop » en début de message désabonne toujours, sans confirmation', () => {
    for (const texte of ['STOP', 'stop', '  stop  ', 'Stop merci', 'arrêt', 'unsubscribe', 'désabonner']) {
      expect(estDemandeArret(texte), texte).toBe(true);
      expect(classerDemandeArret(texte), texte).toBe('arret');
    }
  });

  /**
   * ⚠️ L'ANCRAGE EST CE QUI REND LA RÈGLE SÛRE, et il ne doit pas bouger en ajoutant la règle élargie à
   * côté. Un faux positif ici désabonne quelqu'un en silence : il cesse simplement de recevoir.
   */
  it('⚠️ ...et « stop » AILLEURS dans la phrase ne désabonne toujours pas', () => {
    for (const texte of ['je ne peux pas m’arrêter là', 'c’est du non-stop', 'je passe à l’arrêt']) {
      expect(estDemandeArret(texte), texte).toBe(false);
    }
  });

  /**
   * 🔴 CE QUE LA RÈGLE ACTUELLE DÉSABONNE ET QUI N'EST PAS UN REFUS. Ce test fige le comportement d'AUJOURD'HUI,
   * il ne le valide pas : le docblock d'`estDemandeArret` citait « arrêt de bus » comme un cas évité, alors
   * que cette phrase COMMENCE par « arrêt ». Sur un espace d'assureur, « arrêt maladie » est un message
   * ordinaire, et la personne cesserait de recevoir sans que quiconque le sache.
   *
   * ⚠️ Resserrer l'ancrage ferait perdre « stop merci », qui est un vrai refus : c'est un arbitrage produit,
   * posé à Julien. En attendant, ce test existe pour que le comportement ne bouge pas PAR ACCIDENT, et pour
   * que quiconque le modifie voie la liste de ce qu'il change.
   */
  it('🔴 CONNU ET POSÉ À JULIEN : « arrêt maladie » désabonne aujourd’hui', () => {
    for (const texte of ['arrêt maladie', 'arrêt de bus', 'stop covid', 'stopper la commande', 'arrêt du traitement']) {
      expect(estDemandeArret(texte), `${texte} : comportement ACTUEL, figé le temps de l’arbitrage`).toBe(true);
    }
  });
});

describe('la règle ÉLARGIE reconnaît, et ne désabonne personne', () => {
  const refusNonAncres = [
    'je voudrais me désabonner s’il vous plaît',
    'arrêtez de me contacter',
    'arretez de m envoyer des messages',
    'ne m’envoyez plus rien',
    'plus de publicité merci',
    'retirez-moi de votre liste',
    'please remove me from this list',
    'laissez-moi tranquille',
    'je ne veux plus recevoir vos offres',
  ];

  it('elle reconnaît les formulations que la règle ancrée laisse passer', () => {
    for (const texte of refusNonAncres) {
      expect(estPeutEtreUnArret(texte), texte).toBe(true);
    }
  });

  /**
   * 🔴 LE CAS LE PLUS IMPORTANT DU FICHIER. Sans lui, un jour de distraction transformerait l'observation en
   * désabonnement automatique, sur une règle que PERSONNE n'a calibrée faute de données.
   */
  it('🔴 un refus reconnu par la SEULE règle élargie ne compte PAS comme un arrêt', () => {
    for (const texte of refusNonAncres) {
      expect(estDemandeArret(texte), `${texte} : la règle qui AGIT ne doit pas le reconnaître`).toBe(false);
      expect(classerDemandeArret(texte), texte).toBe('peut_etre');
    }
  });

  it('un message ordinaire n’est ni l’un ni l’autre', () => {
    for (const texte of ['bonjour', 'ma commande est arrivée ?', 'merci beaucoup', 'je veux un devis', '']) {
      expect(classerDemandeArret(texte), texte).toBe('non');
    }
  });

  /**
   * ⚠️ LA RÈGLE ANCRÉE GAGNE TOUJOURS. Un message qui commence par « stop » est un arrêt, même s'il porte
   * par ailleurs une formule que la règle élargie reconnaîtrait : sinon il descendrait en « à confirmer »
   * et cesserait d'être appliqué tout seul, ce qui serait une RÉGRESSION du respect des refus.
   */
  it('⚠️ « stop, je veux me désabonner » reste un ARRÊT, pas un « peut-être »', () => {
    expect(classerDemandeArret('stop, je veux me désabonner')).toBe('arret');
  });

  it('ni null ni vide ne déclenchent quoi que ce soit', () => {
    expect(classerDemandeArret(null)).toBe('non');
    expect(classerDemandeArret('   ')).toBe('non');
    expect(estPeutEtreUnArret(null)).toBe(false);
  });
});
