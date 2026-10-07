import { describe, it, expect } from 'vitest';
import {
  ETAPES, nomCorrespond, prevoirEtapes, supprimerEspace,
  type BilanSuppression, type ContexteTiers, type DepsSuppression, type EtapeJouee, type NomEtape,
} from '../src/ops/suppression-espace';

/**
 * SUPPRIMER UN ESPACE (RC8) : l'ordre des étapes, ce qui arrête tout, ce qui est sauté et pourquoi. Aucune base, aucun
 * tiers : les gestes sont des doubles qui notent leur appel. La purge réelle, ses clés fragiles et l'isolation :
 * `tests/integration/suppression-espace.integration.test.ts`, en CI. La route : `tests/ops-suppression.test.ts`.
 */
const T = '7a1c0f3e-2b4d-4e5f-8a9b-0c1d2e3f4a5b';

function bilan(over: Partial<BilanSuppression> = {}, meta: Partial<BilanSuppression['meta']> = {}): BilanSuppression {
  return {
    tenantId: T, nom: 'Essai Dupont', creeLe: '2026-10-01T00:00:00.000Z', statut: 'trial',
    comptes: { utilisateurs: 1, contacts: 3, conversations: 2, scenarios: 1 },
    soldeMicroEur: 0,
    stripe: { clients: [], abonnements: [] },
    numeroFourni: { numero: '33100000000', vuDeMeta: true },
    meta: { phoneNumberId: 'pn-1', wabaId: 'waba-1', partage: false, mbaAllume: true, contactsSurLaListe: 2, ...meta },
    salesforce: true,
    cleVercel: true,
    adresses: { effacees: ['a@exemple.test'], gardees: [] },
    ...over,
  };
}

function contexte(over: Partial<ContexteTiers> = {}): ContexteTiers {
  return {
    meta: { jeton: 'propre', wabaId: 'waba-1' },
    hubspot: true,
    configures: { vercel: true, salesforce: true, hubspot: true },
    ...over,
  };
}

/** Des gestes qui notent l'ordre de leurs appels ; `echecs` fait lever ceux qu'on nomme. */
function gestes(o: { echecs?: NomEtape[]; verrou?: boolean; vercel?: 'null' | boolean } = {}) {
  const appels: string[] = [];
  const traces: EtapeJouee[][] = [];
  const leve = (e: NomEtape) => { if (o.echecs?.includes(e)) throw new Error(`panne ${e}`); };
  const d: DepsSuppression = {
    verrouiller: async () => { appels.push('verrou'); leve('verrou'); return o.verrou ?? true; },
    revoquerCleVercel: o.vercel === 'null' ? null : async () => { appels.push('cle_vercel'); leve('cle_vercel'); return o.vercel !== false; },
    eteindreMba: async () => { appels.push('mba_eteint'); leve('mba_eteint'); },
    viderListeMba: async () => { appels.push('mba_liste'); leve('mba_liste'); return { retires: 2, refuses: 0 }; },
    desabonnerWaba: async () => { appels.push('waba_desabonne'); leve('waba_desabonne'); },
    deconnecterSalesforce: async () => { appels.push('salesforce'); leve('salesforce'); return 'efface'; },
    deconnecterHubspot: async () => { appels.push('hubspot'); leve('hubspot'); },
    sortirNumeroFourni: async () => { appels.push('numero_fourni'); leve('numero_fourni'); return { fait: 'resilie', numero: '33100000000' }; },
    purger: async (_t, trace) => {
      appels.push('purge');
      traces.push(trace.etapes);
      leve('purge');
      return { fait: true, comptes: { utilisateurs: 1, contacts: 3, conversations: 2, messages: 9, scenarios: 1, identitesEffacees: 1, identitesGardees: 0 } };
    },
  };
  return { d, appels, traces };
}

const etat = (etapes: EtapeJouee[], e: NomEtape) => etapes.find((x) => x.etape === e)?.etat;

describe('nomCorrespond', () => {
  it('🔴 le nom exact, sans les espaces en tête et en fin ; la casse compte, et un nom vide ne passe jamais', () => {
    expect(nomCorrespond('  Essai Dupont ', 'Essai Dupont')).toBe(true);
    expect(nomCorrespond('essai dupont', 'Essai Dupont')).toBe(false);
    expect(nomCorrespond('Essai', 'Essai Dupont')).toBe(false);
    expect(nomCorrespond('', '')).toBe(false);
    expect(nomCorrespond(undefined, 'Essai Dupont')).toBe(false);
    expect(nomCorrespond(42, 'Essai Dupont')).toBe(false);
  });
});

describe('supprimerEspace : l’ordre et les arrêts', () => {
  it('🔴 les étapes se jouent dans l’ordre annoncé, et la purge reçoit le déroulé des étapes d’avant', async () => {
    const { d, appels, traces } = gestes();
    const r = await supprimerEspace(d, bilan(), contexte(), 'exploitant@exemple.test');
    expect(appels).toEqual([...ETAPES]);
    expect(r.supprime).toBe(true);
    expect(r.etapes.map((e) => e.etape)).toEqual([...ETAPES]);
    expect(r.etapes.every((e) => e.etat === 'fait')).toBe(true);
    // La trace de la purge porte tout ce qui l'a précédée, et rien d'elle-même.
    expect(traces[0]!.map((e) => e.etape)).toEqual(ETAPES.filter((e) => e !== 'purge'));
    expect(r.comptes).toMatchObject({ messages: 9 });
  });

  it('🔴 Vercel échoue : ARRÊT, rien n’est touché chez Meta ni ailleurs, et rien n’est purgé', async () => {
    // Une clé dont la ligne partirait avec la cascade facturerait à vie, identifiant perdu.
    const { d, appels } = gestes({ echecs: ['cle_vercel'] });
    const r = await supprimerEspace(d, bilan(), contexte(), 'x');
    expect(appels).toEqual(['verrou', 'cle_vercel']);
    expect(r.supprime).toBe(false);
    expect(r.comptes).toBeNull();
    expect(r.etapes).toEqual([
      { etape: 'verrou', etat: 'fait', detail: null },
      { etape: 'cle_vercel', etat: 'echec', detail: 'panne cle_vercel' },
    ]);
  });

  it('🔴 une clé existe et Vercel n’est pas configuré sur cette instance : arrêt, sans même appeler', async () => {
    const { d, appels } = gestes({ vercel: 'null' });
    const r = await supprimerEspace(d, bilan(), contexte({ configures: { vercel: false, salesforce: true, hubspot: true } }), 'x');
    expect(appels).toEqual(['verrou']);
    expect(r.supprime).toBe(false);
    expect(etat(r.etapes, 'cle_vercel')).toBe('echec');
  });

  it('🔴 le verrou échoue (ou l’espace a disparu) : arrêt avant toute révocation', async () => {
    for (const g of [gestes({ echecs: ['verrou'] }), gestes({ verrou: false })]) {
      const r = await supprimerEspace(g.d, bilan(), contexte(), 'x');
      expect(g.appels).toEqual(['verrou']);
      expect(r.supprime).toBe(false);
    }
  });

  it('🔴 un échec chez Meta, Salesforce, HubSpot ou DIDWW est NOTÉ et n’arrête pas : la purge est faite', async () => {
    const { d, appels } = gestes({ echecs: ['mba_eteint', 'waba_desabonne', 'salesforce', 'hubspot', 'numero_fourni'] });
    const r = await supprimerEspace(d, bilan(), contexte(), 'x');
    expect(appels).toEqual([...ETAPES]);
    expect(r.supprime).toBe(true);
    for (const e of ['mba_eteint', 'waba_desabonne', 'salesforce', 'hubspot', 'numero_fourni'] as const) expect(etat(r.etapes, e)).toBe('echec');
    expect(etat(r.etapes, 'purge')).toBe('fait');
  });

  it('un espace sans clé : l’étape est sautée, et la suite se joue', async () => {
    const { d, appels } = gestes({ vercel: false });
    const r = await supprimerEspace(d, bilan({ cleVercel: false }), contexte(), 'x');
    expect(appels).not.toContain('cle_vercel');
    expect(r.etapes.find((e) => e.etape === 'cle_vercel')).toEqual({ etape: 'cle_vercel', etat: 'sautee', detail: 'aucune clé' });
    expect(r.supprime).toBe(true);
  });

  it('🔴 une clé rouverte depuis la révocation : la purge refuse, rien n’est supprimé', async () => {
    const g = gestes();
    g.d.purger = async () => ({ fait: false, raison: 'cle_rouverte' });
    const r = await supprimerEspace(g.d, bilan(), contexte(), 'x');
    expect(r.supprime).toBe(false);
    expect(r.etapes.at(-1)).toMatchObject({ etape: 'purge', etat: 'echec' });
  });

  it('un numéro bloqué faute de DIDWW est un échec à lire (à résilier à la main) ; la liste refusée par Meta aussi', async () => {
    const g = gestes();
    g.d.sortirNumeroFourni = async () => ({ fait: 'bloque', numero: '33100000000', cause: 'DIDWW non configuré' });
    g.d.viderListeMba = async () => ({ retires: 1, refuses: 1 });
    const r = await supprimerEspace(g.d, bilan(), contexte(), 'x');
    expect(r.etapes.find((e) => e.etape === 'numero_fourni')).toMatchObject({ etat: 'echec', detail: expect.stringContaining('DIDWW non configuré') });
    expect(r.etapes.find((e) => e.etape === 'mba_liste')).toMatchObject({ etat: 'echec', detail: '1 retiré(s), 1 refusé(s) par Meta' });
    expect(r.supprime).toBe(true);
  });

  it('les liens Stripe sont rendus avec la réponse, même quand la suppression s’arrête', async () => {
    const stripe = { clients: [{ customerId: 'cus_1', livemode: true, lien: 'https://dashboard.stripe.com/customers/cus_1' }], abonnements: [] };
    const { d } = gestes({ echecs: ['cle_vercel'] });
    expect((await supprimerEspace(d, bilan({ stripe }), contexte(), 'x')).stripe).toEqual(stripe);
  });
});

describe('🔴 les gardes Meta : un objet partagé, ou notre jeton global, ne se touchent pas', () => {
  const META: NomEtape[] = ['mba_eteint', 'mba_liste', 'waba_desabonne'];

  it('compte WhatsApp ou numéro PARTAGÉ avec un autre espace : les trois étapes sont sautées, jamais jouées', async () => {
    const { d, appels } = gestes();
    const b = bilan({}, { partage: true });
    expect(prevoirEtapes(b, contexte()).filter((p) => META.includes(p.etape)).map((p) => [p.etat, p.detail]))
      .toEqual(META.map(() => ['sautee', 'sautée : compte WhatsApp ou numéro partagé avec un autre espace']));
    const r = await supprimerEspace(d, b, contexte(), 'x');
    for (const e of META) {
      expect(appels).not.toContain(e);
      expect(etat(r.etapes, e)).toBe('sautee');
    }
    expect(r.supprime).toBe(true);
  });

  it('jeton GLOBAL (l’espace n’a pas de jeton propre) : sautées ; jeton invalide : sautées aussi', async () => {
    for (const jeton of ['global', 'invalide'] as const) {
      const { d, appels } = gestes();
      const c = contexte({ meta: { jeton, wabaId: null } });
      const prevues = prevoirEtapes(bilan(), c).filter((p) => META.includes(p.etape));
      expect(prevues.every((p) => p.etat === 'sautee' && p.detail!.includes(jeton === 'global' ? 'jeton global' : 'invalide'))).toBe(true);
      await supprimerEspace(d, bilan(), c, 'x');
      for (const e of META) expect(appels).not.toContain(e);
    }
  });

  it('rien à faire se dit avant la garde : aucun numéro, agent éteint, liste vide, aucun compte', () => {
    const b = bilan({}, { phoneNumberId: null, wabaId: null, mbaAllume: false, contactsSurLaListe: 0, partage: true });
    const p = prevoirEtapes(b, contexte({ meta: { jeton: 'global', wabaId: null } }));
    expect(p.filter((x) => META.includes(x.etape)).map((x) => x.detail)).toEqual(['aucun numéro', 'liste vide', 'aucun compte WhatsApp']);
  });
});

describe('prevoirEtapes : ce que le bilan annonce', () => {
  it('HubSpot relié sans connecteur configuré : impossible, à délier à la main (et la purge se fait quand même)', async () => {
    const { d, appels } = gestes();
    const c = contexte({ configures: { vercel: true, salesforce: true, hubspot: false } });
    expect(prevoirEtapes(bilan(), c).find((p) => p.etape === 'hubspot')).toMatchObject({ etat: 'impossible' });
    const r = await supprimerEspace(d, bilan(), c, 'x');
    expect(appels).not.toContain('hubspot');
    expect(etat(r.etapes, 'hubspot')).toBe('echec');
    expect(r.supprime).toBe(true);
  });

  it('Salesforce relié sans l’app sur cette instance : la ligne seule est oubliée, et le déroulé le dit', async () => {
    const g = gestes();
    g.d.deconnecterSalesforce = async () => 'oublie';
    const c = contexte({ configures: { vercel: true, salesforce: false, hubspot: true } });
    expect(prevoirEtapes(bilan(), c).find((p) => p.etape === 'salesforce')).toMatchObject({ etat: 'a_faire', detail: expect.stringContaining('ligne seule') });
    const r = await supprimerEspace(g.d, bilan(), c, 'x');
    expect(r.etapes.find((e) => e.etape === 'salesforce')).toMatchObject({ etat: 'fait', detail: expect.stringContaining('secret non effacé') });
  });

  it('les étapes sans objet : non relié, aucun numéro fourni', () => {
    const p = prevoirEtapes(bilan({ salesforce: false, numeroFourni: null }), contexte({ hubspot: false }));
    expect(p.find((x) => x.etape === 'salesforce')).toEqual({ etape: 'salesforce', etat: 'sautee', detail: 'non relié' });
    expect(p.find((x) => x.etape === 'hubspot')).toEqual({ etape: 'hubspot', etat: 'sautee', detail: 'non relié' });
    expect(p.find((x) => x.etape === 'numero_fourni')).toEqual({ etape: 'numero_fourni', etat: 'sautee', detail: 'aucun' });
  });

  it('chaque étape est prévue une fois, dans l’ordre', () => {
    expect(prevoirEtapes(bilan(), contexte()).map((p) => p.etape)).toEqual([...ETAPES]);
  });
});
