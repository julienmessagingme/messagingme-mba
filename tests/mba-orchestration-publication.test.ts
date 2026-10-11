import { describe, expect, it, vi } from 'vitest';
import type { VerrousCourts } from '../src/db/verrous-courts';
import type { Issue, Refus } from '../src/lib/issue';
import { ErreurPublication, type ContextePublication } from '../src/mba/appliquer-publication';
import {
  BAIL_PUBLICATION_MS, clePublication, creerPublicationMba,
} from '../src/mba/orchestration-publication';
import type { EtatMeta, Geste, OutilAPublier, RelaisAPublier } from '../src/mba/publication';
import { MetaApiError } from '../src/meta/errors';
import { verrousEnMemoire } from './verrous';

/**
 * L'orchestrateur tient la promesse « Messaging Me fait foi, la publication écrase » : il montre le plan, le
 * recalcule au clic, sérialise les écritures par espace et dit exactement où une publication partielle s'est arrêtée.
 */
const TENANT = 't1';
const PHONE_NUMBER_ID = '1234840649713976';
const RELAIS: RelaisAPublier = { baseUrl: 'https://api.messagingme.app/mba/relais', cleAJour: true };
const ADD_TAG: OutilAPublier = {
  id: 'o1', name: 'add_tag', description: 'Le client demande à rajouter une étiquette.', nePasUtiliser: '',
  variables: [{ nom: 'user', type: 'string', origine: { type: 'modele' }, requis: true }],
};
const REMOVE_TAG: OutilAPublier = {
  ...ADD_TAG, id: 'o2', name: 'remove_tag', description: 'Le client demande à retirer une étiquette.',
};
const META_VIDE: EtatMeta = { connecteurs: [], outilsParConnecteur: {} };

function exigerRefus409(resultat: Issue<unknown>): asserts resultat is Refus {
  expect(resultat).toMatchObject({ ok: false, statut: 409 });
  if (resultat.ok) throw new Error('résultat accepté au lieu d’un refus 409');
}

function monter(opts: {
  numero?: string | null;
  relais?: RelaisAPublier | null;
  outils?: () => OutilAPublier[];
  etatMeta?: () => EtatMeta;
  echoueSur?: Geste['type'];
  erreur?: Error;
  retenir?: Promise<void>;
  pendantGeste?: () => Promise<void>;
  verrous?: VerrousCourts;
} = {}) {
  const appliques: Geste[] = [];
  const entames: Geste[] = [];
  const contextes: ContextePublication[] = [];
  const appels = {
    numeros: [] as string[],
    relais: [] as string[],
    outils: [] as Array<{ tenantId: string; phoneNumberId: string }>,
    etatsMeta: [] as Array<{ tenantId: string; phoneNumberId: string }>,
    applications: [] as Array<{ tenantId: string; phoneNumberId: string; geste: Geste }>,
  };
  let prises = 0;
  const vraisVerrous = opts.verrous ?? verrousEnMemoire();
  const publication = creerPublicationMba({
    numeroWhatsapp: async (tenantId) => {
      appels.numeros.push(tenantId);
      return opts.numero === undefined ? PHONE_NUMBER_ID : opts.numero;
    },
    relais: async (tenantId) => {
      appels.relais.push(tenantId);
      return opts.relais === undefined ? RELAIS : opts.relais;
    },
    outilsExposes: async (tenantId, phoneNumberId) => {
      appels.outils.push({ tenantId, phoneNumberId });
      return opts.outils?.() ?? [ADD_TAG];
    },
    etatMeta: async (tenantId, phoneNumberId) => {
      appels.etatsMeta.push({ tenantId, phoneNumberId });
      return opts.etatMeta?.() ?? META_VIDE;
    },
    appliquer: async (tenantId, phoneNumberId, geste, contexte) => {
      appels.applications.push({ tenantId, phoneNumberId, geste });
      entames.push(geste);
      if (opts.retenir) await opts.retenir;
      if (opts.pendantGeste) await opts.pendantGeste();
      if (geste.type === opts.echoueSur) throw opts.erreur ?? new Error('panne');
      appliques.push(geste);
      contextes.push(contexte);
    },
    verrous: {
      prendre: (cles) => { prises += 1; return vraisVerrous.prendre(cles); },
      relacher: (prise) => vraisVerrous.relacher(prise),
      prolonger: (prise, duree) => vraisVerrous.prolonger(prise, duree),
    },
  });
  return { publication, appliques, entames, contextes, appels, prises: () => prises };
}

describe('l’aperçu et le plan appliqué', () => {
  it('montre le plan sans rien écrire', async () => {
    const f = monter();
    const resultat = await f.publication.apercevoir(TENANT);
    expect(resultat.ok).toBe(true);
    if (!resultat.ok) throw new Error(resultat.erreur);
    expect(resultat.valeur.gestes.map((g) => g.type)).toEqual(['connecteur_creer', 'outil_creer']);
    expect(resultat.valeur.phoneNumberId).toBe(PHONE_NUMBER_ID);
    expect(f.appliques).toEqual([]);
    expect(f.prises(), 'un aperçu ne prend aucun verrou en base').toBe(0);
  });

  it('sans numéro, l’aperçu est vide et publier refuse avant le verrou', async () => {
    const f = monter({ numero: null });
    const apercu = await f.publication.apercevoir(TENANT);
    expect(apercu).toEqual({ ok: true, valeur: { gestes: [], phoneNumberId: null } });
    const publication = await f.publication.publier(TENANT, 'u1');
    exigerRefus409(publication);
    expect(publication.erreur).toMatch(/Aucun numéro/);
    expect(f.prises(), 'sans numéro, publier refuse avant toute prise').toBe(0);
  });

  it('sans adresse publique, l’aperçu et la publication refusent sans lire les outils', async () => {
    let lecturesOutils = 0;
    const f = monter({ relais: null, outils: () => { lecturesOutils += 1; return [ADD_TAG]; } });
    for (const resultat of [
      await f.publication.apercevoir(TENANT),
      await f.publication.publier(TENANT, 'u1'),
      // La seconde tentative prouve que la première a relâché sa prise malgré le refus de planification.
      await f.publication.publier(TENANT, 'u1'),
    ]) {
      exigerRefus409(resultat);
      expect(resultat.erreur).toMatch(/adresse publique/);
    }
    expect(lecturesOutils).toBe(0);
  });

  it('recalcule le plan au clic au lieu d’appliquer celui de l’aperçu', async () => {
    let lecture = 0;
    const f = monter({ outils: () => (++lecture === 1 ? [ADD_TAG] : []) });
    const apercu = await f.publication.apercevoir(TENANT);
    expect(apercu.ok && apercu.valeur.gestes).toHaveLength(2);
    const resultat = await f.publication.publier(TENANT, 'u1');
    expect(resultat).toEqual({ ok: true, valeur: { faits: [] } });
    expect(f.appliques).toEqual([]);
  });

  it('applique les gestes dans l’ordre avec l’instantané des outils et l’administrateur', async () => {
    const f = monter();
    const resultat = await f.publication.publier(TENANT, 'u1');
    expect(resultat).toEqual({ ok: true, valeur: { faits: f.appliques } });
    expect(f.appliques.map((g) => g.type)).toEqual(['connecteur_creer', 'outil_creer']);
    expect(f.contextes).toHaveLength(2);
    expect(new Set(f.contextes).size).toBe(1);
    expect(f.contextes[0]).toMatchObject({ acteurId: 'u1', outils: [ADD_TAG] });
    expect(f.appels).toMatchObject({
      numeros: [TENANT],
      relais: [TENANT],
      outils: [{ tenantId: TENANT, phoneNumberId: PHONE_NUMBER_ID }],
      etatsMeta: [{ tenantId: TENANT, phoneNumberId: PHONE_NUMBER_ID }],
    });
    expect(f.appels.applications.map(({ tenantId, phoneNumberId }) => ({ tenantId, phoneNumberId })))
      .toEqual([
        { tenantId: TENANT, phoneNumberId: PHONE_NUMBER_ID },
        { tenantId: TENANT, phoneNumberId: PHONE_NUMBER_ID },
      ]);
  });

  it('s’arrête au premier échec et rend les gestes déjà faits', async () => {
    const f = monter({ outils: () => [ADD_TAG, REMOVE_TAG], echoueSur: 'outil_creer' });
    const apercu = await f.publication.apercevoir(TENANT);
    expect(apercu.ok && apercu.valeur.gestes).toHaveLength(3);
    const resultat = await f.publication.publier(TENANT, 'u1');
    exigerRefus409(resultat);
    expect(resultat.erreur).toMatch(/Relancez/);
    expect(resultat.details?.faits).toHaveLength(1);
    expect(f.appliques.map((g) => g.type)).toEqual(['connecteur_creer']);
    expect(f.entames).toEqual([
      { type: 'connecteur_creer', nom: 'EngageMe' },
      { type: 'outil_creer', outilId: ADD_TAG.id, nom: ADD_TAG.name },
    ]);
  });

  it('distingue un refus local, un refus Meta et une panne ambiguë', async () => {
    const local = await monter({
      echoueSur: 'connecteur_creer',
      erreur: new ErreurPublication('le connecteur EngageMe est introuvable chez Meta'),
    }).publication.publier(TENANT, 'u1');
    exigerRefus409(local);
    expect(local.erreur).toMatch(/introuvable chez Meta/);
    expect(local.erreur).not.toMatch(/Meta a refusé/);

    const meta = await monter({
      echoueSur: 'connecteur_creer',
      erreur: new MetaApiError(400, { message: 'Invalid connector request' }),
    }).publication.publier(TENANT, 'u1');
    exigerRefus409(meta);
    expect(meta.erreur).toMatch(/Meta a refusé/);

    const panne = await monter({
      echoueSur: 'connecteur_creer', erreur: new Error('connexion à la base perdue'),
    }).publication.publier(TENANT, 'u1');
    exigerRefus409(panne);
    expect(panne.erreur).toMatch(/n’a pas abouti/);
    expect(panne.erreur).not.toMatch(/Meta a refusé/);
  });
});

describe('une publication à la fois', () => {
  it('libère le verrou quand le calcul du plan échoue après la prise', async () => {
    const verrous = verrousEnMemoire();
    let premiereLecture = true;
    const f = monter({
      verrous,
      etatMeta: () => {
        if (premiereLecture) { premiereLecture = false; throw new Error('Meta injoignable'); }
        return META_VIDE;
      },
    });
    await expect(f.publication.publier(TENANT, 'u1')).rejects.toThrow('Meta injoignable');
    expect(verrous.tenues()).toEqual([]);
    expect((await f.publication.publier(TENANT, 'u1')).ok).toBe(true);
  });

  it('refuse une seconde publication du même espace puis libère le verrou', async () => {
    let liberer: () => void = () => {};
    const retenir = new Promise<void>((resolve) => { liberer = resolve; });
    const f = monter({ retenir });
    const premiere = f.publication.publier(TENANT, 'u1');
    await vi.waitFor(() => { expect(f.entames.length).toBeGreaterThan(0); });
    const seconde = await f.publication.publier(TENANT, 'u1');
    exigerRefus409(seconde);
    expect(seconde.erreur).toMatch(/déjà en cours/);
    liberer();
    expect((await premiere).ok).toBe(true);
    expect((await f.publication.publier(TENANT, 'u1')).ok).toBe(true);
  });

  it('laisse publier deux espaces en parallèle', async () => {
    let liberer: () => void = () => {};
    const retenir = new Promise<void>((resolve) => { liberer = resolve; });
    const f = monter({ retenir });
    const premiere = f.publication.publier(TENANT, 'u1');
    await vi.waitFor(() => { expect(f.entames.length).toBeGreaterThan(0); });
    const autre = f.publication.publier('t2', 'u2');
    await vi.waitFor(() => { expect(f.entames.length).toBe(2); });
    liberer();
    expect((await premiere).ok).toBe(true);
    expect((await autre).ok).toBe(true);
  });

  it('partage le verrou entre deux copies de l’API et le libère après un échec', async () => {
    const verrous = verrousEnMemoire();
    let liberer: () => void = () => {};
    const retenir = new Promise<void>((resolve) => { liberer = resolve; });
    const copieA = monter({ retenir, verrous });
    const copieB = monter({ verrous });
    const premiere = copieA.publication.publier(TENANT, 'u1');
    await vi.waitFor(() => { expect(copieA.entames.length).toBeGreaterThan(0); });
    const seconde = await copieB.publication.publier(TENANT, 'u1');
    exigerRefus409(seconde);
    expect(seconde.erreur).toMatch(/déjà en cours/);
    expect(copieB.appliques).toEqual([]);
    liberer();
    expect((await premiere).ok).toBe(true);
    await vi.waitFor(() => { expect(verrous.tenues()).toEqual([]); });

    const enEchec = monter({ echoueSur: 'outil_creer', verrous });
    const echec = await enEchec.publication.publier(TENANT, 'u1');
    exigerRefus409(echec);
    await vi.waitFor(() => { expect(verrous.tenues()).toEqual([]); });
    expect((await copieB.publication.publier(TENANT, 'u1')).ok).toBe(true);
  });

  it('une prise échue ne relâche pas celle qui l’a reprise et s’arrête avant le geste suivant', async () => {
    const horloge = { t: 0 };
    const partages = verrousEnMemoire(() => horloge.t);
    const relaches: string[] = [];
    const verrous: VerrousCourts & { tenues(): string[] } = {
      prendre: (cles) => partages.prendre(cles),
      relacher: async (prise) => { await partages.relacher(prise); relaches.push(prise.jeton); },
      prolonger: (prise, duree) => partages.prolonger(prise, duree),
      tenues: () => partages.tenues(),
    };
    let liberer: () => void = () => {};
    const retenir = new Promise<void>((resolve) => { liberer = resolve; });
    const lente = monter({ retenir, verrous });
    const premiere = lente.publication.publier(TENANT, 'u1');
    await vi.waitFor(() => { expect(lente.entames.length).toBeGreaterThan(0); });
    horloge.t = BAIL_PUBLICATION_MS;
    const reprise = await verrous.prendre([[clePublication(TENANT), BAIL_PUBLICATION_MS]]);
    expect(reprise).not.toBeNull();
    liberer();
    const resultat = await premiere;
    exigerRefus409(resultat);
    expect(resultat.erreur).toMatch(/perdu son verrou/);
    expect(lente.entames.map((g) => g.type)).toEqual(['connecteur_creer']);
    expect(resultat.details?.faits).toHaveLength(1);
    await vi.waitFor(() => { expect(relaches).toHaveLength(1); });
    expect(verrous.tenues()).toEqual([clePublication(TENANT)]);
  });

  it('prolonge le même bail avant chaque geste', async () => {
    const horloge = { t: 0 };
    const reels = verrousEnMemoire(() => horloge.t);
    const prolongations: string[] = [];
    const verrous: VerrousCourts = {
      prendre: (cles) => reels.prendre(cles),
      relacher: (prise) => reels.relacher(prise),
      prolonger: async (prise, duree) => {
        prolongations.push(prise.jeton);
        return reels.prolonger(prise, duree);
      },
    };
    const tentativesAutreCopie: boolean[] = [];
    const lente = monter({
      verrous,
      pendantGeste: async () => {
        horloge.t += BAIL_PUBLICATION_MS * 0.9;
        tentativesAutreCopie.push((await reels.prendre([[clePublication(TENANT), BAIL_PUBLICATION_MS]])) !== null);
      },
    });
    expect((await lente.publication.publier(TENANT, 'u1')).ok).toBe(true);
    expect(tentativesAutreCopie).toEqual([false, false]);
    expect(prolongations).toHaveLength(2);
    expect(new Set(prolongations).size).toBe(1);
  });

  it('s’arrête avant le geste quand le verrou devient illisible', async () => {
    const reels = verrousEnMemoire();
    const verrous: VerrousCourts = {
      prendre: (cles) => reels.prendre(cles),
      relacher: (prise) => reels.relacher(prise),
      prolonger: async () => { throw new Error('connexion perdue'); },
    };
    const f = monter({ verrous });
    const resultat = await f.publication.publier(TENANT, 'u1');
    exigerRefus409(resultat);
    expect(resultat.erreur).toMatch(/perdu son verrou/);
    expect(f.entames).toEqual([]);
    await vi.waitFor(() => { expect(reels.tenues()).toEqual([]); });
  });

  it('garde un bail d’au moins cinq minutes', () => {
    expect(BAIL_PUBLICATION_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
