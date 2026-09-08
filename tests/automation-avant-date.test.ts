import { describe, it, expect } from 'vitest';
import { estDu, coerceConfigAvantDate, minutesDuDelai, DELAI_MAX_MINUTES } from '../src/automation/avant-date';

/**
 * Déclencheur « X avant la date d'un champ » : la décision, pour UN contact.
 *
 * Les trois règles tranchées par Julien le 2026-08-23 sont toutes vérifiables ici, et c'est le seul endroit
 * où elles le sont : un moment passé n'envoie rien, une date qui change redonne un rappel, un délai se règle
 * en nombre + unité.
 */

const TZ = 'Europe/Paris';
/** 2026-08-23 à 12:00 heure de Paris (soit 10:00 UTC en été). */
const MAINTENANT = Date.parse('2026-08-23T10:00:00Z');

const base = {
  offsetMinutes: 120, // 2 h avant
  now: MAINTENANT,
  toleranceMinutes: 60,
  timeZone: TZ,
  dejaTirePour: null as string | null,
};

describe('le délai', () => {
  it('convertit minutes, heures et jours', () => {
    expect(minutesDuDelai(30, 'minutes')).toBe(30);
    expect(minutesDuDelai(2, 'heures')).toBe(120);
    expect(minutesDuDelai(3, 'jours')).toBe(4320);
  });

  it('🔴 une config inexploitable n’attrape RIEN', () => {
    // Même doctrine que le mot-clé vide : une automation inerte plutôt qu'une automation qui part n'importe
    // quand. Un délai de 0 est refusé : issu d'un champ de formulaire vide, il enverrait AU MOMENT du
    // rendez-vous au lieu d'avant.
    for (const cfg of [
      {},
      { fieldKey: '', delai: 2, unite: 'heures' },
      { fieldKey: 'rdv', delai: 0, unite: 'heures' },
      { fieldKey: 'rdv', delai: -2, unite: 'heures' },
      { fieldKey: 'rdv', delai: 1.5, unite: 'heures' },
      { fieldKey: 'rdv', delai: 2, unite: 'semaines' },
      { fieldKey: 'rdv', delai: 2 },
      { fieldKey: 'rdv', delai: DELAI_MAX_MINUTES + 1, unite: 'minutes' },
    ]) {
      expect(coerceConfigAvantDate(cfg as Record<string, unknown>), JSON.stringify(cfg)).toBeNull();
    }
  });

  it('accepte une config valide', () => {
    // `sens` est ajouté par la coercition depuis le 2026-09-08 : une config qui ne le porte pas vaut
    // « avant », et c'est le cas de TOUTES celles écrites avant ce jour.
    expect(coerceConfigAvantDate({ fieldKey: ' rdv ', delai: 2, unite: 'heures' }))
      .toEqual({ fieldKey: 'rdv', delai: 2, unite: 'heures', sens: 'avant' });
  });
});

describe('le moment', () => {
  it('🔴 dû quand le moment vient d’arriver', () => {
    // Rendez-vous à 14 h heure de Paris, rappel 2 h avant : le moment est 12 h, et il est 12 h.
    expect(estDu({ ...base, valeur: '2026-08-23T14:00' }).du).toBe(true);
  });

  it('🔴 PAS ENCORE : le moment est dans le futur', () => {
    // Rendez-vous à 18 h, rappel 2 h avant : il faudra attendre 16 h.
    expect(estDu({ ...base, valeur: '2026-08-23T18:00' })).toEqual({ du: false, raison: 'pas_encore' });
  });

  it('🔴 TROP TARD : le moment est passé depuis longtemps -> on n’envoie RIEN', () => {
    // Le cas du webhook reçu en retard. Un rappel « 2 h avant » qui partirait maintenant, pour un
    // rendez-vous qui a lieu dans 30 minutes, dirait quelque chose de faux au client.
    expect(estDu({ ...base, valeur: '2026-08-23T12:30' })).toEqual({ du: false, raison: 'trop_tard' });
    // Et le cas extrême : le rendez-vous est déjà passé.
    expect(estDu({ ...base, valeur: '2026-08-22T09:00' })).toEqual({ du: false, raison: 'trop_tard' });
  });

  it('la tolérance rattrape un redémarrage, pas un vrai retard', () => {
    // 30 minutes de retard : dans la fenêtre de 60, on part.
    expect(estDu({ ...base, valeur: '2026-08-23T13:30' }).du).toBe(true);
    // 90 minutes : au-delà, non.
    expect(estDu({ ...base, valeur: '2026-08-23T12:30' }).du).toBe(false);
  });

  it('🔴 une date SANS fuseau est lue comme une heure MURALE de l’espace', () => {
    // `2026-08-23T14:00` à Paris en été, c'est 12:00 UTC. Lue comme de l'UTC, le rappel partirait deux
    // heures trop tôt, toute l'année, sans que rien ne le signale.
    expect(estDu({ ...base, valeur: '2026-08-23T14:00' }).du).toBe(true);
    // La même valeur marquée UTC désigne un autre instant : elle n'est donc PAS due au même moment.
    expect(estDu({ ...base, valeur: '2026-08-23T14:00:00Z' })).toEqual({ du: false, raison: 'pas_encore' });
  });
});

describe('la date qui change', () => {
  it('🔴 déjà tiré pour CETTE date -> on ne renvoie pas', () => {
    expect(estDu({ ...base, valeur: '2026-08-23T14:00', dejaTirePour: '2026-08-23T14:00' }))
      .toEqual({ du: false, raison: 'deja_tire' });
  });

  it('🔴 rendez-vous REPORTÉ : la date a changé, donc le rappel repart', () => {
    // C'est la décision de Julien, et c'est ce qui distingue « on a déjà tiré » de « on a déjà tiré POUR
    // CETTE date ». Un simple booléen laisserait le client sans rappel après un report, en silence.
    expect(estDu({ ...base, valeur: '2026-08-23T14:00', dejaTirePour: '2026-08-20T09:00' }).du).toBe(true);
  });
});

describe('les dates qu’on ne sait pas lire', () => {
  it('sont écartées, sans lever, et en le disant', () => {
    for (const v of ['', 'demain', '03/04/2026', '2026-02-30T10:00', '2026-08-23']) {
      expect(estDu({ ...base, valeur: v }), v).toEqual({ du: false, raison: 'date_illisible' });
    }
  });
});

/**
 * AVANT ou APRÈS la date (demande de Julien, 2026-09-08).
 *
 * 🔴 CE QUE CE BLOC PROTÈGE, et qui touche des automations DÉJÀ EN PRODUCTION : le défaut. Le champ `sens`
 * n'existe pas dans les configs écrites avant ce jour ; si son absence valait « après », tous les rappels
 * existants basculeraient de l'autre côté de leur date, en silence, et personne ne le verrait avant qu'un
 * client ne reçoive « votre rendez-vous est demain » le lendemain.
 */
describe('le sens : avant ou après la date', () => {
  it('🔴 config SANS `sens` -> `avant`, ce que ces automations ont toujours fait', () => {
    expect(coerceConfigAvantDate({ fieldKey: 'rdv', delai: 2, unite: 'heures' })?.sens).toBe('avant');
  });

  it('une valeur ABERRANTE retombe sur `avant` sans invalider la config', () => {
    // Refuser toute la config pour un champ arrivé après ferait taire une automation qui marchait.
    const c = coerceConfigAvantDate({ fieldKey: 'rdv', delai: 2, unite: 'heures', sens: 'pendant' });
    expect(c).not.toBeNull();
    expect(c?.sens).toBe('avant');
  });

  it('`apres` est conservé quand il est demandé', () => {
    expect(coerceConfigAvantDate({ fieldKey: 'rdv', delai: 3, unite: 'jours', sens: 'apres' })?.sens).toBe('apres');
  });

  it('🔴 `apres` déclenche APRÈS la date, pas avant : les deux sens sont testés sur la MÊME date', () => {
    // 12:00 Paris = maintenant. Avec 2 h de délai :
    //  - « avant » est dû pour une date à 14:00 (14:00 - 2 h = maintenant) ;
    //  - « après » est dû pour une date à 10:00 (10:00 + 2 h = maintenant).
    // Le même couple (date, délai) ne doit JAMAIS être dû des deux côtés : c'est ce qui prouve que le signe
    // agit, plutôt qu'un test qui passerait avec un décalage nul.
    expect(estDu({ ...base, valeur: '2026-08-23T14:00', sens: 'avant' }).du).toBe(true);
    expect(estDu({ ...base, valeur: '2026-08-23T14:00', sens: 'apres' }).du).toBe(false);
    expect(estDu({ ...base, valeur: '2026-08-23T10:00', sens: 'apres' }).du).toBe(true);
    expect(estDu({ ...base, valeur: '2026-08-23T10:00', sens: 'avant' }).du).toBe(false);
  });

  it('🔴 `apres` NE RATTRAPE PAS le passé : une date vieille de trois jours n’envoie rien', () => {
    // Décision de Julien du 2026-09-08. Sans cette règle, activer « 2 h après » ferait partir d'un coup tous
    // les contacts dont la date est passée : un envoi de masse involontaire, et facturé.
    const r = estDu({ ...base, valeur: '2026-08-20T10:00', sens: 'apres' });
    expect(r.du).toBe(false);
    expect(r.du === false && r.raison).toBe('trop_tard');
  });

  it('sens ABSENT dans l’entrée -> se comporte comme `avant`', () => {
    // L'appelant historique (le balayage d'avant ce lot) ne passait pas ce champ.
    expect(estDu({ ...base, valeur: '2026-08-23T14:00' }).du).toBe(true);
  });
});
