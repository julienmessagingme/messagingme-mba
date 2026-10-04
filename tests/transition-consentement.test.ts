import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgContactStore } from '../src/crm/contact-store.pg';
import {
  LEVE_UN_STOP,
  issueDeLaTransition,
  transition,
  affectationsDUpsert,
  ecritureDuConsentement,
  type AutoriteConsentement,
  type StatutConsentement,
} from '../src/crm/transition-consentement';

/**
 * LA RÈGLE DU CONSENTEMENT, SANS BASE (`src/crm/transition-consentement.ts`).
 *
 * Ce fichier tient la règle elle-même (qui lève un STOP, ce qui s'écrit ou non) et la FORME de l'instruction qu'on en
 * tire : un `for update`, une écriture gardée par le changement de statut et par l'espace, désigné par le bon paramètre
 * dans chaque écriture du dépôt. Ce que ces fragments FONT sur des lignes est joué contre une vraie base, écriture par
 * écriture, dans `tests/integration/transition-consentement.integration.test.ts`.
 */
const STATUTS: StatutConsentement[] = ['unknown', 'opted_in', 'opted_out'];
const AUTORITES = Object.keys(LEVE_UN_STOP) as AutoriteConsentement[];

describe('qui peut lever un STOP', () => {
  /**
   * 🔴 LA TABLE DÉCIDÉE PAR JULIEN (2026-09-26 et 2026-10-03), recopiée ici À DESSEIN : changer une ligne du module
   * doit faire rougir ce test, et c'est une décision de produit, pas un détail d'implémentation.
   */
  it('🔴 oui : la fiche, l’import CSV coché, la personne, le bloc « Action » ; non : tout le reste', () => {
    expect(LEVE_UN_STOP).toEqual({
      fiche: true,
      import_csv_coche: true,
      personne: true,
      scenario: true,
      action_en_masse: false,
      import: false,
      webhook_ou_saisie: false,
      api: false,
    });
  });
});

describe('issueDeLaTransition : les neuf cas, pour chaque autorité', () => {
  for (const autorite of AUTORITES) {
    it(`${autorite}`, () => {
      const vu = Object.fromEntries(STATUTS.flatMap((a) => STATUTS.map((v) => [`${a}->${v}`, issueDeLaTransition(a, v, autorite)])));
      expect(vu).toEqual({
        // `unknown` n'est jamais une destination, et un statut en place ne se réécrit pas.
        'unknown->unknown': 'inchange', 'opted_in->unknown': 'inchange', 'opted_out->unknown': 'inchange',
        'opted_in->opted_in': 'inchange', 'opted_out->opted_out': 'inchange',
        'unknown->opted_in': 'ecrit', 'unknown->opted_out': 'ecrit', 'opted_in->opted_out': 'ecrit',
        // 🔴 Le seul cas qui dépend de l'autorité.
        'opted_out->opted_in': LEVE_UN_STOP[autorite] ? 'ecrit' : 'stop_garde',
      });
    });
  }
});

/** Relit la liste de couples d'un prédicat dérivé : `((x.opt_in_status, V) in (('a', 'b'), ...))` ou `false`. */
function couplesDe(predicat: string): string[] {
  if (predicat === 'false') return [];
  return [...predicat.matchAll(/\('([a-z_]+)', '([a-z_]+)'\)/g)].map((m) => `${m[1]}->${m[2]}`).sort();
}
function attendus(autorite: AutoriteConsentement, garder: (a: StatutConsentement, v: StatutConsentement) => boolean): string[] {
  return STATUTS.flatMap((a) => STATUTS.filter((v) => garder(a, v)).map((v) => `${a}->${v}`)).sort();
}

describe('le SQL est DÉPLIÉ de la règle, jamais réécrit', () => {
  for (const autorite of AUTORITES) {
    it(`${autorite} : change, passe et garde listent exactement les couples de la règle`, () => {
      const t = transition('avant.', { voulu: '$3::text', source: '$4::text', autorite });
      const issue = (a: StatutConsentement, v: StatutConsentement) => issueDeLaTransition(a, v, autorite);
      expect(couplesDe(t.change)).toEqual(attendus(autorite, (a, v) => issue(a, v) === 'ecrit'));
      expect(couplesDe(t.passe)).toEqual(attendus(autorite, (a, v) => issue(a, v) === 'ecrit' && v === 'opted_out'));
      expect(couplesDe(t.garde)).toEqual(attendus(autorite, (a, v) => issue(a, v) === 'stop_garde'));
      // Le prédicat lit l'état d'AVANT, sur la ligne nommée, contre la demande.
      if (t.change !== 'false') expect(t.change).toContain('(avant.opt_in_status, $3::text) in (');
    });
  }

  it('🔴 l’action en masse : `opted_out -> opted_in` est un STOP gardé, jamais une écriture', () => {
    const t = transition('', { voulu: '$1::text', source: '$2::text', autorite: 'action_en_masse' });
    expect(couplesDe(t.change)).not.toContain('opted_out->opted_in');
    expect(couplesDe(t.garde)).toEqual(['opted_out->opted_in']);
  });
});

describe('les affectations', () => {
  const t = transition('contacts.', { voulu: 'excluded.opt_in_status', source: 'excluded.opt_in_source', autorite: 'import' });
  const affectation = (colonne: string): string =>
    t.affectations.split(/,\n\s*/).find((a) => a.startsWith(`${colonne} = `)) ?? '';

  it('🔴 statut, date et source s’écrivent SEULEMENT si le statut change, sinon gardent la valeur d’avant', () => {
    for (const colonne of ['opt_in_status', 'opt_out_at', 'opt_in_source']) {
      const a = affectation(colonne);
      expect(a.startsWith(`${colonne} = case when ${t.change} then `), `${colonne} : gardée par le changement`).toBe(true);
      expect(a.endsWith(` else contacts.${colonne} end`), `${colonne} : sinon la valeur d’avant`).toBe(true);
    }
  });

  it('🔴 la date suit le statut : posée au passage à `opted_out`, remise à null au passage à `opted_in`', () => {
    expect(affectation('opt_out_at')).toContain(`then (case when excluded.opt_in_status = 'opted_out' then now() end)`);
  });

  it('la source demandée remplace l’ancienne au changement, et une source absente garde l’ancienne', () => {
    expect(affectation('opt_in_source')).toContain('then coalesce(excluded.opt_in_source, contacts.opt_in_source)');
  });

  it('un upsert lit sa demande dans `excluded` et la ligne existante dans `contacts`', () => {
    expect(affectationsDUpsert('webhook_ou_saisie')).toBe(
      transition('contacts.', { voulu: 'excluded.opt_in_status', source: 'excluded.opt_in_source', autorite: 'webhook_ou_saisie' }).affectations,
    );
  });
});

describe('ecritureDuConsentement : la forme de l’instruction', () => {
  const sans = (sql: string): string => sql.replace(/\s+/g, ' ');
  const demande = { voulu: '$3::text', source: '$4::text', autorite: 'api' as const, espace: '$1' as const };

  it('🔴 l’état d’avant est lu SOUS VERROU : deux STOP simultanés ne s’annoncent pas deux fois', () => {
    const sql = sans(ecritureDuConsentement({ ...demande, cible: 'where tenant_id = $1 and id = $2', rendu: 'par_fiche' }));
    expect(sql).toContain('with avant as ( select id, opt_in_status, phone_e164, bsuid from contacts where tenant_id = $1 and id = $2 for update )');
  });

  it('🔴 sans autre affectation, l’écriture est GARDÉE par le changement de statut : un statut en place ne bouge pas `updated_at`', () => {
    const sql = sans(ecritureDuConsentement({ ...demande, cible: 'where id = $1', rendu: 'par_fiche' }));
    const t = transition('', demande);
    expect(sql).toContain(`where tenant_id = $1 and id in (select id from avant) and ${sans(t.change)} returning id`);
  });

  it('avec d’autres affectations (une étiquette en masse), toute fiche ciblée s’écrit, le consentement restant gardé par ses `case`', () => {
    const sql = sans(ecritureDuConsentement({ ...demande, autorite: 'action_en_masse', cible: 'where id = $1', autres: ['tags = $5::text[]'], rendu: 'compte' }));
    expect(sql).toContain('update contacts set tags = $5::text[], opt_in_status = case when');
    expect(sql).toContain('where tenant_id = $1 and id in (select id from avant) returning id');
  });

  /**
   * 🔴 L'écriture repose le filtre d'espace, sur le paramètre que l'appelant désigne : sans lui, Postgres ne sert pas
   * l'index d'espace sur une masse large. Que chaque écriture du dépôt désigne le BON paramètre, le bloc suivant le
   * vérifie sur les requêtes qu'elle produit.
   */
  it('🔴 l’écriture porte le filtre d’espace, sur le paramètre désigné', () => {
    const sql = sans(ecritureDuConsentement({ ...demande, espace: '$2', cible: 'where id = $1 and tenant_id = $2', rendu: 'par_fiche' }));
    expect(sql).toContain('where tenant_id = $2 and id in (select id from avant) and ');
  });

  it('passe et garde se lisent sur la copie verrouillée, jamais sur la ligne écrite', () => {
    const sql = sans(ecritureDuConsentement({ ...demande, cible: 'where id = $1', rendu: 'par_fiche' }));
    const t = transition('avant.', demande);
    expect(sql).toContain(`${sans(t.passe)} as passe, ${sans(t.garde)} as garde from avant left join ecrit on ecrit.id = avant.id`);
  });

  it('le rendu `compte` remonte UNE ligne (agrégats), pas une par fiche', () => {
    const sql = sans(ecritureDuConsentement({ ...demande, cible: 'where id = $1', rendu: 'compte' }));
    expect(sql).toMatch(/select count\(ecrit\.id\)::int as ecrites, \(count\(\*\) filter \(where .*\)\)::int as gardes, coalesce\(json_agg\(/);
  });
});

/**
 * 🔴 LES QUATRE ÉCRITURES DE `PgContactStore` DÉSIGNENT LE PARAMÈTRE QUI PORTE L'ESPACE. Chacune numérote les siens à
 * sa façon (`$1` par `wa_id` et par l'API, `$2` sur la fiche, en bout de liste en masse) : un `espace` qui désigne le
 * mauvais ne lève rien (deux `uuid` se comparent sans erreur), l'écriture ne touche simplement plus aucune fiche. On
 * lit donc, dans chaque requête produite, le paramètre que l'écriture ET la lecture verrouillée comparent à
 * `tenant_id`, et ce qu'il vaut. Ce que la requête FAIT sur des lignes, la table d'intégration le joue.
 */
describe('les écritures du dépôt désignent l’espace par le bon paramètre', () => {
  const ESPACE = '11111111-1111-4111-8111-111111111111';
  const FICHE = '22222222-2222-4222-8222-222222222222';
  interface Requete { sql: string; params: unknown[] }
  const LIGNE = {
    id: FICHE, phone_e164: '+33600000001', bsuid: null, profile_name: null, opt_in_status: 'opted_out', fields: {},
    tags: [], created_at: new Date('2026-09-13T00:00:00.000Z'), blocked_at: null, whatsapp_joignable: null,
    whatsapp_joignable_le: null,
  };

  /** Un faux pool qui garde chaque requête ; `reponse` dit ce que la base aurait rendu. */
  function banc(reponse: (sql: string) => unknown[] = () => []) {
    const requetes: Requete[] = [];
    const query = async (sql: string, params: unknown[] = []) => {
      requetes.push({ sql, params });
      const rows = reponse(sql);
      return { rows, rowCount: rows.length };
    };
    const pool = { query, connect: async () => ({ query, release: () => {} }) } as unknown as Pool;
    return { requetes, store: new PgContactStore(pool) };
  }
  /** `applyEdits` lit la fiche sous verrou avant d'écrire : sans ligne, il s'arrête là. */
  const ficheExiste = (sql: string): unknown[] => (/select tags from contacts/.test(sql) ? [{ tags: [] }] : []);

  /** La valeur du paramètre que `motif` compare à `tenant_id`, dans l'écriture du consentement. */
  function valeurDe(requetes: Requete[], motif: RegExp): unknown {
    const ecriture = requetes.find((r) => /^\s*with avant as/.test(r.sql));
    expect(ecriture, 'aucune écriture du consentement n’est partie').toBeDefined();
    const m = motif.exec(ecriture!.sql.replace(/\s+/g, ' '));
    expect(m, `motif absent de la requête : ${motif}`).not.toBeNull();
    return ecriture!.params[Number(m![1]) - 1];
  }
  const DANS_ECRIT = /ecrit as \( update contacts set .* where tenant_id = \$(\d+) and id in \(select id from avant\)/;
  const DANS_AVANT = /with avant as \( select id, opt_in_status, phone_e164, bsuid from contacts where (?:.*? )?tenant_id = \$(\d+)/;

  const ECRITURES: Array<[string, (store: PgContactStore) => Promise<unknown>]> = [
    ['setOptInByWaId', (s) => s.setOptInByWaId(ESPACE, '33600000001', 'opted_out', 'personne', 'whatsapp_stop')],
    ['ecrireConsentementParId', (s) => s.ecrireConsentementParId(ESPACE, FICHE, 'opted_out', 'api')],
    ['applyEdits', (s) => s.applyEdits(ESPACE, FICHE, { fields: {}, addTags: [], removeTags: [], optInStatus: 'opted_out' })],
    ['applyEditsMany par identifiants', (s) => s.applyEditsMany(ESPACE, { ids: [FICHE] }, { setOptIn: 'opted_in', addTags: ['vip'] })],
    ['applyEditsMany par filtres', (s) => s.applyEditsMany(ESPACE, { filters: { tags: ['salon'] }, excludeIds: [FICHE] }, { setOptIn: 'opted_out' })],
  ];

  for (const [nom, jouer] of ECRITURES) {
    it(`🔴 ${nom} : l’écriture et la lecture verrouillée comparent \`tenant_id\` à l’espace`, async () => {
      const { requetes, store } = banc(ficheExiste);
      await jouer(store);
      expect(valeurDe(requetes, DANS_ECRIT), 'paramètre d’espace de l’écriture').toBe(ESPACE);
      expect(valeurDe(requetes, DANS_AVANT), 'paramètre d’espace de la lecture verrouillée').toBe(ESPACE);
    });
  }

  /** ⚠️ Une cible vide n'a aucun paramètre (`where false`, `buildBulkSelector`) : l'espace ne peut pas y être `$1`. */
  it('⚠️ applyEditsMany sur une cible vide : l’espace a son propre paramètre', async () => {
    const { requetes, store } = banc();
    await store.applyEditsMany(ESPACE, { ids: [] }, { setOptIn: 'opted_out' });
    expect(valeurDe(requetes, DANS_ECRIT)).toBe(ESPACE);
  });

  /**
   * 🔴 `applyEdits` dit si le consentement a CHANGÉ, et la route ne journalise qu'alors (`src/http/contacts.ts`). Sans
   * autre affectation, `ecrite` veut dire « le statut a changé » ; un statut déjà en place le rend faux.
   */
  it('🔴 applyEdits rend `consentementChange` tel que l’écriture le dit, faux sans consentement demandé', async () => {
    for (const ecrite of [true, false]) {
      const { store } = banc((sql) => {
        if (/^\s*with avant as/.test(sql)) return [{ ecrite, passe: false }];
        if (/select id, phone_e164, bsuid/.test(sql)) return [LIGNE];
        return ficheExiste(sql);
      });
      const r = await store.applyEdits(ESPACE, FICHE, { fields: {}, addTags: [], removeTags: [], optInStatus: 'opted_out' });
      expect(r?.consentementChange, `ecrite = ${ecrite}`).toBe(ecrite);
    }
    const { store } = banc((sql) => (/select id, phone_e164, bsuid/.test(sql) ? [LIGNE] : ficheExiste(sql)));
    expect((await store.applyEdits(ESPACE, FICHE, { fields: {}, addTags: ['vip'], removeTags: [] }))?.consentementChange).toBe(false);
  });
});
