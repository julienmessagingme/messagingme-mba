import { describe, it, expect } from 'vitest';
import {
  ESSAIS_PREUVE, REESSAI_PREUVE_MS, lireParcours, traiterPreuveUtm, type DepsPreuveUtm, type JobPreuve,
} from '../src/shopify/preuve-utm';
import type { Touche } from '../src/shopify/attribution';
import type { VenteAEnregistrer } from '../src/shopify/ventes.pg';
import type { AccesBoutique } from '../src/shopify/store.pg';

/**
 * LA PREUVE PAR UTM, RELUE APRÈS COUP (plan 2026-10-28, tâche 6b). Mesuré sur la commande #1003 de la boutique de dev :
 * le webhook ne porte pas le parcours client, Shopify le calcule en un quart d'heure, et sa dernière visite porte nos UTM.
 */
const T = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';
const JOB: JobPreuve = {
  tenantId: T, commandeId: '6800936566843', contactId: 'fiche-1', montant: '39.95', devise: 'USD',
  payeeLe: '2026-10-28T19:58:19.000Z', test: true, essai: 0,
};
const ACCES: AccesBoutique = { domaine: 'b.myshopify.com', clientId: 'cid', secret: 's', pays: 'FR', etat: 'connectee', origine: 'console' };
const TOUCHE: Touche = { source: 'campagne', le: new Date('2026-10-20T10:00:00Z'), campaignId: 'k-soldes', modele: 'soldes_hiver', lanceScenario: false };

/** Le faux store des ventes : une classe dont les méthodes lisent `this` (règle du store injecté). */
class FauxVentes {
  appliquees: VenteAEnregistrer[] = [];
  modelesLus: string[] = [];
  constructor(private readonly o: { touche?: Touche | null; issue?: 'appliquee' | 'ignoree' } = {}) {}
  async derniereToucheDuModele(_t: string, _c: string, modele: string): Promise<Touche | null> {
    this.modelesLus.push(modele);
    return this.o.touche === undefined ? TOUCHE : this.o.touche;
  }
  async appliquerPreuveUtm(_t: string, v: VenteAEnregistrer): Promise<'appliquee' | 'ignoree'> {
    this.appliquees.push(v);
    return this.o.issue ?? 'appliquee';
  }
}

type Parcours = Awaited<ReturnType<typeof lireParcours>>;
function monter(o: { acces?: AccesBoutique | null; jeton?: 'ok' | 'passager' | 'identifiants'; parcours?: Parcours; ventes?: FauxVentes } = {}) {
  const programmes: Array<{ job: JobPreuve; quand: Date }> = [];
  const ventes = o.ventes ?? new FauxVentes();
  const deps: DepsPreuveUtm = {
    store: { acces: async () => (o.acces === undefined ? ACCES : o.acces) },
    ventes,
    filiere: async () => 'api',
    programmer: async (job, quand) => { programmes.push({ job, quand }); },
    jeton: async () => (o.jeton === undefined || o.jeton === 'ok'
      ? { ok: true, jeton: 'shpat' }
      : { ok: false, code: o.jeton, message: 'refus' }),
    lire: async () => o.parcours ?? { ok: true, pret: true, modele: 'soldes_hiver' },
    maintenant: () => Date.parse('2026-10-28T20:30:00Z'),
  };
  return { deps, programmes, ventes };
}

describe('la relecture de la preuve par UTM', () => {
  it('🔴 un parcours prêt avec nos UTM prouve la vente, à la dernière touche du modèle nommé', async () => {
    const { deps, ventes } = monter();
    expect(await traiterPreuveUtm(deps, JOB)).toBe('prouvee');
    expect(ventes.modelesLus).toEqual(['soldes_hiver']);
    expect(ventes.appliquees).toEqual([{
      commandeId: '6800936566843', contactId: 'fiche-1', montant: '39.95', devise: 'USD', payeeLe: new Date('2026-10-28T19:58:19.000Z'),
      test: true, source: 'campagne', campaignId: 'k-soldes', preuve: 'utm', relanceLe: null,
    }]);
  });

  it('un parcours pas encore prêt se relit plus tard, quatre fois au plus', async () => {
    const { deps, programmes } = monter({ parcours: { ok: true, pret: false } });
    expect(await traiterPreuveUtm(deps, JOB)).toBe('reessai');
    expect(programmes).toEqual([{ job: { ...JOB, essai: 1 }, quand: new Date(Date.parse('2026-10-28T20:30:00Z') + REESSAI_PREUVE_MS) }]);
    const dernier = monter({ parcours: { ok: true, pret: false } });
    expect(await traiterPreuveUtm(dernier.deps, { ...JOB, essai: ESSAIS_PREUVE - 1 })).toBe('abandon');
    expect(dernier.programmes).toEqual([]);
  });

  it('une lecture en panne ou un jeton passager se relisent aussi plus tard', async () => {
    expect(await traiterPreuveUtm(monter({ parcours: { ok: false } }).deps, JOB)).toBe('reessai');
    expect(await traiterPreuveUtm(monter({ jeton: 'passager' }).deps, JOB)).toBe('reessai');
  });

  it('des UTM étrangers ou absents : sans preuve, rien n’est écrit', async () => {
    const { deps, ventes } = monter({ parcours: { ok: true, pret: true, modele: null } });
    expect(await traiterPreuveUtm(deps, JOB)).toBe('sans_preuve');
    expect(ventes.appliquees).toEqual([]);
  });

  it('un modèle qu’aucune touche de la fiche n’a envoyé : sans preuve', async () => {
    const { deps, ventes } = monter({ ventes: new FauxVentes({ touche: null }) });
    expect(await traiterPreuveUtm(deps, JOB)).toBe('sans_preuve');
    expect(ventes.appliquees).toEqual([]);
  });

  it('une boutique coupée, absente, ou un jeton refusé pour de bon : abandon, sans réessai', async () => {
    for (const o of [{ acces: null }, { acces: { ...ACCES, etat: 'coupee' as const } }, { jeton: 'identifiants' as const }]) {
      const { deps, programmes } = monter(o);
      expect(await traiterPreuveUtm(deps, JOB)).toBe('abandon');
      expect(programmes).toEqual([]);
    }
  });

  it('une vente déjà prouvée par son panier, ou une fiche effacée : ignorée', async () => {
    const { deps } = monter({ ventes: new FauxVentes({ issue: 'ignoree' }) });
    expect(await traiterPreuveUtm(deps, JOB)).toBe('ignoree');
  });

  it('un job illisible : abandon, sans lever', async () => {
    for (const j of [null, {}, { ...JOB, montant: '12,00' }, { ...JOB, payeeLe: 'hier' }]) {
      expect(await traiterPreuveUtm(monter().deps, j)).toBe('abandon');
    }
  });
});

describe('la lecture du parcours client chez Shopify', () => {
  const repondre = (statut: number, corps: unknown) => async (url: string | URL | Request, init?: RequestInit) => {
    appels.push({ url: String(url), corps: JSON.parse(String(init?.body ?? '{}')) as { variables?: { id?: string } } });
    return new Response(typeof corps === 'string' ? corps : JSON.stringify(corps), { status: statut });
  };
  let appels: Array<{ url: string; corps: { variables?: { id?: string } } }> = [];
  const acces = { domaine: 'b.myshopify.com', jeton: 'shpat' };
  const parcours = (ready: boolean, utm: unknown) => ({ data: { order: { customerJourneySummary: { ready, lastVisit: utm === undefined ? null : { utmParameters: utm } } } } });

  it('la requête vise la commande par son gid, et nos UTM donnent le modèle', async () => {
    appels = [];
    const r = await lireParcours(acces, '6800936566843', repondre(200, parcours(true, { source: 'whatsapp', medium: 'messagingme', campaign: 'essai_utm' })));
    expect(r).toEqual({ ok: true, pret: true, modele: 'essai_utm' });
    expect(appels[0]!.url).toBe('https://b.myshopify.com/admin/api/2026-10/graphql.json');
    expect(appels[0]!.corps.variables?.id).toBe('gid://shopify/Order/6800936566843');
  });

  it('pas prêt ; prêt sans dernière visite ou sans nos UTM ; commande introuvable', async () => {
    expect(await lireParcours(acces, '1', repondre(200, parcours(false, undefined)))).toEqual({ ok: true, pret: false });
    expect(await lireParcours(acces, '1', repondre(200, parcours(true, undefined)))).toEqual({ ok: true, pret: true, modele: null });
    expect(await lireParcours(acces, '1', repondre(200, parcours(true, { source: 'google', medium: 'cpc', campaign: 'x' })))).toEqual({ ok: true, pret: true, modele: null });
    expect(await lireParcours(acces, '1', repondre(200, { data: { order: null } }))).toEqual({ ok: true, pret: true, modele: null });
  });

  it('un 401, une erreur GraphQL, un corps illisible ou une panne : ok false, sans lever', async () => {
    expect(await lireParcours(acces, '1', repondre(401, {}))).toEqual({ ok: false });
    expect(await lireParcours(acces, '1', repondre(200, { errors: [{ message: 'Throttled' }] }))).toEqual({ ok: false });
    expect(await lireParcours(acces, '1', repondre(200, 'pas du json'))).toEqual({ ok: false });
    expect(await lireParcours(acces, '1', async () => { throw new Error('réseau'); })).toEqual({ ok: false });
  });
});
