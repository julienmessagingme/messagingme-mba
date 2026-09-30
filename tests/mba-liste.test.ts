import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  creerListeDeLAgent, formesDuNumero, numeroDuDestinataire, RetraitDeLaListeRefuse, REJEU_ATTENTE_DEFAUT_MS, REJEU_ATTENTE_MAX_MS,
  type ClientListe, type ListeStore,
} from '../src/mba/liste';
import { creerControleDuFil } from '../src/inbox/fil';
import { MetaApiError, classify, estPlafondNumero } from '../src/meta/errors';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';
import { DELAI_REPRISE_DEFAUT_MS, depotEnMemoire, listeEnMemoire } from './banc-du-fil';
import { jamaisBloque, jamaisDesabonne } from './consentement';

/**
 * LA LISTE DE L'AGENT DE META, TENUE PAR LA PLATEFORME (`src/mba/liste.ts`, migration 0195).
 *
 * 🔴 NOTRE TABLE FAIT FOI SUR CE QUI EST SUR LA LISTE : Meta ne rend l'identifiant d'une entrée qu'à l'ajout, et sans
 * lui on ne peut plus retirer. D'où l'ordre de chaque geste, que ces cas figent : ajouter, c'est Meta PUIS la ligne
 * (défaite si la ligne échoue) ; retirer, c'est Meta PUIS la ligne (gardée si Meta refuse). Chaque cas 🔴 a été
 * vérifié dans les deux sens : l'ordre inversé ou la garde retirée, il échoue.
 */

afterEach(() => { vi.restoreAllMocks(); });

const T = 't1';
const PN = 'pn1';
const WA = '33612345678';

/** Un faux client MBA qui écrit dans `journal` et répond selon le script. `liste` : ce que Meta a déjà. */
function clientFactice(o: {
  journal: string[];
  liste?: Array<{ id: string; consumer_phone_number: string }>;
  ajout?: () => unknown;
  retrait?: Array<'ok' | MetaApiError>;
} ) {
  let rangRetrait = 0;
  const client: ClientListe = {
    listAllowlist: async () => { o.journal.push('meta:lecture'); return o.liste ?? []; },
    addToAllowlist: async (pn, numero) => {
      o.journal.push(`meta:ajout:${pn}:${numero}`);
      return o.ajout ? o.ajout() : { id: 'e-neuve', consumer_phone_number: numero };
    },
    removeFromAllowlist: async (pn, entree) => {
      o.journal.push(`meta:retrait:${pn}:${entree}`);
      const r = o.retrait?.[Math.min(rangRetrait, (o.retrait?.length ?? 1) - 1)] ?? 'ok';
      rangRetrait += 1;
      if (r !== 'ok') throw r;
    },
  };
  return client;
}

/** La table en mémoire, dont chaque écriture est notée dans le même journal que Meta. */
function tableJournalisee(journal: string[], initial: string[] = [], o: { poserEchoue?: boolean } = {}) {
  const t = listeEnMemoire(initial, o);
  const store: ListeStore = {
    ...t.store,
    poser: async (tenant, waId, pn, entree) => { journal.push(`ligne:pose:${waId}:${entree}`); await t.store.poser(tenant, waId, pn, entree); },
    supprimer: async (tenant, waId) => { journal.push(`ligne:supprime:${waId}`); await t.store.supprimer(tenant, waId); },
  };
  return { store, lignes: t.lignes };
}

function monter(o: {
  initial?: string[]; poserEchoue?: boolean;
  liste?: Array<{ id: string; consumer_phone_number: string }>; ajout?: () => unknown; retrait?: Array<'ok' | MetaApiError>;
} = {}) {
  const journal: string[] = [];
  const attentes: number[] = [];
  const table = tableJournalisee(journal, o.initial, { poserEchoue: o.poserEchoue === true });
  const client = clientFactice({ journal, ...(o.liste ? { liste: o.liste } : {}), ...(o.ajout ? { ajout: o.ajout } : {}), ...(o.retrait ? { retrait: o.retrait } : {}) });
  const liste = creerListeDeLAgent({ store: table.store, clientMba: async () => client, attendre: async (ms) => { attentes.push(ms); } });
  return { liste, journal, attentes, lignes: table.lignes };
}

const doublon = () => new MetaApiError(400, { message: 'The request or consumer identifier is invalid', type: 'MbaError' });

describe('ajouter : Meta, puis la ligne', () => {
  it('🔴 dans cet ordre, en E.164, avec l’identifiant rendu par Meta', async () => {
    const m = monter();
    expect(await m.liste.ajouter(T, PN, WA)).toBe(true);
    expect(m.journal).toEqual([`meta:ajout:${PN}:+${WA}`, `ligne:pose:${WA}:e-neuve`]);
    expect(m.lignes.get(WA)).toEqual({ phoneNumberId: PN, entreeId: 'e-neuve' });
  });

  it('🔴 un contact déjà dans notre table : AUCUN appel, et rien n’est réécrit', async () => {
    // L'idempotence se tient par notre table : Meta répond au doublon par un 400 qui ne se distingue pas d'un numéro
    // invalide (mesuré le 2026-09-29).
    const m = monter({ initial: [WA] });
    expect(await m.liste.ajouter(T, PN, WA)).toBe(false);
    expect(m.journal).toEqual([]);
  });

  it('🔴 un 400 de doublon (déjà chez Meta, pas chez nous) : une relecture retrouve l’entrée, qui est enregistrée', async () => {
    const m = monter({ ajout: () => { throw doublon(); }, liste: [{ id: 'e-ancienne', consumer_phone_number: `+${WA}` }] });
    expect(await m.liste.ajouter(T, PN, WA)).toBe(true);
    expect(m.journal).toEqual([`meta:ajout:${PN}:+${WA}`, 'meta:lecture', `ligne:pose:${WA}:e-ancienne`]);
  });

  it('🔴 un 400 que la relecture n’explique pas : l’erreur de Meta remonte, et rien n’est écrit', async () => {
    const m = monter({ ajout: () => { throw doublon(); }, liste: [{ id: 'e-autre', consumer_phone_number: '+33700000000' }] });
    await expect(m.liste.ajouter(T, PN, WA)).rejects.toThrow(/consumer identifier is invalid/);
    expect(m.lignes.has(WA)).toBe(false);
  });

  it('un refus qui n’est pas un 400 ne déclenche aucune relecture', async () => {
    const m = monter({ ajout: () => { throw new MetaApiError(403, { message: 'interdit' }); } });
    await expect(m.liste.ajouter(T, PN, WA)).rejects.toThrow('interdit');
    expect(m.journal).toEqual([`meta:ajout:${PN}:+${WA}`]);
  });

  it('⚠️ une réponse d’ajout illisible (sans identifiant) : la relecture la retrouve, sinon on lève', async () => {
    const retrouvee = monter({ ajout: () => ({ ok: true }), liste: [{ id: 'e-lue', consumer_phone_number: `+${WA}` }] });
    expect(await retrouvee.liste.ajouter(T, PN, WA)).toBe(true);
    expect(retrouvee.lignes.get(WA)?.entreeId).toBe('e-lue');
    const perdue = monter({ ajout: () => ({ ok: true }) });
    await expect(perdue.liste.ajouter(T, PN, WA)).rejects.toThrow(/aucun identifiant/);
    expect(perdue.lignes.has(WA)).toBe(false);
  });

  it('🔴 la ligne ne s’écrit pas : l’ajout est DÉFAIT chez Meta, puis l’erreur remonte', async () => {
    // Sans ligne, plus rien ne retirerait ce contact : il recevrait nos modèles avec l'agent qui répond.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = monter({ poserEchoue: true });
    await expect(m.liste.ajouter(T, PN, WA)).rejects.toThrow('base indisponible');
    expect(m.journal).toEqual([`meta:ajout:${PN}:+${WA}`, `ligne:pose:${WA}:e-neuve`, `meta:retrait:${PN}:e-neuve`]);
  });
});

describe('retirer : Meta, puis la ligne', () => {
  it('🔴 dans cet ordre, avec le numéro et l’identifiant GARDÉS dans la table', async () => {
    const m = monter({ initial: [WA] });
    expect(await m.liste.retirer(T, WA)).toBe(true);
    expect(m.journal).toEqual([`meta:retrait:pn1:entree-${WA}`, `ligne:supprime:${WA}`]);
  });

  it('🔴 absent de la table : `true`, sans AUCUN appel', async () => {
    const m = monter();
    expect(await m.liste.retirer(T, WA)).toBe(true);
    expect(m.journal).toEqual([]);
  });

  it('🔴 un 404 vaut retrait : l’entrée n’existe plus chez Meta, la ligne part', async () => {
    const m = monter({ initial: [WA], retrait: [new MetaApiError(404, { message: 'Not Found' })] });
    expect(await m.liste.retirer(T, WA)).toBe(true);
    expect(m.lignes.has(WA)).toBe(false);
  });

  it('🔴 un refus définitif : `false`, un seul appel, et la ligne RESTE', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = monter({ initial: [WA], retrait: [new MetaApiError(403, { message: 'interdit' })] });
    expect(await m.liste.retirer(T, WA)).toBe(false);
    expect(m.journal).toEqual([`meta:retrait:pn1:entree-${WA}`]);
    expect(m.lignes.has(WA)).toBe(true);
  });

  it('🔴 un refus rejouable : UN rejeu, et jamais deux', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const passager = () => new MetaApiError(429, null);
    const une = monter({ initial: [WA], retrait: [passager(), 'ok'] });
    expect(await une.liste.retirer(T, WA)).toBe(true);
    expect(une.journal.filter((l) => l.startsWith('meta:'))).toHaveLength(2);
    expect(une.attentes).toEqual([REJEU_ATTENTE_DEFAUT_MS]);

    const deux = monter({ initial: [WA], retrait: [passager(), passager(), 'ok'] });
    expect(await deux.liste.retirer(T, WA)).toBe(false);
    expect(deux.journal.filter((l) => l.startsWith('meta:')), 'on ne boucle pas').toHaveLength(2);
    expect(deux.lignes.has(WA)).toBe(true);
  });

  it('⚠️ l’attente vaut le `Retry-After` de Meta, plafonné', async () => {
    const m = monter({ initial: [WA], retrait: [new MetaApiError(429, null, 30_000), 'ok'] });
    await m.liste.retirer(T, WA);
    expect(m.attentes).toEqual([REJEU_ATTENTE_MAX_MS]);
  });

  it('⚠️ un client MBA indisponible vaut un refus : `false`, sans lever', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = listeEnMemoire([WA]);
    const liste = creerListeDeLAgent({ store: t.store, clientMba: async () => { throw new Error('jeton illisible'); }, attendre: async () => {} });
    await expect(liste.retirer(T, WA)).resolves.toBe(false);
  });

  /**
   * 🔴 UNE PANNE DE NOTRE TABLE N'EST PAS UN REFUS DE META. Elle rendait `false`, que chaque appelant traite comme un
   * refus définitif (409 dans l'Inbox, démarrage annulé, lead en `reprise_refusee`, et un modèle d'une campagne
   * compté comme refusé par Meta). Elle lève : le job ou la requête échoue et se rejoue. Vérifié dans les deux sens :
   * la lecture de la table remise dans le `try`, les trois cas échouent (`false`, puis `RetraitDeLaListeRefuse`).
   */
  it('🔴 la lecture de la table en panne : `retirer` LÈVE, sans aucun appel à Meta', async () => {
    const journal: string[] = [];
    const panne = new Error('base indisponible');
    const liste = creerListeDeLAgent({
      store: { ...listeEnMemoire([WA]).store, trouver: async () => { throw panne; } },
      clientMba: async () => clientFactice({ journal }),
      attendre: async () => {},
    });
    await expect(liste.retirer(T, WA)).rejects.toBe(panne);
    expect(journal).toEqual([]);
  });

  it('🔴 la suppression de la ligne en panne APRÈS le retrait chez Meta : `retirer` LÈVE (rejoué, Meta rendra 404)', async () => {
    const journal: string[] = [];
    const t = listeEnMemoire([WA]);
    const liste = creerListeDeLAgent({
      store: { ...t.store, supprimer: async () => { throw new Error('base indisponible'); } },
      clientMba: async () => clientFactice({ journal }),
      attendre: async () => {},
    });
    await expect(liste.retirer(T, WA)).rejects.toThrow('base indisponible');
    expect(journal).toEqual([`meta:retrait:pn1:entree-${WA}`]);
  });

  it('🔴 avant un modèle, une panne de la table remonte telle quelle, pas en « Meta a refusé »', async () => {
    const liste = creerListeDeLAgent({
      store: { ...listeEnMemoire([WA]).store, trouver: async () => { throw new Error('base indisponible'); } },
      clientMba: async () => clientFactice({ journal: [] }),
      attendre: async () => {},
    });
    const err = await liste.retirerAvantUnModele(T, `+${WA}`).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(RetraitDeLaListeRefuse);
    expect((err as Error).message).toBe('base indisponible');
  });
});

describe('retirerAvantUnModele', () => {
  it('🔴 un refus lève une erreur que `classify` range en REJOUABLE, et qui n’est pas un plafond du numéro', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = monter({ initial: [WA], retrait: [new MetaApiError(403, { message: 'interdit' })] });
    const err = await m.liste.retirerAvantUnModele(T, `+${WA}`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetraitDeLaListeRefuse);
    expect(err).toBeInstanceOf(MetaApiError);
    const e = err as MetaApiError;
    expect(classify(e.httpStatus, { ...(e.code !== undefined ? { code: e.code } : {}) })).toBe(true);
    expect(e.retryable).toBe(true);
    expect(estPlafondNumero(e), 'un plafond mettrait toute la campagne en pause').toBe(false);
    // L'Inbox affiche `userMessage` : il dit ce qui s'est passé et quoi faire.
    expect(e.userMessage).toMatch(/Réessayez/);
  });

  it('ramène le destinataire aux chiffres nus, et ignore un BSUID', async () => {
    expect(numeroDuDestinataire('+33 6 12 34 56 78')).toBe(WA);
    expect(numeroDuDestinataire(WA)).toBe(WA);
    expect(numeroDuDestinataire('US.13491208655302741918')).toBeNull();
    expect(numeroDuDestinataire('1349120865530274191')).toBeNull(); // 19 chiffres : un BSUID numérique, pas un numéro
    const m = monter({ initial: ['13491208655'] });
    await m.liste.retirerAvantUnModele(T, 'US.13491208655');
    expect(m.journal).toEqual([]);
  });

  /**
   * 🔴 LE NUMÉRO DE LA FICHE ET LE `wa_id` DU WEBHOOK PEUVENT DIFFÉRER (le 9 des mobiles brésiliens, le 1 des mobiles
   * mexicains). La ligne porte le `wa_id` ; le modèle part vers le numéro de la fiche. Sans les deux formes, le
   * retrait ne voyait pas la ligne, le modèle partait, et l'agent répondait à la réponse du contact. Vérifié dans
   * les deux sens : `retirerAvantUnModele` remis sur la seule forme reçue, les trois premiers cas échouent (aucun
   * retrait, la ligne reste).
   */
  it.each([
    ['Brésil, fiche avec le 9, ligne sans', '+55 11 98765-4321', '551187654321'],
    ['Brésil, fiche sans le 9, ligne avec', '+551187654321', '5511987654321'],
    ['Mexique, fiche en E.164, ligne en 521', '+52 55 1234 5678', '5215512345678'],
    ['Mexique, fiche en 521, ligne en E.164', '+5215512345678', '525512345678'],
  ])('🔴 %s : la ligne est retirée avant le modèle', async (_nom, destinataire, ligne) => {
    const m = monter({ initial: [ligne] });
    await m.liste.retirerAvantUnModele(T, destinataire);
    expect(m.journal).toEqual([`meta:retrait:pn1:entree-${ligne}`, `ligne:supprime:${ligne}`]);
    expect(m.lignes.has(ligne)).toBe(false);
  });

  it('les formes d’un numéro : la variante du 9 brésilien et du 1 mexicain, rien pour un autre pays ni pour un fixe', () => {
    expect(formesDuNumero('5511987654321')).toEqual(['5511987654321', '551187654321']);
    expect(formesDuNumero('551187654321')).toEqual(['551187654321', '5511987654321']);
    expect(formesDuNumero('5215512345678')).toEqual(['5215512345678', '525512345678']);
    expect(formesDuNumero('525512345678')).toEqual(['525512345678', '5215512345678']);
    expect(formesDuNumero(WA)).toEqual([WA]);
    // Un fixe brésilien (premier chiffre de 2 à 5) n'a jamais reçu de 9 : pas de variante, qui serait un autre abonné.
    expect(formesDuNumero('551132345678')).toEqual(['551132345678']);
  });
});

describe('oublierChezMeta (après une purge)', () => {
  it('retire chaque entrée, sans lever, même quand Meta refuse l’une d’elles', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = monter({ retrait: [new MetaApiError(403, { message: 'interdit' }), 'ok'] });
    await expect(m.liste.oublierChezMeta(T, [
      { waId: '33600000001', phoneNumberId: PN, entreeId: 'e1' },
      { waId: '33600000002', phoneNumberId: PN, entreeId: 'e2' },
    ])).resolves.toBeUndefined();
    expect(m.journal).toEqual([`meta:retrait:${PN}:e1`, `meta:retrait:${PN}:e2`]);
  });
});

/**
 * 🔴 INVARIANT 2 DU CADRAGE, SUR LES DEUX MODULES RÉELS : confier ordonne l'ajout chez Meta, la ligne, puis le
 * `release` ; reprendre ordonne Meta, puis la ligne. Un seul journal, écrit par la table, le client MBA et le dépôt
 * de la conversation. Vérifié dans les deux sens : `release` avant `ajouter` dans `confier`, le premier cas échoue.
 */
describe('confier et reprendre, dans l’ordre (`src/inbox/fil.ts` sur `src/mba/liste.ts`)', () => {
  function monterLeFil(initial: string[] = []) {
    const journal: string[] = [];
    const table = tableJournalisee(journal, initial);
    const client = {
      ...clientFactice({ journal }),
      releaseThread: async (_pn: string, waId: string) => { journal.push(`meta:release:${waId}`); },
      agentEvent: async (_pn: string, to: string) => { journal.push(`meta:evenement:${to}`); return {}; },
    };
    const liste = creerListeDeLAgent({ store: table.store, clientMba: async () => client, attendre: async () => {} });
    const memoire = depotEnMemoire({ [WA]: { owner: 'app_human' } });
    const fil = creerControleDuFil({
      depot: {
        ...memoire.depot,
        setControlOwner: async (t, w, owner, opts) => { journal.push(`colonne:${owner}`); return memoire.depot.setControlOwner(t, w, owner, opts); },
      },
      reglages: { get: async () => ({ mbaEnabled: true, controlHandbackSeconds: null }) },
      delaiRepriseParDefautMs: DELAI_REPRISE_DEFAUT_MS,
      parcours: { findWaitingByWaId: async () => null },
      numeros: { getTenantPhoneNumberId: async () => PN },
      liste,
      consentement: { estDesabonne: jamaisDesabonne, estBloque: jamaisBloque },
      meta: { mbaClientForTenant: async () => client },
    });
    return { fil, journal };
  }

  it('🔴 confier : l’ajout chez Meta, la ligne, le release, puis notre colonne', async () => {
    const m = monterLeFil();
    expect(await m.fil.rendreLaMain(T, WA, { collaborateur: null })).toBe('mba');
    expect(m.journal).toEqual([`meta:ajout:${PN}:+${WA}`, `ligne:pose:${WA}:e-neuve`, `meta:release:${WA}`, 'colonne:mba']);
  });

  it('🔴 reprendre : le retrait chez Meta, la ligne, puis notre colonne', async () => {
    const m = monterLeFil([WA]);
    expect(await m.fil.reprendreLaMain(T, WA, { collaborateur: null })).toBe('pris');
    expect(m.journal).toEqual([`meta:retrait:pn1:entree-${WA}`, `ligne:supprime:${WA}`, 'colonne:app_human']);
  });
});

/**
 * LA MIGRATION 0195 : la table que la liste lit sur le chemin chaud. Sa clé primaire est la seule lecture (avant
 * chaque modèle, à l'arrivée de chaque `standby`), d'où AUCUN autre index. Son effet en base (clé primaire, cascade
 * depuis l'espace, `presents`) : `tests/integration/mba-liste.integration.test.ts`, en CI.
 */
describe('migration 0195', () => {
  const SQL = readFileSync(new URL('../db/migrations/0195_mba_liste.sql', import.meta.url), 'utf8');
  const sansCommentaires = (t: string): string => t.split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
  const instructions = decouperInstructions(SQL)
    .map(sansCommentaires)
    .map((i) => i.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim())
    .filter((i) => i !== '');

  it('🔴 une table, sa clé primaire (tenant_id, wa_id), la cascade depuis l’espace, et rien d’autre', () => {
    expect(instructions).toEqual([
      'create table if not exists mba_liste ( tenant_id uuid not null references tenants (id) on delete cascade, wa_id text not null, phone_number_id text not null, entree_id text not null, ajoute_le timestamptz not null default now(), primary key (tenant_id, wa_id) )',
    ]);
  });

  it('dans une transaction ordinaire, et sans accent grave (le runner lit le fichier dans un gabarit de chaîne)', () => {
    expect(veutHorsTransaction(SQL)).toBe(false);
    expect(SQL).not.toContain('`');
  });

  it('🔴 chaque requête du magasin est scopée à l’espace', () => {
    const magasin = readFileSync(new URL('../src/mba/liste.pg.ts', import.meta.url), 'utf8');
    const requetes = [...magasin.matchAll(/`((?:select|insert|delete|update)[^`]*mba_liste[^`]*)`/g)].map((r) => r[1]!);
    expect(requetes).toHaveLength(4);
    for (const q of requetes) expect(q, q).toMatch(/tenant_id = \$1|values \(\$1/);
  });
});
