import { describe, it, expect } from 'vitest';
import { BUDGET_LECTURE_MS, FILTRE_ABONNES, lireClientsAbonnes } from '../src/shopify/clients';

/**
 * LA LECTURE DES CLIENTS ABONNÉS (plan 2026-10-21, lot 3). Aucun appel réseau : Shopify est simulé, page par page.
 *
 * 🔴 Ce qui se joue : Shopify ignore EN SILENCE un filtre de recherche qu'il ne connaît pas (mesuré le 2026-10-22). Si
 * l'abonnement n'était pas revérifié sur chaque client, un filtre ignoré ferait importer toute la boutique.
 */

const ACCES = { domaine: 'b.myshopify.com', jeton: 'jeton-de-test', pays: 'FR' };

type Client = Record<string, unknown>;
const client = (over: Client = {}): Client => ({
  firstName: 'Karine', lastName: 'Ruby',
  defaultPhoneNumber: { phoneNumber: '+33633921577', marketingState: 'NOT_SUBSCRIBED' },
  defaultEmailAddress: { marketingState: 'SUBSCRIBED' },
  defaultAddress: null,
  ...over,
});
const page = (nodes: Client[], suite: string | null = null, seau = { currentlyAvailable: 1990, restoreRate: 100 }) => ({
  data: { customers: { pageInfo: { hasNextPage: suite !== null, endCursor: suite }, nodes } },
  extensions: { cost: { requestedQueryCost: 35, throttleStatus: seau } },
});

/** Un faux Shopify qui rend les réponses dans l'ordre, et garde chaque corps envoyé. */
function shopify(reponses: Array<{ statut?: number; corps: unknown }>) {
  const envois: Array<{ url: string; corps: { query: string; variables: { q: string; apres: string | null } } }> = [];
  let i = 0;
  const appeler = (async (url: string, init: RequestInit) => {
    envois.push({ url, corps: JSON.parse(String(init.body)) });
    const r = reponses[Math.min(i, reponses.length - 1)]!;
    i += 1;
    return new Response(JSON.stringify(r.corps), { status: r.statut ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const attentes: number[] = [];
  const attendre = async (ms: number) => { attentes.push(ms); };
  return { appeler, attendre, envois, attentes };
}

describe('les clients abonnés d’une boutique', () => {
  it('🔴 un client NON abonné que Shopify rend quand même (filtre ignoré) n’est jamais retenu', async () => {
    const s = shopify([{ corps: page([
      client({ defaultEmailAddress: { marketingState: 'NOT_SUBSCRIBED' } }),
      client({ defaultEmailAddress: null, defaultPhoneNumber: { phoneNumber: '+33600000001', marketingState: 'UNSUBSCRIBED' } }),
    ]) }]);
    const r = await lireClientsAbonnes(ACCES, 1000, s.appeler, s.attendre);
    expect(r).toEqual({ ok: true, abonnes: [], sansTelephone: 0, complet: true });
  });

  it('abonné par e-mail OU par SMS ; le nom fait du prénom et du nom ; le filtre envoyé, du plus récent au plus ancien', async () => {
    const s = shopify([{ corps: page([
      client(),
      client({ firstName: 'Ayumu', lastName: 'Hirano', defaultEmailAddress: { marketingState: 'NOT_SUBSCRIBED' },
        defaultPhoneNumber: { phoneNumber: '+447911123456', marketingState: 'SUBSCRIBED' } }),
    ]) }]);
    const r = await lireClientsAbonnes(ACCES, 1000, s.appeler, s.attendre);
    expect(r).toEqual({ ok: true, sansTelephone: 0, complet: true, abonnes: [
      { telephone: '+33633921577', nom: 'Karine Ruby' }, { telephone: '+447911123456', nom: 'Ayumu Hirano' },
    ] });
    expect(s.envois[0]!.url).toBe('https://b.myshopify.com/admin/api/2026-10/graphql.json');
    expect(s.envois[0]!.corps.variables).toEqual({ q: FILTRE_ABONNES, apres: null });
    expect(s.envois[0]!.corps.query).toContain('sortKey: CREATED_AT, reverse: true');
  });

  it('🔴 seul le téléphone du CLIENT : celui de l’adresse (un destinataire, absent d’une demande d’effacement) est laissé', async () => {
    const s = shopify([{ corps: page([
      client({ defaultPhoneNumber: null, defaultAddress: { phone: '06 33 92 15 77', countryCodeV2: 'FR' } }),
      client({ firstName: 'Doublon', defaultPhoneNumber: { phoneNumber: '+33633921577', marketingState: 'SUBSCRIBED' } }),
      client({ firstName: 'Paul', defaultPhoneNumber: { phoneNumber: '06 12 34 56 78', marketingState: 'SUBSCRIBED' } }),
      client({ firstName: 'Re', lastName: 'Doublon', defaultPhoneNumber: { phoneNumber: '+33633921577', marketingState: 'SUBSCRIBED' } }),
    ]) }]);
    const r = await lireClientsAbonnes(ACCES, 1000, s.appeler, s.attendre);
    // Un numéro national se lit au pays de la boutique ; un numéro vu deux fois ne fait qu'une fiche.
    expect(r).toEqual({ ok: true, sansTelephone: 1, complet: true, abonnes: [
      { telephone: '+33633921577', nom: 'Doublon Ruby' }, { telephone: '+33612345678', nom: 'Paul Ruby' },
    ] });
  });

  it('au bout du budget de temps, la lecture s’arrête en le disant (le proxy coupe à 45 s) ; un frein trop long aussi', async () => {
    let maintenant = 0;
    const s = shopify([{ corps: page([client()], 'curseur-1') }, { corps: page([client()], 'curseur-2') }]);
    const lent = (async (url: string, init: RequestInit) => { maintenant += BUDGET_LECTURE_MS; return s.appeler(url, init); }) as unknown as typeof fetch;
    expect(await lireClientsAbonnes(ACCES, 1000, lent, s.attendre, () => maintenant)).toMatchObject({ ok: true, complet: false });
    expect(s.envois).toHaveLength(1);
    const freine = { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: { cost: { requestedQueryCost: 35, throttleStatus: { currentlyAvailable: 0, restoreRate: 1 } } } };
    const f = shopify([{ corps: freine }]);
    expect(await lireClientsAbonnes(ACCES, 1000, f.appeler, f.attendre, () => 0)).toMatchObject({ ok: false, code: 'passager' });
    expect(f.attentes).toEqual([]);
  });

  it('page après page par le curseur ; au plafond de clients lus, la lecture s’arrête et le dit', async () => {
    const s = shopify([
      { corps: page([client()], 'curseur-1') },
      { corps: page([client({ defaultPhoneNumber: { phoneNumber: '+33600000002', marketingState: 'NOT_SUBSCRIBED' } })], 'curseur-2') },
      { corps: page([client({ defaultPhoneNumber: { phoneNumber: '+33600000003', marketingState: 'NOT_SUBSCRIBED' } })]) },
    ]);
    const complet = await lireClientsAbonnes(ACCES, 1000, s.appeler, s.attendre);
    expect(complet).toMatchObject({ ok: true, complet: true });
    expect((complet as { abonnes: unknown[] }).abonnes).toHaveLength(3);
    expect(s.envois.map((e) => e.corps.variables.apres)).toEqual([null, 'curseur-1', 'curseur-2']);

    const t = shopify([{ corps: page([client()], 'curseur-1') }, { corps: page([client()], 'curseur-2') }]);
    expect(await lireClientsAbonnes(ACCES, 1, t.appeler, t.attendre)).toMatchObject({ ok: true, complet: false });
    expect(t.envois).toHaveLength(1);
  });

  it('Shopify freine (THROTTLED) : on attend la recharge du seau, puis on reprend la MÊME page', async () => {
    const freine = { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: { cost: { requestedQueryCost: 35, throttleStatus: { currentlyAvailable: 5, restoreRate: 100 } } } };
    const s = shopify([{ corps: freine }, { corps: page([client()]) }]);
    const r = await lireClientsAbonnes(ACCES, 1000, s.appeler, s.attendre);
    expect(r).toMatchObject({ ok: true, abonnes: [{ telephone: '+33633921577' }] });
    expect(s.attentes).toEqual([1000]);
    expect(s.envois.map((e) => e.corps.variables.apres)).toEqual([null, null]);
  });

  it('un accès refusé se dit tel quel (données client protégées) ; une panne est passagère', async () => {
    expect(await lireClientsAbonnes(ACCES, 1000, shopify([{ statut: 403, corps: {} }]).appeler, async () => undefined))
      .toMatchObject({ ok: false, code: 'acces_refuse' });
    const refuse = { errors: [{ message: 'Access denied for customers field.', extensions: { code: 'ACCESS_DENIED' } }] };
    expect(await lireClientsAbonnes(ACCES, 1000, shopify([{ corps: refuse }]).appeler, async () => undefined))
      .toMatchObject({ ok: false, code: 'acces_refuse' });
    expect(await lireClientsAbonnes(ACCES, 1000, shopify([{ statut: 502, corps: {} }]).appeler, async () => undefined))
      .toMatchObject({ ok: false, code: 'passager' });
    expect(await lireClientsAbonnes(ACCES, 1000, shopify([{ corps: { data: { pas: 'une page' } } }]).appeler, async () => undefined))
      .toMatchObject({ ok: false, code: 'passager' });
  });
});
