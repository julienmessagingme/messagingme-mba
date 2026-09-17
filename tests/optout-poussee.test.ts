import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import type { SourceAppel } from '../src/agent/sources';
import { PgContactStore } from '../src/crm/contact-store.pg';
import {
  lotsDePoussee,
  creerAnnonceOptOut,
  creerTravailPousseeOptOut,
  TAILLE_LOT_POUSSEE,
  echeanceDuLot,
  type JobPousseeOptOut,
} from '../src/crm/poussee-optout';

/**
 * LA POUSSÉE D'UN OPT-OUT VERS LE SYSTÈME DU CLIENT (tâche 7 du centre de Sécurité, migration 0139).
 *
 * 🔴 CE QUE CE FICHIER PROTÈGE N'EST PAS « la poussée fonctionne », C'EST L'ORDRE. Un opt-out s'écrit
 * D'ABORD, on prévient ENSUITE, et rien de ce qui se passe ensuite ne peut défaire ou empêcher l'écriture.
 * L'inverse (appeler puis écrire, ou écrire seulement si l'appel réussit) rendrait le respect d'un refus
 * dépendant de la santé d'un système tiers, c'est-à-dire exactement le manquement que ce menu existe pour
 * empêcher. Les deux sens sont testés : l'ordre, ET la panne.
 */

const TENANT = 't1';

/** Une horloge d'événements : c'est elle qui rend l'ORDRE observable, pas le seul fait qu'un appel a eu lieu. */
function journal() {
  const evenements: string[] = [];
  return { evenements, noter: (e: string) => { evenements.push(e); } };
}

function fauxPool(j: ReturnType<typeof journal>, opts: { idTouche?: string | null; lignesBulk?: Array<{ id: string; phone_e164: string | null; bsuid: string | null }> } = {}) {
  const idTouche = opts.idTouche === undefined ? 'c1' : opts.idTouche;
  const lignesBulk = opts.lignesBulk ?? [{ id: 'c1', phone_e164: '+33600000001', bsuid: null }];
  const query = async (sql: string) => {
    /**
     * ⚠️ ON DISCRIMINE SUR LA CIBLE, PAS SUR LE `returning`. Les deux requêtes commencent par
     * `update contacts set opt_in_status` ; seul le mot-clé entrant vise UN contact résolu par sous-requête
     * (`where id = (select ...)`), l'action en masse visant un ensemble. Discriminer sur `returning` a
     * marché une heure, puis a cessé le jour où le `returning` de l'action en masse est devenu CONDITIONNEL :
     * le test du réabonnement en masse mesurait alors le mauvais chemin, et il l'a dit.
     */
    if (/update contacts set opt_in_status/i.test(sql)) {
      if (/where id = \(/i.test(sql)) {
        j.noter('ecriture:setOptInByWaId');
        return { rows: idTouche === null ? [] : [{ id: idTouche }], rowCount: idTouche === null ? 0 : 1 };
      }
      j.noter('ecriture:applyEditsMany');
      return { rows: /returning/i.test(sql) ? lignesBulk : [], rowCount: lignesBulk.length };
    }
    return { rows: [], rowCount: 0 };
  };
  return { query } as unknown as Pool;
}

/**
 * Le même faux, en version TRANSACTIONNELLE, pour la fiche contact (`applyEdits`). Il note le `commit` :
 * sans ce repère, on ne pourrait pas distinguer « annonce après la validation » de « annonce dedans ».
 */
function fauxPoolTransactionnel(j: ReturnType<typeof journal>) {
  const ligne = {
    id: 'c1', phone_e164: '+33600000001', bsuid: null, profile_name: 'Julie', opt_in_status: 'opted_out',
    fields: {}, tags: [], created_at: new Date('2026-09-13T00:00:00.000Z'), blocked_at: null,
    whatsapp_joignable: null, whatsapp_joignable_le: null,
  };
  const client = {
    query: async (sql: string) => {
      if (/^commit/i.test(sql)) { j.noter('commit'); return { rows: [], rowCount: 0 }; }
      if (/select tags from contacts/i.test(sql)) return { rows: [{ tags: [] }], rowCount: 1 };
      if (/update contacts set opt_in_status/i.test(sql)) { j.noter('ecriture:applyEdits'); return { rows: [], rowCount: 1 }; }
      if (/select id, phone_e164, bsuid/i.test(sql)) return { rows: [ligne], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as Pool;
}

function annonceQuiNote(j: ReturnType<typeof journal>, recu: Array<{ tenantId: string; waIds: string[] }>, leve = false) {
  return async (tenantId: string, waIds: string[]): Promise<void> => {
    j.noter('annonce');
    recu.push({ tenantId, waIds });
    if (leve) throw new Error('file indisponible');
  };
}

describe('le dépôt ANNONCE le refus, après l’avoir écrit', () => {
  it('🔴 le mot-clé entrant : l’écriture PUIS l’annonce, jamais l’inverse', async () => {
    const j = journal();
    const recu: Array<{ tenantId: string; waIds: string[] }> = [];
    const store = new PgContactStore(fauxPool(j), annonceQuiNote(j, recu));
    const id = await store.setOptInByWaId(TENANT, '33600000001', 'opted_out', 'whatsapp_stop');

    expect(id).toBe('c1');
    expect(j.evenements).toEqual(['ecriture:setOptInByWaId', 'annonce']);
    expect(recu).toEqual([{ tenantId: TENANT, waIds: ['33600000001'] }]);
  });

  /**
   * 🔴 LE CAS QUI DONNE SON SENS À TOUT LE LOT. Un connecteur en panne, une base de files injoignable, un
   * réseau coupé : le refus DOIT quand même être enregistré. Sans ce test, il suffirait d'un `await` mal
   * placé pour que la conformité d'un client dépende de la disponibilité de son CRM.
   */
  it('🔴 une annonce qui LÈVE ne fait pas échouer l’opt-out', async () => {
    const j = journal();
    const recu: Array<{ tenantId: string; waIds: string[] }> = [];
    const store = new PgContactStore(fauxPool(j), annonceQuiNote(j, recu, true));

    const id = await store.setOptInByWaId(TENANT, '33600000001', 'opted_out', 'whatsapp_stop');
    expect(id, 'l’écriture est faite et l’identifiant remonte, malgré l’annonce en échec').toBe('c1');
    expect(j.evenements).toEqual(['ecriture:setOptInByWaId', 'annonce']);
  });

  /**
   * ⚠️ LE TÉMOIN DANS L'AUTRE SENS. Un `not.toHaveBeenCalled()` passe aussi quand rien ne se produit : sans
   * le cas `opted_out` juste au-dessus, ce test-ci validerait un dépôt qui n'annonce JAMAIS rien. La leçon
   * est celle du 2026-09-13, payée sur `tests/optout-blocage.test.ts`.
   */
  it('⚠️ un RÉabonnement n’annonce rien : ce n’est pas un refus', async () => {
    const j = journal();
    const recu: Array<{ tenantId: string; waIds: string[] }> = [];
    const store = new PgContactStore(fauxPool(j), annonceQuiNote(j, recu));
    await store.setOptInByWaId(TENANT, '33600000001', 'opted_in', 'scenario');

    expect(j.evenements).toEqual(['ecriture:setOptInByWaId']);
    expect(recu).toEqual([]);
  });

  it('⚠️ un numéro INCONNU n’annonce rien : il n’y a personne à pousser chez le client', async () => {
    const j = journal();
    const recu: Array<{ tenantId: string; waIds: string[] }> = [];
    const store = new PgContactStore(fauxPool(j, { idTouche: null }), annonceQuiNote(j, recu));
    const id = await store.setOptInByWaId(TENANT, '33699999999', 'opted_out', 'whatsapp_stop');

    expect(id).toBeNull();
    expect(recu).toEqual([]);
  });

  it('l’action en masse annonce TOUTES les identités touchées, en un seul geste', async () => {
    const j = journal();
    const recu: Array<{ tenantId: string; waIds: string[] }> = [];
    const lignesBulk = [
      { id: 'c1', phone_e164: '+33600000001', bsuid: null },
      { id: 'c2', phone_e164: null, bsuid: 'BSUID-XYZ' },
    ];
    const store = new PgContactStore(fauxPool(j, { lignesBulk }), annonceQuiNote(j, recu));
    const n = await store.applyEditsMany(TENANT, { ids: ['c1', 'c2'] }, { setOptIn: 'opted_out' });

    expect(n, 'le compte remonté ne change pas : `returning` ne remplace pas `rowCount`').toBe(2);
    expect(j.evenements).toEqual(['ecriture:applyEditsMany', 'annonce']);
    // ⚠️ Le BSUID est une identité aussi valable qu'un numéro : l'écarter laisserait hors de la poussée
    // exactement les contacts qui n'ont pas partagé leur téléphone.
    expect(recu[0]?.waIds).toEqual(['33600000001', 'BSUID-XYZ']);
  });

  it('la fiche contact annonce APRÈS le `commit`, avec l’identité RÉELLEMENT enregistrée', async () => {
    const j = journal();
    const recu: Array<{ tenantId: string; waIds: string[] }> = [];
    const store = new PgContactStore(fauxPoolTransactionnel(j), annonceQuiNote(j, recu));
    const r = await store.applyEdits(TENANT, 'c1', { fields: {}, addTags: [], removeTags: [], optInStatus: 'opted_out' });

    expect(r?.contact.id).toBe('c1');
    // 🔴 L'ORDRE EST LA FONCTIONNALITÉ : annoncer AVANT le `commit` pousserait chez le client un refus qu'un
    // `rollback` peut encore annuler.
    expect(j.evenements).toEqual(['ecriture:applyEdits', 'commit', 'annonce']);
    expect(recu[0]?.waIds).toEqual(['33600000001']);
  });

  it('⚠️ ...et une fiche contact qui RÉabonne n’annonce rien', async () => {
    const j = journal();
    const recu: Array<{ tenantId: string; waIds: string[] }> = [];
    const store = new PgContactStore(fauxPoolTransactionnel(j), annonceQuiNote(j, recu));
    await store.applyEdits(TENANT, 'c1', { fields: {}, addTags: [], removeTags: [], optInStatus: 'opted_in' });

    expect(j.evenements).toEqual(['ecriture:applyEdits', 'commit']);
    expect(recu).toEqual([]);
  });

  /**
   * ⚠️ LE `returning` EST CONDITIONNEL, ET C'EST UNE QUESTION DE COÛT. Une action en masse pose souvent une
   * étiquette sur des milliers de fiches ; ramener une ligne par contact pour n'en rien faire serait de
   * l'egress pur sur une base facturée à l'egress, invisible de tout écran (même famille que le sondage à
   * vide de `src/queue/names.ts`, qui pesait 88 % du trafic).
   */
  it('⚠️ une action en masse SANS opt-out ne ramène aucune ligne', async () => {
    const sqls: string[] = [];
    const pool = { query: async (sql: string) => { sqls.push(sql); return { rows: [], rowCount: 3 }; } } as unknown as Pool;
    const store = new PgContactStore(pool, async () => {});
    await store.applyEditsMany(TENANT, { ids: ['c1'] }, { addTags: ['vip'] });
    expect(sqls[0]).not.toMatch(/returning/i);

    // TÉMOIN : la MÊME méthode, avec un opt-out, ramène bien les identités.
    await store.applyEditsMany(TENANT, { ids: ['c1'] }, { setOptIn: 'opted_out' });
    expect(sqls[1]).toMatch(/returning id, phone_e164, bsuid/i);
  });

  it('⚠️ ...et une action en masse qui RÉabonne n’annonce rien', async () => {
    const j = journal();
    const recu: Array<{ tenantId: string; waIds: string[] }> = [];
    const store = new PgContactStore(fauxPool(j), annonceQuiNote(j, recu));
    await store.applyEditsMany(TENANT, { ids: ['c1'] }, { setOptIn: 'opted_in' });

    expect(j.evenements).toEqual(['ecriture:applyEditsMany']);
    expect(recu).toEqual([]);
  });
});

/**
 * 🔴 L'INVENTAIRE DES CHEMINS EST DÉRIVÉ DU CODE, PAS RECOPIÉ ICI.
 *
 * Une liste écrite à la main dérive dès qu'on ajoute un chemin d'écriture, MÊME quand elle est le garde-fou :
 * la leçon a été payée deux fois en une soirée le 2026-09-13 (l'inventaire des méthodes d'envoi, qui en
 * citait six sur huit ; et la migration 0138, dont l'invariant ne tenait que sur trois écritures sur quatre).
 * Ce test lit `contact-store.pg.ts`, y trouve toute requête capable de poser une DATE de désabonnement, et
 * exige que sa méthode figure dans la liste de celles qui annoncent.
 */
describe('🔴 tout chemin qui écrit un opt-out ANNONCE, et la liste est dérivée du fichier', () => {
  /** Les méthodes dont les tests ci-dessus prouvent qu'elles annoncent. */
  const METHODES_QUI_ANNONCENT = ['setOptInByWaId', 'applyEdits', 'applyEditsMany'];

  it('les méthodes qui posent `opt_out_at = now()` sont EXACTEMENT celles qui annoncent', () => {
    const source = readFileSync(new URL('../src/crm/contact-store.pg.ts', import.meta.url), 'utf8');
    const lignes = source.split('\n');
    let methode: string | null = null;
    const trouvees = new Set<string>();
    for (const ligne of lignes) {
      const m = /^\s{2}(?:private\s+|public\s+)?(?:static\s+)?async\s+([A-Za-z0-9_]+)\s*\(/.exec(ligne);
      if (m) methode = m[1]!;
      // Une écriture qui POSE la date (donc un passage en `opted_out`). Les upserts, qui ne savent que la
      // REMETTRE à null, n'écrivent jamais `now()` sur cette colonne et sont donc hors de portée : ils ne
      // peuvent pas faire régresser un statut, c'est l'invariant du chemin d'import et de l'API publique.
      if (/opt_out_at\s*=[^;]*now\(\)/.test(ligne) && methode !== null) trouvees.add(methode);
    }
    expect(trouvees.size, 'le balayage ne trouve plus aucune écriture : c’est le test qui est cassé').toBeGreaterThan(0);
    expect([...trouvees].sort()).toEqual([...METHODES_QUI_ANNONCENT].sort());
  });
});

describe('lotsDePoussee', () => {
  it('déduplique et écarte le vide : deux fiches d’un même numéro ne se poussent qu’une fois', () => {
    expect(lotsDePoussee(['33600', '33600', '  ', '', 'BSUID'])).toEqual([['33600', 'BSUID']]);
  });

  it('rien à pousser -> aucun lot (et donc aucun job)', () => {
    expect(lotsDePoussee([])).toEqual([]);
    expect(lotsDePoussee(['  '])).toEqual([]);
  });

  /** 🔴 UN DÉCOUPAGE, PAS UN PLAFOND : rien n'est écarté, la somme des lots vaut l'entrée. */
  it('🔴 découpe sans jamais rien perdre', () => {
    const entree = Array.from({ length: TAILLE_LOT_POUSSEE * 2 + 7 }, (_, i) => `w${i}`);
    const lots = lotsDePoussee(entree);
    expect(lots).toHaveLength(3);
    expect(lots[0]).toHaveLength(TAILLE_LOT_POUSSEE);
    expect(lots[2]).toHaveLength(7);
    expect(lots.flat()).toEqual(entree);
  });
});

describe('l’annonce n’échoue jamais vers son appelant', () => {
  it('une file en panne est journalisée, pas propagée', async () => {
    const logs: string[] = [];
    const annonce = creerAnnonceOptOut({
      enfiler: async () => { throw new Error('pgboss down'); },
      log: (m) => logs.push(m),
    });
    await expect(annonce(TENANT, ['33600'])).resolves.toBeUndefined();
    expect(logs.join('\n')).toContain('1 refus non annonces');
  });

  it('un lot par job, tous enfilés', async () => {
    const jobs: JobPousseeOptOut[] = [];
    const annonce = creerAnnonceOptOut({ enfiler: async (j) => { jobs.push(j); } });
    await annonce(TENANT, Array.from({ length: TAILLE_LOT_POUSSEE + 1 }, (_, i) => `w${i}`));
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.tenantId).toBe(TENANT);
    expect(jobs.flatMap((j) => j.waIds)).toHaveLength(TAILLE_LOT_POUSSEE + 1);
  });

  /**
   * 🔴 L'ÉCHÉANCE SUIT LA TAILLE DU LOT, sinon pg-boss croit le job mort et le REJOUE EN PARALLÈLE de
   * lui-même. Son défaut est de quinze minutes ; un lot de deux cents refus dont le système du client ne
   * répond plus les dépasse, chaque appel s'accordant `DELAI_POUSSEE_OPTOUT_MS`. On doublerait alors le
   * trafic vers un système déjà en difficulté, c'est-à-dire au pire moment.
   */
  it('🔴 chaque job porte une échéance DIMENSIONNÉE sur son lot', async () => {
    const echeances: number[] = [];
    const annonce = creerAnnonceOptOut({ enfiler: async (_j, o) => { echeances.push(o.expireInSeconds); } });
    await annonce(TENANT, Array.from({ length: TAILLE_LOT_POUSSEE + 3 }, (_, i) => `w${i}`));

    expect(echeances).toHaveLength(2);
    expect(echeances[0], 'le lot plein').toBe(echeanceDuLot(TAILLE_LOT_POUSSEE));
    expect(echeances[1], 'le reste, beaucoup plus court').toBe(echeanceDuLot(3));
    // ⚠️ LE TÉMOIN : un lot plein dépasse VRAIMENT le défaut de pg-boss (900 s), sinon ce calcul ne
    // protégerait de rien et le test passerait sur une échéance constante.
    expect(echeances[0]).toBeGreaterThan(900);
    expect(echeances[1]).toBeLessThan(900);
  });
});

/**
 * LE TRAVAIL : il relit le branchement, joue la requête, et LÈVE quand un appel a échoué (c'est le seul
 * moyen de demander une nouvelle tentative à pg-boss).
 *
 * ⚠️ Les gardes de l'appel lui-même (source active, filtre de sortie, adresse interne, redirection, corps
 * borné) ne sont PAS retestées ici : c'est le MÊME code que l'agent IA et le bloc « Appel HTTP » d'un
 * scénario (`creerAppelConnecteur`), couvert par ses propres tests. Ici on vérifie ce qui est propre à ce
 * chemin-ci.
 */
describe('le travail de poussée', () => {
  const REQUETE = {
    id: 'rq1', tenantId: TENANT, sourceId: 'src1', label: 'Desabonner dans le CRM',
    methode: 'POST' as const, chemin: '/contacts/unsubscribe', parametres: [], entetes: [],
    corps: { mode: 'json' as const, gabarit: '{"phone":"{{tel}}"}' },
    variables: [{ nom: 'tel', type: 'string' as const, origine: { type: 'contact' as const, cle: 'wa_id' as const } }],
    outputPaths: ['ok'], valeursTest: {}, outils: 0, updatedAt: '2026-09-13T00:00:00.000Z',
  };
  /**
   * ⚠️ IL SATISFAIT `SourceAppel` EN ENTIER, sans `as never`. Il annonçait un `authMode` qui n'existe dans
   * AUCUN contrat de ce dépôt, et personne ne l'a jamais vu : le `as never` posé au point d'usage avalait
   * aussi bien la propriété inventée que le `kind` manquant. C'est la quatrième fois aujourd'hui qu'un de
   * ces casts cache un faux qui ne tient pas le contrat qu'il prétend jouer.
   */
  const SOURCE: SourceAppel = {
    id: 'src1', kind: 'http', baseUrl: 'https://crm.exemple.fr',
    authKind: 'none', authHeaderName: null, authSecret: null, status: 'active',
  };

  function deps(over: Partial<Parameters<typeof creerTravailPousseeOptOut>[0]> = {}) {
    const appels: string[] = [];
    const corpsEnvoyes: string[] = [];
    const logs: string[] = [];
    const base = {
      sources: {
        pourAppel: async () => SOURCE,
        marquerEpreuve: async () => {},
      },
      requetes: { parId: async () => REQUETE as never },
      requeteConfiguree: async () => 'rq1',
      projectionContact: async () => ({ nom: 'Julie', tags: [], champs: {} }),
      fetchImpl: (async (url: string, init?: RequestInit) => {
        appels.push(String(url));
        corpsEnvoyes.push(typeof init?.body === 'string' ? init.body : '');
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
      verifierResolution: async () => ({ ok: true as const }),
      log: (m: string) => logs.push(m),
    };
    return { travail: creerTravailPousseeOptOut({ ...base, ...over } as Parameters<typeof creerTravailPousseeOptOut>[0]), appels, corpsEnvoyes, logs };
  }

  it('un appel par personne du lot, et c’est bien SON identité qui part', async () => {
    const { travail, appels, corpsEnvoyes } = deps();
    await travail({ tenantId: TENANT, waIds: ['33600000001', '33600000002'] });
    expect(appels).toHaveLength(2);
    expect(appels[0]).toContain('https://crm.exemple.fr/contacts/unsubscribe');
    /**
     * 🔴 SANS CETTE ASSERTION, LE TEST PASSERAIT SUR UN APPEL QUI PART À VIDE. C'est le seul endroit qui
     * prouve que le système du client apprend DE QUI il s'agit : un POST bien formé vers la bonne adresse,
     * avec un corps sans numéro, désabonnerait personne et n'aurait l'air de rien.
     */
    expect(corpsEnvoyes).toEqual(['{"phone":"33600000001"}', '{"phone":"33600000002"}']);
  });

  /**
   * 🔴 RELU À L'EXÉCUTION, PAS PORTÉ PAR LE JOB. Un job peut être repris des heures plus tard (retard, DLQ
   * rejouée) : pousser vers un connecteur que le client vient de débrancher enverrait ses données à un
   * système dont il ne veut plus.
   */
  it('🔴 aucun connecteur branché -> AUCUN appel, et ce n’est pas un échec', async () => {
    const { travail, appels, logs } = deps({ requeteConfiguree: async () => null });
    await expect(travail({ tenantId: TENANT, waIds: ['33600000001'] })).resolves.toBeUndefined();
    expect(appels).toEqual([]);
    expect(logs.join('\n')).toContain('aucun connecteur branche');
  });

  it('un système du client en panne -> le travail LÈVE, pour que pg-boss réessaie', async () => {
    const { travail, logs } = deps({
      fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
    });
    await expect(travail({ tenantId: TENANT, waIds: ['33600000001'] })).rejects.toThrow(/1\/1 appels en echec/);
    expect(logs.join('\n')).toContain('refus non pousses');
  });

  it('un refus du système du client (500) compte aussi comme un échec', async () => {
    const { travail } = deps({
      fetchImpl: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
    });
    await expect(travail({ tenantId: TENANT, waIds: ['33600000001'] })).rejects.toThrow(/appels en echec/);
  });

  it('⚠️ un échec sur UN contact n’empêche pas les autres de partir', async () => {
    let n = 0;
    const { travail, appels } = deps({
      fetchImpl: (async (url: string) => {
        n += 1;
        appels.length = 0; // non utilisé ici, l'ordre est porté par `n`
        if (n === 1) throw new Error('coupure');
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
    });
    await expect(travail({ tenantId: TENANT, waIds: ['a', 'b', 'c'] })).rejects.toThrow(/1\/3 appels en echec/);
    expect(n, 'les trois ont été tentés, pas seulement jusqu’au premier échec').toBe(3);
  });

  it('un payload illisible lève : il finira en DLQ, visible de /ops', async () => {
    const { travail } = deps();
    await expect(travail({ waIds: ['33600'] })).rejects.toThrow(/payload invalide/);
    await expect(travail(null)).rejects.toThrow(/payload invalide/);
  });

  it('un lot vide ne fait rien, et ne lit même pas le réglage', async () => {
    let lu = 0;
    const { travail, appels } = deps({ requeteConfiguree: async () => { lu += 1; return 'rq1'; } });
    await travail({ tenantId: TENANT, waIds: [] });
    expect(appels).toEqual([]);
    expect(lu).toBe(0);
  });
});
