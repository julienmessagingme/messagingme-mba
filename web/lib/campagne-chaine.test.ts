import { describe, it, expect } from 'vitest';
import {
  chaineDeLaFormule,
  aUnRepli,
  reessaiProposable,
  etageRenseigne,
  rangsSansContenu,
  heuresDOuvertureReglees,
  debitBorne,
  DEBIT_DEFAUT,
  DEBIT_MAX,
  DEBIT_MIN,
  assignationProposable,
  devenirParDefaut,
} from './campagne-chaine';

/**
 * 🔴 CE QUE CES CAS SÉPARENT. Un jeu qui n'exercerait que « WhatsApp seul » et « repli WhatsApp puis
 * RCS » laisse passer au moins trois implémentations différentes : celle qui fabrique toujours deux
 * étages, celle qui prend le second canal dans un état d'écran au lieu de le déduire, et celle qui ajoute
 * le troisième niveau même sans repli. Il faut donc le canal seul AVEC un troisième niveau résiduel, les
 * DEUX ordres de repli, et le SMS.
 */
describe('la chaine que decrivent les choix de l etape Canal', () => {
  it('un canal seul donne UN etage, au rang 1', () => {
    expect(chaineDeLaFormule({ formule: 'whatsapp', premier: 'whatsapp', troisieme: 'aucun' }))
      .toEqual([{ rang: 1, canal: 'whatsapp' }]);
    expect(chaineDeLaFormule({ formule: 'rcs', premier: 'whatsapp', troisieme: 'aucun' }))
      .toEqual([{ rang: 1, canal: 'rcs' }]);
  });

  it('🔴 un canal seul ignore un troisieme niveau RESIDUEL', () => {
    // L'utilisateur choisit « avec repli » + e-mail, puis revient a « WhatsApp ». L'ecran ne montre plus
    // la question du troisieme niveau : une chaine qui le garderait porterait un etage 3 sans etage 2,
    // que personne n'a jamais vu a l'ecran.
    expect(chaineDeLaFormule({ formule: 'whatsapp', premier: 'rcs', troisieme: 'email' }))
      .toEqual([{ rang: 1, canal: 'whatsapp' }]);
  });

  it('🔴 le second canal se DEDUIT du premier, dans les deux sens', () => {
    expect(chaineDeLaFormule({ formule: 'repli', premier: 'whatsapp', troisieme: 'aucun' }))
      .toEqual([{ rang: 1, canal: 'whatsapp' }, { rang: 2, canal: 'rcs' }]);
    // L'autre sens, et il compte : une implementation qui ecrirait 'rcs' en dur au rang 2 passerait le
    // premier cas et se tromperait sur celui-ci.
    expect(chaineDeLaFormule({ formule: 'repli', premier: 'rcs', troisieme: 'aucun' }))
      .toEqual([{ rang: 1, canal: 'rcs' }, { rang: 2, canal: 'whatsapp' }]);
  });

  it('le troisieme niveau e-mail ajoute le rang 3, apres les deux autres', () => {
    expect(chaineDeLaFormule({ formule: 'repli', premier: 'rcs', troisieme: 'email' }))
      .toEqual([{ rang: 1, canal: 'rcs' }, { rang: 2, canal: 'whatsapp' }, { rang: 3, canal: 'email' }]);
  });

  it('🔴 le SMS ne produit AUCUN etage : la table le refuserait', () => {
    // `campaign_etages.canal` porte `check (canal in ('whatsapp', 'rcs', 'email'))`. Un etage SMS serait
    // une erreur d'ecriture en base au moment de creer la campagne, donc bien apres le clic.
    expect(chaineDeLaFormule({ formule: 'repli', premier: 'whatsapp', troisieme: 'sms' }))
      .toEqual([{ rang: 1, canal: 'whatsapp' }, { rang: 2, canal: 'rcs' }]);
  });

  it('aUnRepli ne regarde pas la LONGUEUR mais les rangs', () => {
    expect(aUnRepli([{ rang: 1, canal: 'whatsapp' }])).toBe(false);
    expect(aUnRepli([{ rang: 1, canal: 'whatsapp' }, { rang: 2, canal: 'rcs' }])).toBe(true);
    // Une chaine trouee (1 puis 3) EST un repli : c'est le rang qui le dit, pas le compte.
    expect(aUnRepli([{ rang: 1, canal: 'whatsapp' }, { rang: 3, canal: 'email' }])).toBe(true);
  });
});

describe('la question du reessai', () => {
  const SEUL = [{ rang: 1, canal: 'whatsapp' as const }];
  const REPLI = [{ rang: 1, canal: 'whatsapp' as const }, { rang: 2, canal: 'rcs' as const }];

  it('se pose sur un canal seul, ou elle est le seul rattrapage disponible', () => {
    expect(reessaiProposable(SEUL)).toBe(true);
  });

  it('🔴 ne se pose PAS sur une chaine de repli : « le renvoi, c est le fallback »', () => {
    // Decision de Julien du 2026-09-13, sur son essai reel. Une chaine EST le rattrapage d'un echec, et
    // le premier echec y fait basculer vers le canal suivant. Reessayer en plus, ce serait repartir sur
    // le tuyau dont on sait deja qu'il ne passe pas.
    expect(reessaiProposable(REPLI)).toBe(false);
  });

  it('une chaine trouee (1 puis 3) compte comme un repli', () => {
    expect(reessaiProposable([{ rang: 1, canal: 'whatsapp' }, { rang: 3, canal: 'email' }])).toBe(false);
  });
});

describe('le contenu d un etage', () => {
  it('un etage whatsapp exige un modele', () => {
    expect(etageRenseigne('whatsapp', { formule: 'seul' })).toBe(false);
    expect(etageRenseigne('whatsapp', { formule: 'seul', templateName: 'bienvenue' })).toBe(true);
  });

  it('🔴 un etage RCS n exige PAS de modele, il exige un texte', () => {
    // Le piege serait de contoler `templateName` partout : un etage RCS parfaitement rempli serait
    // declare vide, et l'assistant bloquerait sur une campagne qui n'a rien a se reprocher.
    expect(etageRenseigne('rcs', { formule: 'seul', templateName: 'bienvenue' })).toBe(false);
    expect(etageRenseigne('rcs', { formule: 'seul', texteRcs: 'Bonjour' })).toBe(true);
  });

  it('un etage e-mail exige son gabarit', () => {
    expect(etageRenseigne('email', { formule: 'seul' })).toBe(false);
    expect(etageRenseigne('email', { formule: 'seul', emailTemplateId: 'g1' })).toBe(true);
  });

  it('🔴 la formule « avec scenario » deplace l exigence sur le SCENARIO', () => {
    // Le serveur ecrit `template_name = ''` dans ce cas : c'est le premier bloc du graphe qui dit ce qui
    // part. Exiger le modele ici bloquerait une campagne de scenario parfaitement valide.
    expect(etageRenseigne('whatsapp', { formule: 'avec_scenario', templateName: 'bienvenue' })).toBe(false);
    expect(etageRenseigne('whatsapp', { formule: 'avec_scenario', workflowId: 'w1' })).toBe(true);
  });

  it('un texte fait d espaces ne remplit rien', () => {
    expect(etageRenseigne('rcs', { formule: 'seul', texteRcs: '   ' })).toBe(false);
  });

  it('un contenu absent n est pas un contenu vide, et les deux bloquent', () => {
    expect(etageRenseigne('whatsapp', undefined)).toBe(false);
  });
});

describe('les rangs sans contenu', () => {
  const REPLI = [{ rang: 1, canal: 'whatsapp' as const }, { rang: 2, canal: 'rcs' as const }];

  it('rend vide quand tout est rempli', () => {
    expect(rangsSansContenu(REPLI, {
      1: { formule: 'seul', templateName: 'bienvenue' },
      2: { formule: 'seul', texteRcs: 'Bonjour' },
    })).toEqual([]);
  });

  it('🔴 nomme l ETAGE DE REPLI vide, pas seulement le premier', () => {
    // Un etage 2 vide ne bascule sur rien : la campagne aurait un repli a l'ecran et aucun repli en
    // fait, ce qui est la pire des deux situations. Ne regarder que le rang 1 laisserait passer ce cas.
    expect(rangsSansContenu(REPLI, { 1: { formule: 'seul', templateName: 'bienvenue' } })).toEqual([2]);
  });

  it('les rend dans l ordre de la chaine', () => {
    expect(rangsSansContenu(REPLI, {})).toEqual([1, 2]);
  });
});

describe('la jauge de debit', () => {
  // 🔴 CE QUE CES BORNES PROTÈGENT : 80 est la borne de SAISIE de l'API (`PHONE_RATE_PER_MINUTE_MAX`), et
  // le serveur refuse la création entière au-delà. Un état venu d'ailleurs (adresse, brouillon repris)
  // peut sortir de la jauge, contrairement à un `<input type="range">`.
  it('les bornes encadrent le defaut, et 80 est celle de l API', () => {
    expect(DEBIT_MIN).toBe(1);
    expect(DEBIT_MAX).toBe(80);
    expect(DEBIT_DEFAUT).toBeGreaterThanOrEqual(DEBIT_MIN);
    expect(DEBIT_DEFAUT).toBeLessThanOrEqual(DEBIT_MAX);
  });

  // ⚠️ 60 EST CELUI DE L'ANCIEN FORMULAIRE, pas celui du serveur (30) : c'est ce que les campagnes de ce
  // produit envoient réellement aujourd'hui. Deux écrans qui créent la même campagne à deux vitesses
  // seraient une divergence invisible de tout compilateur.
  it('le defaut est celui de l ecran en service, 60', () => {
    expect(DEBIT_DEFAUT).toBe(60);
  });

  it('un debit hors bornes est RAMENE, jamais laisse partir', () => {
    expect(debitBorne(0)).toBe(DEBIT_MIN);
    expect(debitBorne(-12)).toBe(DEBIT_MIN);
    expect(debitBorne(1000)).toBe(DEBIT_MAX);
    expect(debitBorne(42)).toBe(42);
  });

  // 🔴 L'AUTRE SENS, ET IL SÉPARE LA VRAIE IMPLÉMENTATION DE LA FAUSSE : un `Math.min/max` seul rendrait
  // `NaN` sur une valeur illisible, et le serveur refuserait la campagne entière sur un nombre qu'aucun
  // écran n'a montré. Un débit décimal, lui, n'existe pas côté base (colonne entière).
  it('une valeur illisible retombe sur le defaut, et un decimal est arrondi', () => {
    expect(debitBorne(Number.NaN)).toBe(DEBIT_DEFAUT);
    expect(debitBorne(Number.POSITIVE_INFINITY)).toBe(DEBIT_DEFAUT);
    expect(debitBorne(12.4)).toBe(12);
  });
});

describe('les heures d ouverture de l espace', () => {
  const jour = (o: string, c: string) => ({ closed: false, open: o, close: c });

  it('aucun reglage du tout = non reglees', () => {
    expect(heuresDOuvertureReglees(undefined)).toBe(false);
    expect(heuresDOuvertureReglees(null)).toBe(false);
    expect(heuresDOuvertureReglees({})).toBe(false);
  });

  it('tous les jours fermes = non reglees', () => {
    expect(heuresDOuvertureReglees({ '0': { closed: true, open: '', close: '' }, '1': { closed: true, open: '09:00', close: '18:00' } })).toBe(false);
  });

  it('un seul jour ouvert suffit', () => {
    expect(heuresDOuvertureReglees({ '0': { closed: true, open: '', close: '' }, '3': jour('09:00', '18:00') })).toBe(true);
  });

  it('🔴 une plage VIDE ou inversee n ouvre aucune fenetre', () => {
    // `withinBusinessHours` refuse `close <= open` : un jour « ouvert » de 18 h a 9 h n'ouvre rien, et
    // annoncer des heures reglees ferait croire a une garde qui ne retient personne.
    expect(heuresDOuvertureReglees({ '1': jour('', '') })).toBe(false);
    expect(heuresDOuvertureReglees({ '1': jour('18:00', '09:00') })).toBe(false);
    expect(heuresDOuvertureReglees({ '1': jour('09:00', '09:00') })).toBe(false);
  });
});

/**
 * ⚠️ CE BLOC A CHANGÉ DE SUJET LE 2026-09-14, ET C'EST UNE DÉCISION PRODUIT, PAS UNE RÉGRESSION. La
 * question « que se passe-t-il quand le contact répond ? » est DESCENDUE dans chaque cadre d'étage
 * (demande de Julien : « qui s'appliquera alors QUE pour le WhatsApp, et ensuite tu passes à l'étage 2 »).
 * Ce qui reste propre à la CAMPAGNE, et que cette fonction décide, c'est « à qui va la conversation »,
 * qui n'a d'objet que si un étage renvoie vers l'Inbox. Les cas exercés sont conservés, transposés.
 */
describe('la question « à qui va la conversation ? »', () => {
  const CHAINE = [{ rang: 1, canal: 'whatsapp' as const }, { rang: 2, canal: 'rcs' as const }];

  it('elle se pose des qu un etage renvoie vers l Inbox', () => {
    expect(assignationProposable(CHAINE, {
      1: { formule: 'seul', devenir: 'inbox', templateName: 'promo' },
      2: { formule: 'seul', devenir: 'inbox', texteRcs: 'coucou' },
    })).toBe(true);
  });

  /**
   * 🔴 L'AGENT DE META N'EST PAS UNE ASSIGNATION. Si tous les étages le laissent répondre, la conversation
   * ne revient à personne : poser « à qui va-t-elle ? » ferait choisir un destinataire pour un objet qui
   * n'arrive jamais, et le point d'envoi emporterait une assignation que plus aucun écran ne montre.
   */
  it('🔴 elle ne se pose PAS quand tout reste a l agent de Meta', () => {
    expect(assignationProposable(CHAINE, {
      1: { formule: 'seul', devenir: 'mba', templateName: 'promo' },
      2: { formule: 'seul', devenir: 'mba', texteRcs: 'coucou' },
    })).toBe(false);
  });

  /**
   * 🔴 LE CAS QUE JULIEN A TRANCHÉ LE 2026-09-14 : « la logique qui répond, est-ce un agent IA ou un
   * collab, est gérée dans le scénario ». Sans ce cas, l'écran reposerait une question à laquelle le
   * graphe répond déjà, et le point d'envoi emporterait une assignation que personne ne voit plus.
   */
  it('🔴 elle ne se pose plus quand TOUS les etages ouvrent un scenario', () => {
    expect(assignationProposable(CHAINE, {
      1: { formule: 'avec_scenario', workflowId: 'wf-1' },
      2: { formule: 'avec_scenario', workflowId: 'wf-2' },
    })).toBe(false);
  });

  /**
   * 🔴 UN SEUL ÉTAGE HORS SCÉNARIO SUFFIT À LA REPOSER. Les contacts joints au second étage répondent
   * sans qu'aucun parcours ne les prenne : masquer la question les laisserait dans un défaut que
   * personne n'a choisi, ce qui est exactement le reproche fait à l'ancien comportement.
   */
  it('🔴 un seul etage vers l Inbox la repose, quel que soit son rang', () => {
    expect(assignationProposable(CHAINE, {
      1: { formule: 'avec_scenario', workflowId: 'wf-1' },
      2: { formule: 'seul', devenir: 'inbox', texteRcs: 'coucou' },
    })).toBe(true);
    expect(assignationProposable(CHAINE, {
      1: { formule: 'seul', devenir: 'inbox', templateName: 'promo' },
      2: { formule: 'avec_scenario', workflowId: 'wf-2' },
    })).toBe(true);
  });

  /**
   * 🔴 LE CAS QUI FAIT TOUT L'INTÉRÊT DU LOT : deux étages peuvent DIVERGER. Julien, le 2026-09-14 :
   * « admettons WhatsApp, si la personne dit Modèle + scénario tu ne poses pas la question ; et ensuite tu
   * passes à l'étage 2, admettons RCS, et pareil ». Ici le WhatsApp laisse l'agent de Meta répondre et le
   * RCS revient à l'équipe : il faut donc bien demander à qui.
   */
  it('🔴 deux etages peuvent diverger, et un seul suffit', () => {
    expect(assignationProposable(CHAINE, {
      1: { formule: 'seul', devenir: 'mba', templateName: 'promo' },
      2: { formule: 'seul', devenir: 'inbox', texteRcs: 'coucou' },
    })).toBe(true);
  });

  // ⚠️ UN ÉTAGE VIDE N'A PAS ENCORE DE DEVENIR, donc il ne réclame aucune assignation. C'est
  // `rangsSansContenu` qui empêche l'écran d'avancer tant qu'il est vide, pas cette fonction.
  it('un etage encore vide ne reclame pas d assignation', () => {
    expect(assignationProposable(CHAINE, { 1: { formule: 'avec_scenario', workflowId: 'wf-1' } })).toBe(false);
  });

  // ⚠️ SANS CHAÎNE, AUCUNE QUESTION. Le cas n'arrive qu'avant le choix du canal, où l'étape Contenu est
  // inatteignable ; le défaut prudent est de ne rien proposer plutôt que de proposer sur du vide.
  it('une chaine vide ne pose pas la question', () => {
    expect(assignationProposable([], {})).toBe(false);
  });
});

/**
 * 🔴 LE DÉFAUT DU DEVENIR SUIT L'ESPACE (relevé en revue le 2026-09-14).
 *
 * Sans l'agent de Meta, un défaut `mba` désignait une option que l'écran GRISE au même moment : le client
 * ne pouvait en sortir sans y penser, et ses réponses n'allaient nulle part (ni robot pour répondre, ni
 * équipe à qui les confier). C'est le pire des trois états possibles.
 */
describe('le defaut du devenir suit l espace', () => {
  it('🔴 sans agent de Meta, l assignation est demandee d emblee', () => {
    const CHAINE = [{ rang: 1, canal: 'whatsapp' as const }];
    expect(assignationProposable(CHAINE, { 1: { formule: 'seul', devenir: devenirParDefaut(false), templateName: 'p' } }))
      .toBe(true);
  });

  it('avec agent de Meta, le defaut le laisse repondre', () => {
    expect(devenirParDefaut(true)).toBe('mba');
  });
});
