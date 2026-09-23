import { describe, it, expect } from 'vitest';
import { routerLeLead, restrictionDuRoutage } from '../src/pubs/routage';
import type { DecisionRoutage, FaitsDuLead, PubDuLead } from '../src/pubs/routage';

/**
 * OÙ VA LE LEAD D'UNE PUBLICITÉ, LIGNE PAR LIGNE DU TABLEAU DE LA SPEC (§ 3.3).
 *
 * 🔴 CE QUE CES TESTS DÉFENDENT, ET POURQUOI ILS VALENT PLUS QUE LEUR TAILLE. Cette règle décide, pour un
 * vrai contact qui vient de cliquer sur une publicité PAYÉE, qui lui répond. Trois de ses six cas rendent
 * « on ne fait rien », et ils se ressemblent à l'œil sans vouloir dire la même chose : dans l'un, l'agent de
 * Meta répond à notre place et c'est voulu ; dans les deux autres, PERSONNE ne répond et c'est la garde de
 * modération ou de consentement qui parle. Les confondre coûterait soit un contact bloqué à qui l'on écrit,
 * soit un client qui paie des clics auxquels rien ne répond.
 *
 * ⚠️ L'ORDRE des tests de la règle EST une partie de la règle, pas un détail d'écriture : les trois derniers
 * `describe` de ce fichier ne vérifient que ça, en posant des faits qui rendraient une AUTRE réponse si
 * l'ordre changeait.
 */

const pub = (over: Partial<PubDuLead> = {}): PubDuLead => ({
  campagneId: '120210000000000001', destination: 'scenario', automationId: 'auto-1', ...over,
});

const faits = (over: Partial<FaitsDuLead> = {}): FaitsDuLead => ({
  pub: pub(), bloque: false, desabonne: false, enStandby: false, ...over,
});

describe('la règle de routage, ligne par ligne du tableau de la spec', () => {
  it('campagne INCONNUE : rien ne change, les déclencheurs ordinaires tournent', () => {
    expect(routerLeLead(faits({ pub: null }))).toEqual({ sorte: 'inchange', issue: 'inchange' });
  });

  it('destination AGENT DE META : aucun déclencheur, ni « toutes les pubs », ni « nouveau contact »', () => {
    expect(routerLeLead(faits({ pub: pub({ destination: 'agent_meta' }) })))
      .toEqual({ sorte: 'aucun_declencheur', issue: 'agent_meta' });
  });

  it('destination scénario, contact BLOQUÉ : rien', () => {
    expect(routerLeLead(faits({ bloque: true }))).toEqual({ sorte: 'aucun_declencheur', issue: 'bloque' });
  });

  it('destination scénario, contact DÉSABONNÉ : rien ne part, et l’arrivée le dit', () => {
    expect(routerLeLead(faits({ desabonne: true }))).toEqual({ sorte: 'aucun_declencheur', issue: 'desabonne' });
  });

  it('destination scénario, message STANDBY : on reprend le fil, puis SEULE l’automation de la pub', () => {
    expect(routerLeLead(faits({ enStandby: true })))
      .toEqual({ sorte: 'reprendre_puis_pub', automationId: 'auto-1' });
  });

  it('destination scénario, message NORMAL : SEULE l’automation de la pub', () => {
    expect(routerLeLead(faits())).toEqual({ sorte: 'pub_seule', issue: 'scenario', automationId: 'auto-1' });
  });
});

describe('l’ORDRE des tests, qui est une partie de la règle', () => {
  it('🔴 la campagne passe avant TOUT : inconnue, on ne regarde ni le blocage ni le désabonnement', () => {
    // C'est ce qui autorise le câblage à ne PAS aller chercher ces deux faits quand la campagne est
    // inconnue, donc à ne pas payer deux requêtes sur le chemin chaud de chaque message publicitaire. Sans
    // ce test, l'économie reposerait sur une lecture du code au lieu d'une propriété vérifiée.
    expect(routerLeLead({ pub: null, bloque: true, desabonne: true, enStandby: true }))
      .toEqual({ sorte: 'inchange', issue: 'inchange' });
  });

  it('🔴 la DESTINATION passe avant l’état du contact : l’agent de Meta répond même à un contact désabonné', () => {
    // Et c'est correct : NOUS n'envoyons rien. La garde de consentement protège nos envois, pas ceux de
    // l'agent de Meta, qui parle sur le numéro du client et que nous ne pilotons pas. Router autrement
    // laisserait croire qu'on a éteint quelque chose qu'on n'éteint pas.
    expect(routerLeLead({ pub: pub({ destination: 'agent_meta' }), bloque: true, desabonne: true, enStandby: false }))
      .toEqual({ sorte: 'aucun_declencheur', issue: 'agent_meta' });
  });

  it('🔴 BLOQUÉ passe avant DÉSABONNÉ : les deux rendent « rien », l’entonnoir les compte à part', () => {
    // Un contact à la fois bloqué et désabonné est d'abord un contact bloqué : c'est une décision de
    // modération, elle prime sur un état de consentement. L'écart ne se voit que dans l'issue écrite, et
    // c'est précisément ce que l'entonnoir affiche au client.
    expect(routerLeLead(faits({ bloque: true, desabonne: true })))
      .toEqual({ sorte: 'aucun_declencheur', issue: 'bloque' });
  });

  it('🔴 le STANDBY ne dispense d’AUCUNE garde : un contact désabonné qui arrive en standby n’est pas repris', () => {
    // Le piège serait de traiter le standby en premier, parce que c'est le cas « spécial ». Il ferait
    // prendre le fil à l'agent de Meta pour un contact à qui l'on n'a pas le droit d'écrire, donc un geste
    // chez Meta pour rien, et un fil retiré à celui qui pouvait encore répondre.
    expect(routerLeLead(faits({ desabonne: true, enStandby: true })))
      .toEqual({ sorte: 'aucun_declencheur', issue: 'desabonne' });
  });
});

describe('l’automation absente : la pub existe, son scénario a été supprimé', () => {
  it('message normal : la décision reste `pub_seule`, sans automation', () => {
    expect(routerLeLead(faits({ pub: pub({ automationId: null }) })))
      .toEqual({ sorte: 'pub_seule', issue: 'scenario', automationId: null });
  });

  it('🔴 et la restriction vaut `aucun`, JAMAIS `tous`', () => {
    // C'est l'état ATTEIGNABLE que le CHECK de la migration 0170 autorise exprès (`on delete set null` sur
    // le scénario). Retomber sur le chemin ordinaire ferait ramasser ce lead par une automation par
    // mot-clé, c'est-à-dire répondre à côté sur un clic payé.
    const d = routerLeLead(faits({ pub: pub({ automationId: null }) }));
    expect(restrictionDuRoutage(d, false)).toEqual({ sorte: 'aucun' });
  });
});

describe('ce que les déclencheurs ont le droit de faire', () => {
  const cas: Array<[string, DecisionRoutage, boolean, unknown]> = [
    ['campagne inconnue : chemin ordinaire', { sorte: 'inchange', issue: 'inchange' }, false, { sorte: 'tous' }],
    ['agent de Meta : aucun', { sorte: 'aucun_declencheur', issue: 'agent_meta' }, false, { sorte: 'aucun' }],
    ['bloqué : aucun', { sorte: 'aucun_declencheur', issue: 'bloque' }, false, { sorte: 'aucun' }],
    ['désabonné : aucun', { sorte: 'aucun_declencheur', issue: 'desabonne' }, false, { sorte: 'aucun' }],
    ['scénario : seule celle de la pub', { sorte: 'pub_seule', issue: 'scenario', automationId: 'a1' }, false, { sorte: 'seule', automationId: 'a1' }],
    ['reprise RÉUSSIE : seule celle de la pub', { sorte: 'reprendre_puis_pub', automationId: 'a1' }, true, { sorte: 'seule', automationId: 'a1' }],
    ['reprise REFUSÉE : aucun', { sorte: 'reprendre_puis_pub', automationId: 'a1' }, false, { sorte: 'aucun' }],
  ];
  for (const [nom, decision, reprise, attendu] of cas) {
    it(nom, () => { expect(restrictionDuRoutage(decision, reprise)).toEqual(attendu); });
  }

  it('🔴 sur un REFUS de Meta, on ne répond surtout pas par-dessus son agent', () => {
    // Meta garde le fil, donc son agent va répondre. Démarrer notre scénario en plus ferait recevoir DEUX
    // messages au contact, dont un venu d'un robot que le client croyait écarté. C'est le seuil du plan B
    // de la spec : une seule double réponse suffit à changer d'architecture.
    expect(restrictionDuRoutage({ sorte: 'reprendre_puis_pub', automationId: 'a1' }, false)).toEqual({ sorte: 'aucun' });
  });

  it('⚠️ la réussite de la reprise n’est PAS lue quand aucune reprise n’était demandée', () => {
    // Sinon un booléen mal câblé (toujours vrai, toujours faux) changerait le sort des cinq autres cas sans
    // qu'aucun test ne bouge.
    for (const [, decision, , attendu] of cas.filter(([, d]) => d.sorte !== 'reprendre_puis_pub')) {
      expect(restrictionDuRoutage(decision, true)).toEqual(attendu);
      expect(restrictionDuRoutage(decision, false)).toEqual(attendu);
    }
  });
});
