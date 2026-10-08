import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  creerListeDeLAgent, formesDuNumero, ListePleine, numeroDuDestinataire, PLAFOND_LISTE, RetraitDeLaListeRefuse, REJEU_ATTENTE_DEFAUT_MS, REJEU_ATTENTE_MAX_MS,
  type ClientListe, type ListeStore,
} from '../src/mba/liste';
import { creerControleDuFil } from '../src/inbox/fil';
import { MetaApiError, classify, estPlafondNumero } from '../src/meta/errors';
import { decouperInstructions, veutHorsTransaction } from '../src/db/migration-directives';
import { DELAI_REPRISE_DEFAUT_MS, aucunRepondeur, depotEnMemoire, listeEnMemoire } from './banc-du-fil';
import { jamaisBloque, jamaisDesabonne, numeroJamaisBloque } from './consentement';
import { offresToutOuvert } from './gardes';

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
/** Le droit de faire sortir quelqu'un quand la liste est pleine : celui de tous les gestes sauf le balayage. */
const PLACE = { faireDeLaPlace: true };

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
    expect(await m.liste.ajouter(T, PN, WA, PLACE)).toBe(true);
    expect(m.journal).toEqual([`meta:ajout:${PN}:+${WA}`, `ligne:pose:${WA}:e-neuve`]);
    expect(m.lignes.get(WA)).toEqual({ phoneNumberId: PN, entreeId: 'e-neuve' });
  });

  it('🔴 un contact déjà dans notre table : AUCUN appel, et rien n’est réécrit', async () => {
    // L'idempotence se tient par notre table : Meta répond au doublon par un 400 qui ne se distingue pas d'un numéro
    // invalide (mesuré le 2026-09-29).
    const m = monter({ initial: [WA] });
    expect(await m.liste.ajouter(T, PN, WA, PLACE)).toBe(false);
    expect(m.journal).toEqual([]);
  });

  it('🔴 un 400 de doublon (déjà chez Meta, pas chez nous) : une relecture retrouve l’entrée, qui est enregistrée', async () => {
    const m = monter({ ajout: () => { throw doublon(); }, liste: [{ id: 'e-ancienne', consumer_phone_number: `+${WA}` }] });
    expect(await m.liste.ajouter(T, PN, WA, PLACE)).toBe(true);
    expect(m.journal).toEqual([`meta:ajout:${PN}:+${WA}`, 'meta:lecture', `ligne:pose:${WA}:e-ancienne`]);
  });

  it('🔴 un 400 que la relecture n’explique pas : l’erreur de Meta remonte, et rien n’est écrit', async () => {
    const m = monter({ ajout: () => { throw doublon(); }, liste: [{ id: 'e-autre', consumer_phone_number: '+33700000000' }] });
    await expect(m.liste.ajouter(T, PN, WA, PLACE)).rejects.toThrow(/consumer identifier is invalid/);
    expect(m.lignes.has(WA)).toBe(false);
  });

  it('un refus qui n’est pas un 400 ne déclenche aucune relecture', async () => {
    const m = monter({ ajout: () => { throw new MetaApiError(403, { message: 'interdit' }); } });
    await expect(m.liste.ajouter(T, PN, WA, PLACE)).rejects.toThrow('interdit');
    expect(m.journal).toEqual([`meta:ajout:${PN}:+${WA}`]);
  });

  it('⚠️ une réponse d’ajout illisible (sans identifiant) : la relecture la retrouve, sinon on lève', async () => {
    const retrouvee = monter({ ajout: () => ({ ok: true }), liste: [{ id: 'e-lue', consumer_phone_number: `+${WA}` }] });
    expect(await retrouvee.liste.ajouter(T, PN, WA, PLACE)).toBe(true);
    expect(retrouvee.lignes.get(WA)?.entreeId).toBe('e-lue');
    const perdue = monter({ ajout: () => ({ ok: true }) });
    await expect(perdue.liste.ajouter(T, PN, WA, PLACE)).rejects.toThrow(/aucun identifiant/);
    expect(perdue.lignes.has(WA)).toBe(false);
  });

  it('🔴 la ligne ne s’écrit pas : l’ajout est DÉFAIT chez Meta, puis l’erreur remonte', async () => {
    // Sans ligne, plus rien ne retirerait ce contact : il recevrait nos modèles avec l'agent qui répond.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = monter({ poserEchoue: true });
    await expect(m.liste.ajouter(T, PN, WA, PLACE)).rejects.toThrow('base indisponible');
    expect(m.journal).toEqual([`meta:ajout:${PN}:+${WA}`, `ligne:pose:${WA}:e-neuve`, `meta:retrait:${PN}:e-neuve`]);
  });
});

describe('la liste tourne : au plafond de Meta, le moins actif sort (2026-10-08)', () => {
  /** Vingt numéros distincts, posés dans cet ordre : en mémoire, le premier posé est le moins actif. */
  const vingt = Array.from({ length: PLAFOND_LISTE }, (_, i) => `3360000${String(i).padStart(4, '0')}`);
  const pleineChezMeta = vingt.map((w) => ({ id: `meta-${w}`, consumer_phone_number: `+${w}` }));

  it('le plafond est celui que Meta documente : 20 contacts par numéro', () => {
    expect(PLAFOND_LISTE).toBe(20);
  });

  it('🔴 notre table est pleine : le moins actif sort (Meta puis sa ligne) AVANT l’ajout', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const m = monter({ initial: vingt });
    expect(await m.liste.ajouter(T, PN, WA, PLACE)).toBe(true);
    expect(m.journal).toEqual([
      `meta:retrait:${PN}:entree-${vingt[0]}`, `ligne:supprime:${vingt[0]}`,
      `meta:ajout:${PN}:+${WA}`, `ligne:pose:${WA}:e-neuve`,
    ]);
    expect(m.lignes.size).toBe(PLAFOND_LISTE);
    expect(m.lignes.has(vingt[1]!), 'un seul sort').toBe(true);
  });

  it('🔴 une place libre : personne ne sort', async () => {
    const m = monter({ initial: vingt.slice(1) });
    expect(await m.liste.ajouter(T, PN, WA, PLACE)).toBe(true);
    expect(m.journal).toEqual([`meta:ajout:${PN}:+${WA}`, `ligne:pose:${WA}:e-neuve`]);
  });

  it('🔴 le plafond se compte PAR NUMÉRO : vingt contacts sur un autre numéro ne font sortir personne', async () => {
    const m = monter();
    for (const w of vingt) m.lignes.set(w, { phoneNumberId: 'pn-autre', entreeId: `entree-${w}` });
    expect(await m.liste.ajouter(T, PN, WA, PLACE)).toBe(true);
    expect(m.journal).toEqual([`meta:ajout:${PN}:+${WA}`, `ligne:pose:${WA}:e-neuve`]);
  });

  it('🔴 Meta la dit pleine alors que notre table ne l’est pas : le moins actif sort, et UN nouvel essai', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    let essais = 0;
    const m = monter({
      initial: [vingt[0]!, vingt[1]!],
      liste: pleineChezMeta,
      ajout: () => { essais += 1; if (essais === 1) throw doublon(); return { id: 'e-neuve', consumer_phone_number: `+${WA}` }; },
    });
    expect(await m.liste.ajouter(T, PN, WA, PLACE)).toBe(true);
    expect(m.journal).toEqual([
      `meta:ajout:${PN}:+${WA}`, 'meta:lecture',
      `meta:retrait:${PN}:entree-${vingt[0]}`, `ligne:supprime:${vingt[0]}`,
      `meta:ajout:${PN}:+${WA}`, `ligne:pose:${WA}:e-neuve`,
    ]);
  });

  it('🔴 Meta la dit pleine deux fois : le refus remonte, sans troisième essai', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const m = monter({ initial: [vingt[0]!, vingt[1]!], liste: pleineChezMeta, ajout: () => { throw doublon(); } });
    await expect(m.liste.ajouter(T, PN, WA, PLACE)).rejects.toThrow(/consumer identifier is invalid/);
    expect(m.journal.filter((l) => l.startsWith('meta:ajout')), 'on ne boucle pas').toHaveLength(2);
    expect(m.lignes.has(WA)).toBe(false);
  });

  it('🔴 Meta la dit pleine et notre table n’a personne à faire sortir : le refus remonte tout de suite', async () => {
    const m = monter({ liste: pleineChezMeta, ajout: () => { throw doublon(); } });
    await expect(m.liste.ajouter(T, PN, WA, PLACE)).rejects.toThrow(/consumer identifier is invalid/);
    expect(m.journal).toEqual([`meta:ajout:${PN}:+${WA}`, 'meta:lecture']);
  });

  it('🔴 un 400 sur une liste QUI N’EST PAS pleine ne fait sortir personne', async () => {
    // Un numéro refusé n'est pas une liste pleine : faire sortir un contact pour rien lui couperait l'agent.
    const m = monter({ initial: [vingt[0]!], liste: [{ id: 'e-autre', consumer_phone_number: '+33700000000' }], ajout: () => { throw doublon(); } });
    await expect(m.liste.ajouter(T, PN, WA, PLACE)).rejects.toThrow(/consumer identifier is invalid/);
    expect(m.lignes.has(vingt[0]!)).toBe(true);
    expect(m.journal).toEqual([`meta:ajout:${PN}:+${WA}`, 'meta:lecture']);
  });

  it('🔴 sans le droit de faire de la place (le balayage), liste pleine : `ListePleine`, et AUCUN appel à Meta', async () => {
    // Le balayage confie en rafale des fils inactifs : avec ce droit, il ferait sortir ceux qui parlent à l'agent.
    const m = monter({ initial: vingt });
    await expect(m.liste.ajouter(T, PN, WA, { faireDeLaPlace: false })).rejects.toBeInstanceOf(ListePleine);
    expect(m.journal).toEqual([]);
    expect(m.lignes.size).toBe(PLAFOND_LISTE);
  });

  it('🔴 sans le droit de faire de la place, Meta la dit pleine : le refus remonte, personne ne sort', async () => {
    const m = monter({ initial: [vingt[0]!], liste: pleineChezMeta, ajout: () => { throw doublon(); } });
    await expect(m.liste.ajouter(T, PN, WA, { faireDeLaPlace: false })).rejects.toThrow(/consumer identifier is invalid/);
    expect(m.lignes.has(vingt[0]!)).toBe(true);
    expect(m.journal).toEqual([`meta:ajout:${PN}:+${WA}`, 'meta:lecture']);
  });

  it('🔴 un identifiant qui n’est pas un numéro, liste pleine : personne ne sort pour lui', async () => {
    // Meta refuse un BSUID à chaque ajout : le faire entrer couperait l'agent à un contact valide, pour rien.
    const m = monter({ initial: vingt });
    await expect(m.liste.ajouter(T, PN, 'US.13491208655302741918', PLACE)).rejects.toBeInstanceOf(ListePleine);
    expect(m.journal).toEqual([]);
  });

  it('⚠️ le retrait du sortant est refusé : l’ajout est tenté quand même, c’est Meta qui dit s’il reste de la place', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = monter({ initial: vingt, retrait: [new MetaApiError(403, { message: 'interdit' })] });
    expect(await m.liste.ajouter(T, PN, WA, PLACE)).toBe(true);
    expect(m.journal).toEqual([`meta:retrait:${PN}:entree-${vingt[0]}`, `meta:ajout:${PN}:+${WA}`, `ligne:pose:${WA}:e-neuve`]);
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
      reglages: { get: async () => ({ mbaEnabled: true, repondeurMode: 'mba', repondeurAgentId: null, repondeurWorkflowId: null, repondeurDelaiScenarioS: 86400, controlHandbackSeconds: null }) },
      repondeur: aucunRepondeur,
      delaiRepriseParDefautMs: DELAI_REPRISE_DEFAUT_MS,
      parcours: { findWaitingByWaId: async () => null },
      numeros: { getTenantPhoneNumberId: async () => PN , numeroBloque: numeroJamaisBloque },
      liste,
      consentement: { estDesabonne: jamaisDesabonne, estBloque: jamaisBloque },
      meta: { mbaClientForTenant: async () => client },
      offres: offresToutOuvert,
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
    // `lister` (lot 5) et `moinsActive` (la rotation, 2026-10-08) compris : chacune passe la même garde.
    expect(requetes).toHaveLength(6);
    for (const q of requetes) expect(q, q).toMatch(/tenant_id = \$1|values \(\$1/);
  });
});
