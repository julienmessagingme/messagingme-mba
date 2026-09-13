import { describe, it, expect } from 'vitest';
import {
  chaineDeLaFormule,
  aUnRepli,
  rattrapagePossible,
  heuresDOuvertureReglees,
  debitBorne,
  DEBIT_DEFAUT,
  DEBIT_MAX,
  DEBIT_MIN,
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

describe('la question du rattrapage hors horaires', () => {
  const SEUL = [{ rang: 1, canal: 'whatsapp' as const }];
  const REPLI = [{ rang: 1, canal: 'whatsapp' as const }, { rang: 2, canal: 'rcs' as const }];

  it('se pose des qu un reessai est coche, sans chaine', () => {
    expect(rattrapagePossible({ reessayer: true, chaine: SEUL })).toBe(true);
  });

  it('ne se pose pas sans reessai ni chaine : rien ne peut partir a une heure non choisie', () => {
    expect(rattrapagePossible({ reessayer: false, chaine: SEUL })).toBe(false);
  });

  it('🔴 se pose sur une CHAINE meme reessai decoche : c est un OU, pas un ET', () => {
    // Sur une chaine, l'ecran ne pose PAS la question du reessai (le repli tient ce role), donc
    // `reessayer` y garde sa valeur par defaut. Un ET ferait disparaitre la question sur le cas meme qui
    // l'a fait naitre : un repli qui tombe a 18 h 02 sur une campagne partie a 17 h.
    expect(rattrapagePossible({ reessayer: false, chaine: REPLI })).toBe(true);
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
