import { describe, it, expect } from 'vitest';
import { creerResolveurHttp } from '../src/agent/resolvers/http';
import type { EntreeResolveur } from '../src/agent/executor';
import type { OutilDefini } from '../src/agent/catalog';
import type { SourceAppel } from '../src/agent/sources';

/**
 * Le résolveur des outils de CONNECTEUR (lot L2).
 *
 * 🔴 CE QU'IL NE DOIT JAMAIS FAIRE, et c'est ce que ces tests gardent : laisser un secret repartir vers le
 * modèle. `contenu` et `erreur` sont les deux champs que le tronc commun repasse au modèle, donc au
 * fournisseur. Un 401 doit dire « le système du client a refusé l'authentification », jamais l'en-tête envoyé.
 *
 * 🔴 ET IL NE LÈVE PAS sur un cas métier : une source inactive, un 500 du client ou un gabarit cassé rendent
 * `ok: false` avec une raison lisible, que le modèle peut dire au contact. Lever ferait une
 * `erreur_protocole`, qui arrête le tour, alors que le client peut corriger son outil dans la console.
 */
const SOURCE: SourceAppel = {
  id: 'src1', baseUrl: 'https://api.client.fr/v1',
  authKind: 'bearer', authHeaderName: null, authSecret: 'JETON-SECRET-42', status: 'active',
};

const OUTIL: OutilDefini = {
  id: 'to1', tenantId: 't1', agentId: 'ag1', origin: 'http', sourceId: 'src1',
  name: 'lire_commande', description: 'lit une commande', params: [],
  binding: { methode: 'GET', chemin: '/commandes/{ref}' },
  outputPaths: ['statut', 'livraison.date'],
  risk: 'read', timeoutMs: 5_000, maxBytes: 16_384, autonome: false,
};

const CTX = {
  tenantId: 't1', agentId: 'ag1', sessionId: 's1', runId: 'r1', workflowId: 'wf1', waId: '33600',
  contact: null, contactInconnu: 'tous' as const, appelsRestants: 5, budgetRestantMicroEur: 10_000,
  deadline: Date.now() + 30_000,
};

function harnais(over: {
  source?: SourceAppel | null;
  reponse?: { status: number; body: string; contentType?: string };
  outil?: OutilDefini;
  lance?: Error;
} = {}) {
  const appels: Array<{ url: string; init: RequestInit }> = [];
  const epreuves: Array<{ ok: boolean; erreur?: string }> = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    appels.push({ url: String(url), init: (init ?? {}) as RequestInit });
    if (over.lance) throw over.lance;
    const r = over.reponse ?? { status: 200, body: JSON.stringify({ statut: 'expédiée', livraison: { date: '2026-09-02', transporteur: 'X' }, client: { email: 'a@b.c' } }) };
    return new Response(r.body, { status: r.status, headers: { 'content-type': r.contentType ?? 'application/json' } });
  }) as unknown as typeof fetch;

  const resolveur = creerResolveurHttp({
    sources: {
      pourAppel: async () => (over.source === undefined ? SOURCE : over.source),
      marquerEpreuve: async (_t, _i, ok, erreur) => { epreuves.push({ ok, ...(erreur ? { erreur } : {}) }); },
    },
    fetchImpl,
  });

  const entree: EntreeResolveur = {
    outil: over.outil ?? OUTIL,
    args: { ref: 'CMD-1' },
    ctx: CTX,
    signal: AbortSignal.timeout(10_000),
  };
  return { resolveur, entree, appels, epreuves };
}

describe('résolveur http : le chemin nominal', () => {
  it('appelle la cible construite, avec l’authentification, et ne rend QUE les champs listés', async () => {
    const { resolveur, entree, appels } = harnais();
    const r = await resolveur(entree);
    expect(appels[0]!.url).toBe('https://api.client.fr/v1/commandes/CMD-1');
    expect((appels[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer JETON-SECRET-42');
    expect(r.ok).not.toBe(false);
    // 🔴 `outputPaths` est un FILTRE DE SORTIE : la réponse appartient au client et part chez le fournisseur
    // de modèle. `client.email` n'a pas été demandé, il ne doit pas traverser.
    expect(r.contenu).toEqual({ statut: 'expédiée', 'livraison.date': '2026-09-02' });
    expect(JSON.stringify(r.contenu)).not.toContain('a@b.c');
  });

  it('l’authentification par en-tête nommé passe par ce nom, et « none » n’envoie rien', async () => {
    const parEntete = harnais({ source: { ...SOURCE, authKind: 'header', authHeaderName: 'x-api-key', authSecret: 'K1' } });
    await parEntete.resolveur(parEntete.entree);
    const h = parEntete.appels[0]!.init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('K1');
    expect(h.authorization).toBeUndefined();

    const sans = harnais({ source: { ...SOURCE, authKind: 'none', authSecret: null } });
    await sans.resolveur(sans.entree);
    const h2 = sans.appels[0]!.init.headers as Record<string, string>;
    expect(h2.authorization).toBeUndefined();
  });

  it('une réussite est notée sur la source (c’est ce qui rend un connecteur mort visible)', async () => {
    const { resolveur, entree, epreuves } = harnais();
    await resolveur(entree);
    expect(epreuves).toEqual([{ ok: true }]);
  });
});

describe('résolveur http : ce qui ne doit JAMAIS fuiter', () => {
  it('🔴 le secret n’apparaît NI dans `contenu` NI dans `erreur`, sur les trois modes', async () => {
    // `contenu` et `erreur` repartent au MODÈLE, donc chez le fournisseur. C'est le test le plus important
    // de ce fichier : un message d'erreur bavard suffirait à publier le jeton d'API d'un client.
    for (const source of [
      SOURCE,
      { ...SOURCE, authKind: 'header' as const, authHeaderName: 'x-api-key', authSecret: 'JETON-SECRET-42' },
      { ...SOURCE, authKind: 'none' as const, authSecret: null },
    ]) {
      for (const reponse of [
        { status: 401, body: 'unauthorized: token JETON-SECRET-42 expired' },
        { status: 500, body: 'boom JETON-SECRET-42' },
        { status: 200, body: 'pas du json JETON-SECRET-42' },
      ]) {
        const { resolveur, entree } = harnais({ source, reponse });
        const r = await resolveur(entree);
        const tout = JSON.stringify({ contenu: r.contenu, erreur: r.erreur });
        expect(tout, `${source.authKind} / ${reponse.status}`).not.toContain('JETON-SECRET-42');
      }
    }
  });

  it('🔴 le CORPS de la réponse du client ne repart pas brut en cas d’erreur', async () => {
    // Le corps d'une 500 contient très souvent une trace, donc des chemins internes et parfois des
    // identifiants. Le modèle n'a pas besoin de ça pour dire au contact que le système ne répond pas.
    const { resolveur, entree } = harnais({ reponse: { status: 500, body: 'at /srv/app/db.js:42 password=hunter2' } });
    const r = await resolveur(entree);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });
});

describe('résolveur http : les refus, tous sans lever', () => {
  it('source introuvable, inactive, ou d’un autre tenant', async () => {
    for (const source of [null, { ...SOURCE, status: 'draft' as const }, { ...SOURCE, status: 'disabled' as const }]) {
      const { resolveur, entree, appels } = harnais({ source });
      const r = await resolveur(entree);
      expect(r.ok).toBe(false);
      expect(appels).toHaveLength(0); // et surtout : AUCUN appel réseau
    }
  });

  it('gabarit illisible ou cible refusée', async () => {
    for (const binding of [
      {}, { methode: 'GET' }, { methode: 'CONNECT', chemin: '/x' },
      { methode: 'GET', chemin: 'https://evil.test/x' },
    ]) {
      const { resolveur, entree, appels } = harnais({ outil: { ...OUTIL, binding } });
      const r = await resolveur(entree);
      expect(r.ok, JSON.stringify(binding)).toBe(false);
      expect(appels).toHaveLength(0);
    }
  });

  it('une source à l’adresse INTERNE est refusée, même si elle est active', async () => {
    // Le conteneur voit l'admin NPM et les autres services. La garde est dans `http-cible`, on vérifie ici
    // qu'elle est bien appelée AVANT le réseau.
    const { resolveur, entree, appels } = harnais({ source: { ...SOURCE, baseUrl: 'http://172.18.0.1:8120/kb' } });
    expect((await resolveur(entree)).ok).toBe(false);
    expect(appels).toHaveLength(0);
  });

  it('un 404 du client est un échec MÉTIER : le modèle peut le dire au contact', async () => {
    const { resolveur, entree, epreuves } = harnais({ reponse: { status: 404, body: '{"erreur":"inconnue"}' } });
    const r = await resolveur(entree);
    expect(r.ok).toBe(false);
    expect(r.httpStatus).toBe(404);
    // Un 404 est une réponse, pas une panne : la source reste réputée saine.
    expect(epreuves[0]!.ok).toBe(true);
  });

  it('une panne réseau est notée sur la source, et ne lève pas', async () => {
    const { resolveur, entree, epreuves } = harnais({ lance: new Error('ECONNREFUSED') });
    const r = await resolveur(entree);
    expect(r.ok).toBe(false);
    expect(epreuves[0]!.ok).toBe(false);
  });

  it('🔴 une réponse trop GROSSE est coupée, elle ne remplit pas le contexte du modèle', async () => {
    const gros = JSON.stringify({ statut: 'x'.repeat(50_000) });
    const { resolveur, entree } = harnais({ reponse: { status: 200, body: gros }, outil: { ...OUTIL, maxBytes: 1_000 } });
    const r = await resolveur(entree);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.contenu ?? '').length).toBeLessThan(2_000);
  });

  it('🔴 une REDIRECTION est refusée, jamais suivie', async () => {
    // Le scraper de connaissance suit les redirections en revalidant chaque saut, parce qu'une page publique
    // en a légitimement. Une API de connecteur qui redirige est une anomalie : la suivre rouvrirait la porte
    // que `http-cible` vient de fermer.
    const { resolveur, entree } = harnais({ reponse: { status: 302, body: '' } });
    const r = await resolveur(entree);
    expect(r.ok).toBe(false);
    expect(String(r.erreur)).toMatch(/redirig/i);
  });

  it('sans `outputPaths`, rien ne part : le filtre est la règle, pas l’exception', async () => {
    // La décision D-L2-2 : la réponse appartient au client. Un outil sans filtre est une déclaration
    // incomplète, refusée à l'écriture ; s'il en existait un, il ne doit RIEN divulguer.
    const { resolveur, entree } = harnais({ outil: { ...OUTIL, outputPaths: [] } });
    const r = await resolveur(entree);
    expect(r.ok).toBe(false);
  });
});
