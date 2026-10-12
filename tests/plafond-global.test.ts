import { describe, it, expect } from 'vitest';
import type { FastifyReply } from 'fastify';
import { PlafondEspace, SANS_REGLAGE } from '../src/auth/plafond-espace';
import { PlafondGlobal, FENETRE_GLOBALE_MS, CLE_GLOBALE, CLE_REFUS_GLOBAL } from '../src/auth/plafond-global';
import { CompteurDebitMemoire } from '../src/db/debit.memoire';
import { memoireDesPleines, type CompteurDebit } from '../src/db/debit';
import type { Offre } from '../src/offres/offres';
import { capturerJournal } from './journal';

/**
 * 🔴 LE PLAFOND GLOBAL DE `/v1` ET `/mcp` (lot 14, A) : un compteur pour TOUTE la plateforme, Free d'abord.
 *
 * Un seul compteur par fenêtre de 10 s, mais deux plafonds : un espace Free (offre Base) est refusé dès que le compteur
 * atteint la part Free, un espace payant (Pro, Entreprise) seulement au plafond. Il se compte dans la MÊME instruction
 * que les deux fenêtres de l'espace, toutes ou aucune : un refus de l'espace ne consomme pas la plateforme, un refus
 * de la plateforme ne consomme pas l'espace, et la mémoire des fenêtres pleines épargne la base aux deux. Les refus se
 * comptent à part, par sorte, pour la veille de charge. Éteint à 0, comme les autres plafonds du dépôt.
 */

function fauxReply() {
  const state: { statusCode: number | null; body: unknown; headers: Record<string, string> } = { statusCode: null, body: undefined, headers: {} };
  const reply = {
    code(c: number) { state.statusCode = c; return reply; },
    header(k: string, v: string) { state.headers[k.toLowerCase()] = v; return reply; },
    async send(b: unknown) { state.body = b; return reply; },
  };
  return { reply: reply as unknown as FastifyReply, state };
}

const OFFRES: Record<string, Offre> = { free1: 'base', free2: 'base', pro1: 'pro', ent1: 'entreprise' };
const parOffre = { offreDe: async (t: string) => ({ offre: OFFRES[t] ?? 'entreprise' }) };

function monter(o: {
  parFenetre: number;
  partFree?: number;
  minute?: number;
  compteur?: (now: () => number) => CompteurDebit;
  offres?: { offreDe(t: string): Promise<{ offre: Offre }> };
}) {
  let t = 1_000_000;
  const now = () => t;
  const compteur = o.compteur ? o.compteur(now) : new CompteurDebitMemoire(now);
  const global = new PlafondGlobal({ parFenetre: o.parFenetre, partFreePct: o.partFree ?? 50 }, o.offres ?? parOffre, compteur);
  const espace = new PlafondEspace({ minute: o.minute ?? 1000, heure: 100_000 }, { reglage: async () => SANS_REGLAGE }, compteur, global);
  return { espace, global, compteur, avancer: (ms: number) => { t += ms; } };
}

async function appel(p: PlafondEspace, tenant: string) {
  const { reply, state } = fauxReply();
  const ok = await p.consommer(tenant, reply);
  return { ok, ...state };
}

const UNE_HEURE = 3_600_000;

describe('🔴 le plafond global, Free d’abord', () => {
  it('éteint à 0 : tout passe, rien n’est compté sous la clé de la plateforme', async () => {
    const { espace, compteur } = monter({ parFenetre: 0 });
    for (let i = 0; i < 50; i++) expect((await appel(espace, 'free1')).ok).toBe(true);
    expect(await compteur.lister(CLE_GLOBALE, UNE_HEURE)).toEqual([]);
  });

  it('un payant passe jusqu’au plafond, puis 429 rate_limited, une phrase sur la plateforme, l’attente jusqu’à la fin de la fenêtre', async () => {
    const { espace, avancer } = monter({ parFenetre: 4 });
    for (let i = 0; i < 4; i++) expect((await appel(espace, i % 2 ? 'pro1' : 'ent1')).ok).toBe(true);
    avancer(3_000);
    const refus = await appel(espace, 'ent1');
    expect(refus.ok).toBe(false);
    expect(refus.statusCode).toBe(429);
    expect(refus.body).toEqual({ error: 'trop de requêtes : la plateforme est saturée, réessayez dans quelques secondes', code: 'rate_limited' });
    expect(refus.headers['retry-after']).toBe(String(FENETRE_GLOBALE_MS / 1000 - 3));
  });

  it('🔴 un Free est refusé dès la part Free ; un payant passe encore jusqu’au plafond, sur le MÊME compteur', async () => {
    const { espace } = monter({ parFenetre: 10, partFree: 50 });
    for (let i = 0; i < 5; i++) expect((await appel(espace, i % 2 ? 'free1' : 'free2')).ok, `free ${i}`).toBe(true);
    expect((await appel(espace, 'free1')).statusCode).toBe(429);
    expect((await appel(espace, 'free2')).statusCode, 'la part est celle de TOUS les Free').toBe(429);
    for (let i = 0; i < 5; i++) expect((await appel(espace, 'pro1')).ok, `payant ${i}`).toBe(true);
    expect((await appel(espace, 'pro1')).statusCode).toBe(429);
  });

  it('🔴 deux copies de l’API partagent le compteur de la plateforme', async () => {
    let t = 1_000_000;
    const base = new CompteurDebitMemoire(() => t);
    const copie = () => new PlafondEspace({ minute: 1000, heure: 100_000 }, { reglage: async () => SANS_REGLAGE }, base,
      new PlafondGlobal({ parFenetre: 3, partFreePct: 50 }, parOffre, base));
    const a = copie();
    const b = copie();
    expect((await appel(a, 'pro1')).ok).toBe(true);
    expect((await appel(b, 'ent1')).ok).toBe(true);
    expect((await appel(a, 'pro1')).ok).toBe(true);
    expect((await appel(b, 'pro1')).statusCode).toBe(429);
    t += FENETRE_GLOBALE_MS;
    expect((await appel(b, 'pro1')).ok, 'la fenêtre suivante rouvre').toBe(true);
  });

  it('🔴 avec la mémoire des fenêtres pleines : un refus Free ne fait pas refuser un payant, et les refus suivants n’écrivent rien', async () => {
    let ecritures = 0;
    const { espace } = monter({
      parFenetre: 10,
      partFree: 50,
      compteur: (now) => {
        const base = new CompteurDebitMemoire(now);
        // Seuls les appels qui portent la clé de la plateforme : les refus agrégés s'écrivent à part, en différé.
        const comptee: CompteurDebit = {
          compter: (c) => { if (c.some((x) => x.cle === CLE_GLOBALE)) ecritures += 1; return base.compter(c); },
          lister: (p, d) => base.lister(p, d),
        };
        return memoireDesPleines(comptee, now);
      },
    });
    for (let i = 0; i < 5; i++) await appel(espace, 'free1');
    expect((await appel(espace, 'free1')).ok).toBe(false);
    const avant = ecritures;
    for (let i = 0; i < 20; i++) expect((await appel(espace, 'free1')).ok).toBe(false);
    expect(ecritures, 'la boucle d’un intégrateur Free ne touche plus la base').toBe(avant);
    expect((await appel(espace, 'pro1')).ok).toBe(true);
  });

  it('🔴 toutes ou aucune : un refus de la plateforme ne consomme pas la minute de l’espace, ni l’inverse', async () => {
    const { espace, compteur, avancer } = monter({ parFenetre: 2, minute: 3 });
    expect((await appel(espace, 'pro1')).ok).toBe(true);
    expect((await appel(espace, 'pro1')).ok).toBe(true);
    for (let i = 0; i < 5; i++) expect((await appel(espace, 'pro1')).statusCode).toBe(429);
    avancer(FENETRE_GLOBALE_MS);
    expect((await appel(espace, 'pro1')).ok, 'la troisième place de la minute est toujours là').toBe(true);
    const refusEspace = await appel(espace, 'pro1');
    expect(String((refusEspace.body as { error: string }).error)).toMatch(/plafond de l’espace/);
    const global = (await compteur.lister(CLE_GLOBALE, UNE_HEURE)).filter((l) => !l.cle.startsWith(CLE_REFUS_GLOBAL));
    expect(global[0]?.n, 'le refus de l’espace n’a pas compté pour la plateforme').toBe(1);
  });

  it('les refus se comptent par sorte (free, payant), une écriture groupée, pour la veille de charge', async () => {
    const { espace, global, compteur } = monter({ parFenetre: 2, partFree: 50 });
    await appel(espace, 'free1');
    await appel(espace, 'free1');
    await appel(espace, 'free1');
    await appel(espace, 'pro1');
    await appel(espace, 'pro1');
    await appel(espace, 'ent1');
    await global.vider();
    const lignes = await compteur.lister(CLE_REFUS_GLOBAL, UNE_HEURE);
    const parSorte = Object.fromEntries(lignes.map((l) => [l.cle, l.n]));
    expect(parSorte).toEqual({ [`${CLE_REFUS_GLOBAL}free`]: 2, [`${CLE_REFUS_GLOBAL}payant`]: 2 });
    await global.vider();
    expect(await compteur.lister(CLE_REFUS_GLOBAL, UNE_HEURE), 'vider deux fois ne compte pas deux fois').toEqual(lignes);
  });

  it('la base muette laisse passer', async () => {
    const { espace } = monter({ parFenetre: 1, compteur: () => ({ compter: async () => { throw new Error('base indisponible'); }, lister: async () => [] }) });
    const { resultat } = await capturerJournal(async () => [await appel(espace, 'pro1'), await appel(espace, 'pro1')]);
    for (const r of resultat) expect(r.ok).toBe(true);
  });

  it('une offre illisible compte comme payante : l’offre range la file, elle ne garde rien', async () => {
    const { espace } = monter({ parFenetre: 4, partFree: 25, offres: { offreDe: async () => { throw new Error('offre illisible'); } } });
    const { resultat } = await capturerJournal(async () => [await appel(espace, 'x'), await appel(espace, 'x'), await appel(espace, 'x')]);
    expect(resultat.map((r) => r.ok)).toEqual([true, true, true]);
  });

  it('une part Free à 0 refuse tout Free quand le plafond est allumé ; à 100, Free et payant sont égaux', async () => {
    const zero = monter({ parFenetre: 10, partFree: 0 }).espace;
    expect((await appel(zero, 'free1')).statusCode).toBe(429);
    expect((await appel(zero, 'pro1')).ok).toBe(true);
    const cent = monter({ parFenetre: 2, partFree: 100 }).espace;
    expect((await appel(cent, 'free1')).ok).toBe(true);
    expect((await appel(cent, 'free1')).ok).toBe(true);
    expect((await appel(cent, 'free1')).statusCode).toBe(429);
  });

  it('🔴 la clé de la plateforme se trie APRÈS celles de l’espace : la ligne chaude se verrouille en dernier', () => {
    // `PgCompteurDebit` écrit `order by cle` : la ligne que TOUS les appels se disputent est tenue le moins longtemps
    // possible si elle vient en dernier. Vrai dans l'ordre binaire (collation C) comme dans l'ordre linguistique.
    const espace = ['api.minute|ffffffff-ffff-4fff-bfff-ffffffffffff', 'api.heure|ffffffff-ffff-4fff-bfff-ffffffffffff'];
    for (const e of espace) {
      expect(CLE_GLOBALE > e, `binaire : ${e}`).toBe(true);
      expect(CLE_GLOBALE.localeCompare(e, 'en-US') > 0, `linguistique : ${e}`).toBe(true);
    }
  });

  it('les deux fenêtres de l’espace éteintes, la plateforme compte encore, sans en-têtes x-ratelimit', async () => {
    const base = new CompteurDebitMemoire(() => 1_000_000);
    const p = new PlafondEspace({ minute: 0, heure: 0 }, { reglage: async () => SANS_REGLAGE }, base,
      new PlafondGlobal({ parFenetre: 1, partFreePct: 50 }, parOffre, base));
    const ok = await appel(p, 'pro1');
    expect(ok.ok).toBe(true);
    expect(Object.keys(ok.headers)).toEqual([]);
    expect((await appel(p, 'pro1')).statusCode).toBe(429);
  });
});
