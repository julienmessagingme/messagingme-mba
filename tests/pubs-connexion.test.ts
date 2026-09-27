import { describe, it, expect, vi, afterEach } from 'vitest';
import { creerConnexionPub, type ClientConnexionPub, type DepotConnexionPub } from '../src/pubs/connexion';
import { encryptSecret, decryptSecret } from '../src/crypto/secretbox';
import { ErreurGraph } from '../src/meta/graph';
import { DejaConnectePub, JetonNonEnregistre, PasDeConnexionPub } from '../src/http/pubs';
import type { ActifsAccordes } from '../src/meta/pubs';

/**
 * LA CONNEXION PUBLICITAIRE, EXÉCUTÉE (lot 2 de `docs/superpowers/plans/2026-09-27-approfondir-la-racine.md`).
 *
 * 🔴 CES CAS REMPLACENT SIX GARDES QUI LISAIENT LA SOURCE D'`index.ts` (`tests/pubs-cablage.test.ts`) : l'ordre
 * du dépôt par `/ops`, les arguments passés à `retirerAncienAcces`, le déchiffrement du jeton relu, le refus
 * avant l'échange, la révocation avant l'effacement. Un test de source ne savait constater qu'un ordre de
 * lignes, et deux relectures à froid l'avaient pris en défaut sur la sémantique. Le code vit désormais dans
 * `src/pubs/connexion.ts` : on l'exécute contre un faux client Meta et un faux dépôt qui RETIENNENT l'ordre de ce
 * qu'on leur fait, et on lit ce qui part, en clair ou chiffré.
 * L'inventaire des points d'écriture du jeton reste, lui, dans `tests/pubs-cablage.test.ts` : un troisième
 * point ajouté demain ne passerait par aucun de ces cas.
 */

const CLE = 'c'.repeat(64);
const ACTIFS: ActifsAccordes = {
  comptesPub: [{ id: '111', nom: 'Compte', devise: 'EUR', fuseau: 'Europe/Paris', statut: 1 }],
  pages: [{ id: 'p1', nom: 'Page' }],
};

/** Qui porte chaque jeton chez Meta ; un jeton absent de la table ne répond pas (un cryptogramme, par exemple). */
const ENTITES: Record<string, string> = { ANCIEN: 'entite-a', NEUF: 'entite-b', NEUF_MEME_ENTITE: 'entite-a' };

function monter(o: { chiffreEnBase?: string | null; client?: Partial<ClientConnexionPub>; depot?: Partial<DepotConnexionPub>; cle?: string } = {}) {
  const journal: string[] = [];
  let chiffre = o.chiffreEnBase === undefined ? null : o.chiffreEnBase;
  const client: ClientConnexionPub = {
    exchangeCode: async (code) => { journal.push(`meta.exchangeCode(${code})`); return 'NEUF'; },
    actifsAccordes: async (jeton) => { journal.push(`meta.actifsAccordes(${jeton})`); return ACTIFS; },
    etatCompte: async (compte, jeton) => {
      journal.push(`meta.etatCompte(${compte},${jeton})`);
      return { statut: 1, raisonDesactivation: 0, moyenPaiement: true };
    },
    identite: async (jeton) => { journal.push(`meta.identite(${jeton})`); return ENTITES[jeton] ?? null; },
    revoquerAcces: async (jeton) => { journal.push(`meta.revoquerAcces(${jeton})`); },
    ...o.client,
  };
  const ecrits: string[] = [];
  const depot: DepotConnexionPub = {
    lire: async () => (chiffre === null ? null : {
      comptePubId: '111', compteNom: 'Compte', pageId: 'p1', pageNom: 'Page', devise: 'EUR', fuseau: 'Europe/Paris',
      pageLiee: 'inconnu', connectePar: null, connecteLe: new Date(0), jetonRejeteLe: null,
    }),
    lireJetonChiffre: async () => { journal.push('base.lireJetonChiffre'); return chiffre; },
    poserJeton: async (_t, c) => {
      journal.push('base.poserJeton');
      if (chiffre !== null) return false;
      chiffre = c; ecrits.push(c); return true;
    },
    choisirActifs: async () => { journal.push('base.choisirActifs'); },
    remplacer: async (_t, c) => { journal.push('base.remplacer'); chiffre = c; ecrits.push(c); },
    marquerJetonRejete: async () => { journal.push('base.marquerJetonRejete'); },
    supprimer: async () => { journal.push('base.supprimer'); chiffre = null; },
    ...o.depot,
  };
  const gestes = creerConnexionPub({ client, connexions: depot, cleChiffrement: o.cle ?? CLE });
  return { gestes, journal, ecrits };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('le jeton ne touche jamais la base en clair, et ne part jamais chiffré chez Meta', () => {
  it('🔴 la connexion range un CHIFFRÉ du jeton échangé, jamais le jeton nu', async () => {
    const { gestes, ecrits } = monter();
    await gestes.connecter('t1', 'code-1', 'u1');
    expect(ecrits).toHaveLength(1);
    expect(ecrits[0]).not.toContain('NEUF');
    expect(decryptSecret(ecrits[0]!, CLE)).toBe('NEUF');
  });

  it('🔴 le jeton relu est DÉCHIFFRÉ avant de partir chez Meta', async () => {
    // Sans le déchiffrement, Meta répondrait 401 et la connexion se marquerait « refusée » toute seule.
    const { gestes, journal } = monter({ chiffreEnBase: encryptSecret('ANCIEN', CLE) });
    await gestes.actifsAccordes('t1');
    expect(journal).toContain('meta.actifsAccordes(ANCIEN)');
    expect(await gestes.jetonClair('t1')).toBe('ANCIEN');
  });

  it('un espace sans connexion lève une erreur NOMMÉE, que la route rend en 409', async () => {
    const { gestes } = monter();
    await expect(gestes.jetonClair('t1')).rejects.toBeInstanceOf(PasDeConnexionPub);
  });
});

describe('connecter', () => {
  it('🔴 REFUSE avant d échanger le code quand une connexion existe déjà', async () => {
    // Sans cette bretelle, chaque appel hors séquence fait émettre par Meta un jeton SANS EXPIRATION que la
    // base refusera ensuite : un orphelin à chaque fois.
    const { gestes, journal } = monter({ chiffreEnBase: encryptSecret('ANCIEN', CLE) });
    const err = await gestes.connecter('t1', 'code-1', 'u1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DejaConnectePub);
    expect((err as DejaConnectePub).jetonOrphelin).toBe(false);
    expect(journal.some((l) => l.startsWith('meta.exchangeCode'))).toBe(false);
  });

  it('la course perdue en base est dite : le jeton émis par Meta est orphelin, et n est PAS révoqué', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { gestes, journal } = monter({ depot: { poserJeton: async () => false } });
    const err = await gestes.connecter('t1', 'code-1', 'u1').catch((e: unknown) => e);
    expect((err as DejaConnectePub).jetonOrphelin).toBe(true);
    expect(journal.some((l) => l.startsWith('meta.revoquerAcces'))).toBe(false);
  });

  it('notre panne après l échange porte son nom, pas celui d un refus de Meta', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { gestes } = monter({ depot: { poserJeton: async () => { throw new Error('base indisponible'); } } });
    await expect(gestes.connecter('t1', 'code-1', 'u1')).rejects.toBeInstanceOf(JetonNonEnregistre);
  });
});

describe('déconnecter', () => {
  it('🔴 RÉVOQUE chez Meta AVANT d effacer la ligne, avec le jeton en clair', async () => {
    // Notre ligne est le seul endroit où ce jeton existe chez nous, et il n'expire jamais.
    const { gestes, journal } = monter({ chiffreEnBase: encryptSecret('ANCIEN', CLE) });
    expect(await gestes.deconnecter('t1')).toEqual({ revoqueChezMeta: true });
    expect(journal.filter((l) => l.startsWith('meta.revoquerAcces') || l === 'base.supprimer'))
      .toEqual(['meta.revoquerAcces(ANCIEN)', 'base.supprimer']);
  });

  it('un refus de Meta n empêche pas de partir, et le dit au journal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { gestes, journal } = monter({
      chiffreEnBase: encryptSecret('ANCIEN', CLE),
      client: { revoquerAcces: async () => { throw new Error('refus'); } },
    });
    expect(await gestes.deconnecter('t1')).toEqual({ revoqueChezMeta: false });
    expect(journal).toContain('base.supprimer');
  });
});

describe('le dépôt par /ops', () => {
  it('🔴 CHIFFRE avant de toucher à quoi que ce soit : une clé fautive ne détruit rien', async () => {
    // `encryptSecret` lève sur une clé absente ou mal formée. Chiffrer APRÈS avoir lu ou révoqué l'ancien
    // laisserait l'espace sans connexion, sur une route qui répond « jeton refusé ».
    const { gestes, journal } = monter({ chiffreEnBase: encryptSecret('ANCIEN', CLE), cle: 'pas-une-cle' });
    await expect(gestes.deposerJeton('t1', 'NEUF', 'act_111', 'p1')).rejects.toThrow(/ENCRYPTION_KEY/);
    expect(journal).toEqual(['meta.actifsAccordes(NEUF)']);
  });

  it('🔴 l ancien jeton, DÉCHIFFRÉ, est retiré s il porte une autre entité, AVANT le remplacement', async () => {
    const { gestes, journal, ecrits } = monter({ chiffreEnBase: encryptSecret('ANCIEN', CLE) });
    const r = await gestes.deposerJeton('t1', 'NEUF', 'act_111', 'p1');
    expect(r.ancienRevoque).toBe('retire');
    expect(r).toMatchObject({ comptePubId: '111', pageId: 'p1', devise: 'EUR', pageLiee: 'inconnu' });
    // L'ordre qui compte : la décision sur l'ancien se joue tant qu'on l'a encore.
    const i = journal.indexOf('meta.revoquerAcces(ANCIEN)');
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(journal.indexOf('base.remplacer'));
    expect(journal).not.toContain('meta.revoquerAcces(NEUF)');
    expect(decryptSecret(ecrits[0]!, CLE)).toBe('NEUF');
  });

  it('🔴 même entité : on ne retire RIEN, sinon on tuerait le neuf', async () => {
    // Les trois régressions qu'une relecture à froid avait mesurées sur le câblage passeraient toutes par ici :
    // `(client, jeton, jeton)` compare le neuf à lui-même, `(client, null, jeton)` ne lit jamais l'ancien, le
    // CHIFFRÉ passé sans déchiffrer rend `indetermine`. Chacune fait tomber le cas « autre entité » ci-dessus.
    const { gestes, journal } = monter({ chiffreEnBase: encryptSecret('ANCIEN', CLE) });
    const r = await gestes.deposerJeton('t1', 'NEUF_MEME_ENTITE', '111', 'p1');
    expect(r.ancienRevoque).toBe('meme_entite');
    expect(journal.some((l) => l.startsWith('meta.revoquerAcces'))).toBe(false);
  });

  it('sans connexion préalable : aucun, et un compte non accordé est refusé avant tout', async () => {
    const { gestes } = monter();
    expect((await gestes.deposerJeton('t1', 'NEUF', '111', 'p1')).ancienRevoque).toBe('aucun');
    const autre = monter();
    await expect(autre.gestes.deposerJeton('t1', 'NEUF', '999', 'p1')).rejects.toThrow(/compte publicitaire 999/);
    expect(autre.journal).toEqual(['meta.actifsAccordes(NEUF)']);
  });
});

describe('un jeton refusé se retient, une panne non', () => {
  it('🔴 un refus du jeton par Meta marque la connexion, et l erreur remonte', async () => {
    const { gestes, journal } = monter({
      chiffreEnBase: encryptSecret('ANCIEN', CLE),
      client: { actifsAccordes: async () => { throw new ErreurGraph(401, 190, 'jeton expiré'); } },
    });
    await expect(gestes.actifsAccordes('t1')).rejects.toBeInstanceOf(ErreurGraph);
    expect(journal).toContain('base.marquerJetonRejete');
  });

  it('une panne de Meta ne marque rien', async () => {
    const { gestes, journal } = monter({
      chiffreEnBase: encryptSecret('ANCIEN', CLE),
      client: { actifsAccordes: async () => { throw new ErreurGraph(500, null, 'panne'); } },
    });
    await expect(gestes.choisir('t1', { comptePubId: '111', pageId: 'p1' })).rejects.toBeInstanceOf(ErreurGraph);
    expect(journal).not.toContain('base.marquerJetonRejete');
  });

  it('l état du compte ne marque jamais la connexion, et il est mis en cache par espace et par compte', async () => {
    let lectures = 0;
    const { gestes, journal } = monter({
      chiffreEnBase: encryptSecret('ANCIEN', CLE),
      client: { etatCompte: async () => { lectures += 1; throw new ErreurGraph(401, 190, 'jeton expiré'); } },
    });
    await expect(gestes.etatCompte('t1')).rejects.toBeInstanceOf(ErreurGraph);
    expect(journal).not.toContain('base.marquerJetonRejete');

    const sain = monter({ chiffreEnBase: encryptSecret('ANCIEN', CLE) });
    await sain.gestes.etatCompte('t1');
    await sain.gestes.etatCompte('t1');
    // Un autre espace sur le même compte publicitaire ne lit pas l'état mis en cache pour le premier.
    await sain.gestes.etatCompte('t2');
    expect(sain.journal.filter((l) => l.startsWith('meta.etatCompte'))).toEqual(['meta.etatCompte(111,ANCIEN)', 'meta.etatCompte(111,ANCIEN)']);
    expect(lectures).toBe(1);
  });
});
