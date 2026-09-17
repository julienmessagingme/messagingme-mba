import { describe, it, expect } from 'vitest';
import { creerResolveurHttp } from '../src/agent/resolvers/http';
import type { EntreeResolveur } from '../src/agent/executor';
import type { OutilDefini } from '../src/agent/catalog';
import type { SourceAppel } from '../src/agent/sources';
import type { RequeteConnecteur } from '../src/agent/requetes';
import { SANS_MCP } from './outils-mcp';

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
  id: 'src1', kind: 'http', baseUrl: 'https://api.client.fr/v1',
  authKind: 'bearer', authHeaderName: null, authSecret: 'JETON-SECRET-42', status: 'active',
};

const OUTIL: OutilDefini = { ...SANS_MCP,
  id: 'to1', tenantId: 't1', origin: 'http', sourceId: 'src1', requestId: 'rq1', nePasUtiliser: '',
  name: 'lire_commande', description: 'lit une commande', params: [],
  binding: {},
  /**
   * 🔴 L'OUTIL PORTE SES CHAMPS DEPUIS LA MIGRATION 0150, et cette fixture les avait à VIDE parce que c'est
   * la requête qui les portait. Le résolveur lit désormais l'outil : les laisser vides ferait refuser chaque
   * appel de ce fichier, ce qui est exactement ce que le compilateur ne pouvait pas dire.
   *
   * ⚠️ Volontairement IDENTIQUES à ceux de la requête ci-dessous, pour que les tests existants continuent
   * d'exercer ce qu'ils exerçaient. Le cas où les deux DIVERGENT, lui, est le sujet d'un fichier à part
   * (`tests/agent-resolveur-http-nature.test.ts`), parce que c'est là que le changement se voit.
   */
  nature: 'integre' as const, outputPaths: ['statut', 'livraison.date'],
  risk: 'read', timeoutMs: 5_000, maxBytes: 16_384, autonome: false,
};

/**
 * L'appel vit desormais dans la REQUETE (migration 0105), plus dans le binding de l'outil : c'est elle qui
 * porte la methode, le chemin, le corps et les variables. L'outil ne fait que la designer.
 */
const REQUETE: RequeteConnecteur = {
  id: 'rq1', tenantId: 't1', sourceId: 'src1', label: 'Lire une commande',
  methode: 'GET', chemin: '/commandes/{ref}',
  parametres: [], entetes: [], corps: { mode: 'aucun' },
  variables: [{ nom: 'ref', type: 'string', origine: { type: 'modele' }, requis: true }],
  outputPaths: ['statut', 'livraison.date'],
  valeursTest: {}, outils: 1, updatedAt: '2026-09-02T00:00:00.000Z',
};

const CTX = {
  tenantId: 't1', agentId: 'ag1', sessionId: 's1', runId: 'r1', workflowId: 'wf1', waId: '33600',
  contact: null as Record<string, unknown> | null,
  contactInconnu: 'tous' as const, appelsRestants: 5, budgetRestantMicroEur: 10_000,
  deadline: Date.now() + 30_000,
};

function harnais(over: {
  source?: SourceAppel | null;
  reponse?: { status: number; body: string | ReadableStream<Uint8Array>; contentType?: string };
  outil?: OutilDefini;
  requete?: RequeteConnecteur | null;
  ctx?: Partial<typeof CTX>;
  derniereSaisie?: string | null;
  lance?: Error;
  /** Verdict de la garde de résolution. Absent = « publique », le cas nominal. */
  resolution?: (url: string) => Promise<{ ok: boolean; raison?: string }>;
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
    requetes: { parId: async () => (over.requete === undefined ? REQUETE : over.requete) },
    derniereSaisie: async () => over.derniereSaisie ?? null,
    fuseau: async () => 'Europe/Paris',
    // Horloge figee : la valeur systeme « maintenant » doit etre reproductible.
    now: () => new Date('2026-09-02T09:45:00.000Z'),
    fetchImpl,
    // La garde de RÉSOLUTION est injectée, comme `fetch` : sans ça, chaque test partirait interroger le DNS
    // pour un domaine de test qui n'existe pas, et la garde refuserait tout. Elle a ses tests dédiés plus bas
    // et dans `tests/lib-adresse-privee.test.ts` ; ici on veut éprouver le reste du chemin.
    verifierResolution: over.resolution ?? (async () => ({ ok: true })),
  });

  const entree: EntreeResolveur = {
    outil: over.outil ?? OUTIL,
    args: { ref: 'CMD-1' },
    ctx: { ...CTX, ...over.ctx },
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

/**
 * UNE CONNEXION QUI LÂCHE N'EST PAS UN JSON INVALIDE (2026-09-04).
 *
 * ⚠️ Ce bloc a d'abord porté une justification FAUSSE, et elle mérite d'être racontée plutôt qu'effacée. Elle
 * affirmait que le modèle recevait un faux succès sur ce chemin. C'est vrai du bouton « Test », pas d'ici :
 * un corps vide fait lever `JSON.parse('')`, donc l'étape 9 attrapait déjà le cas et rendait `ok: false`.
 *
 * Ce qui était réellement cassé, c'est que ce même `catch` marque la source comme SAINE. Un connecteur dont
 * la connexion lâche à chaque appel restait donc VERT dans la console, sa dernière erreur effacée à chaque
 * fois. C'est ça que ces tests tiennent.
 */
describe('résolveur http : une connexion qui lâche n’est pas un JSON invalide', () => {
  const fluxCasse = () => new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new Uint8Array([123, 34, 97])); c.error(new Error('connexion coupée')); },
  });

  it('🔴 un flux COUPÉ est un échec, et il marque la source en ÉCHEC', async () => {
    const { resolveur, entree, epreuves } = harnais({ reponse: { status: 200, body: fluxCasse() } });
    const r = await resolveur(entree);
    expect(r.ok, 'un corps illisible ne doit jamais passer pour un succès').toBe(false);
    expect(JSON.stringify(r.contenu)).toContain('interrompu');
    // 🔴 LE VRAI POINT DU CORRECTIF : avant, ce cas passait par le `catch` du JSON, qui marque la source
    // SAINE. Un connecteur mort restait vert dans la console jusqu'à ce qu'un contact le découvre.
    expect(epreuves.at(-1)).toMatchObject({ ok: false });
  });

  it('🔴 et la trace persistante le DISTINGUE d’un JSON invalide', async () => {
    // Sans clé de journal distincte, le drapeau n'aurait servi qu'à l'instant de l'appel : la seule trace
    // qui survit aurait continué de confondre les deux causes, donc l'exploitation aussi.
    const casse = await (await harnais({ reponse: { status: 200, body: fluxCasse() } })).resolveur(
      (await harnais({ reponse: { status: 200, body: fluxCasse() } })).entree,
    );
    const invalide = await (await harnais({ reponse: { status: 200, body: 'pas du json' } })).resolveur(
      (await harnais({ reponse: { status: 200, body: 'pas du json' } })).entree,
    );
    expect(casse.erreur).toBe('coupe');
    expect(invalide.erreur).toBe('illisible');
  });

  it('un corps JSON valide reste un succès : le témoin', async () => {
    // Sans lui, les deux tests précédents seraient satisfaits par un refus systématique.
    const { resolveur, entree, epreuves } = harnais({ reponse: { status: 200, body: '{"statut":"ok"}' } });
    const r = await resolveur(entree);
    expect(r.ok).not.toBe(false);
    expect(epreuves.at(-1)).toMatchObject({ ok: true });
  });

  it('⚠️ un corps VIDE reste traité comme un JSON invalide, PAS comme une coupure', async () => {
    // La frontière exacte, et elle est contre-intuitive : un serveur qui répond 200 avec zéro octet n'a pas
    // coupé sa connexion, il a répondu quelque chose d'inexploitable. Les deux cas restent distincts.
    const { resolveur, entree } = harnais({ reponse: { status: 200, body: '' } });
    const r = await resolveur(entree);
    expect(r.ok).toBe(false);
    expect(r.erreur).toBe('illisible');
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

  it('🔴 une source qui n est PAS un systeme HTTP : on ne parle pas HTTP brut a un serveur MCP', async () => {
    // La garde JUMELLE de celle du resolveur MCP, et la poser d un seul cote n en aurait pas ete une. Le
    // croisement origin/kind est ferme en base par la cle etrangere composite de 0152, mais en MATCH
    // SIMPLE : une ligne d avant le deploiement porte `source_kind` a null et lui echappe. Sans ce refus,
    // l appel partirait sur le point MCP du client, avec son secret dans l en-tete, et `construireCible`
    // validerait le gabarit de chemin contre la MAUVAISE adresse de base.
    const { resolveur, entree, appels } = harnais({ source: { ...SOURCE, kind: 'mcp' } });
    const r = await resolveur(entree);
    expect(r.ok).toBe(false);
    expect(r.erreur).toContain('mcp');
    expect(appels, 'AUCUN appel reseau ne part').toHaveLength(0);
  });

  it('gabarit illisible ou cible refusée', async () => {
    // ⚠️ La méthode et le chemin vivent sur la REQUÊTE depuis la migration 0105 : c'est elle qu'on abîme ici,
    // plus le binding de l'outil. Le `as` est assumé, on éprouve précisément des valeurs que le type refuse
    // et que la base peut pourtant porter (jsonb écrit par une version antérieure de la console).
    for (const abime of [
      { methode: '', chemin: '' }, { methode: 'GET', chemin: '' }, { methode: 'CONNECT', chemin: '/x' },
      { methode: 'GET', chemin: 'https://evil.test/x' },
    ] as Array<{ methode: string; chemin: string }>) {
      const { resolveur, entree, appels } = harnais({
        requete: { ...REQUETE, ...(abime as unknown as Pick<RequeteConnecteur, 'methode' | 'chemin'>) },
      });
      const r = await resolveur(entree);
      expect(r.ok, JSON.stringify(abime)).toBe(false);
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

  it('un outil qui INTÈGRE sans aucun champ ne divulgue RIEN : le filtre est la règle, pas l’exception', async () => {
    /**
     * La décision D-L2-2 : la réponse appartient au client. Une déclaration incomplète ne doit RIEN
     * divulguer plutôt que tout.
     *
     * ⚠️ LE CAS EXERCÉ EST CONSERVÉ, LA SOURCE DU FILTRE A CHANGÉ (migration 0150). Ce test vidait la liste
     * de la REQUÊTE ; il vide désormais celle de l'OUTIL, parce que c'est elle que le résolveur lit. Vider
     * la requête ne prouverait plus rien : un outil qui porte ses champs n'en dépend plus.
     */
    const { resolveur, entree } = harnais({ outil: { ...OUTIL, outputPaths: [] } });
    const r = await resolveur(entree);
    expect(r.ok).toBe(false);
  });

  it('🔴 un outil qui ne DÉSIGNE aucune requête refuse au lieu d’inventer un appel', async () => {
    // La contrainte de clé étrangère rend le cas improbable, mais « improbable » n'est pas « impossible » :
    // un outil orphelin ne doit pas retomber sur un appel par défaut, qui irait quelque part.
    const { resolveur, entree } = harnais({ requete: null });
    const r = await resolveur(entree);
    expect(r.ok).toBe(false);
    expect(String(r.erreur)).toMatch(/requête introuvable/i);
  });
});

/**
 * Ce que le lot apporte vraiment : un connecteur qui ENVOIE quelque chose. Avant, un POST partait avec un
 * corps vide, donc ne servait à rien.
 */
describe('résolveur http : le corps et les variables', () => {
  it('🔴 un POST part AVEC son corps, rempli des variables déclarées', async () => {
    const { resolveur, entree, appels } = harnais({
      requete: {
        ...REQUETE, methode: 'POST', chemin: '/recherche',
        corps: { mode: 'json', gabarit: '{"ville": "{{ville}}", "question": "{{q}}"}' },
        variables: [
          { nom: 'ville', type: 'string', origine: { type: 'champ', cle: 'ville' } },
          { nom: 'q', type: 'string', origine: { type: 'systeme', cle: 'derniere_saisie' } },
        ],
      },
      ctx: { contact: { nom: 'Léa', champs: { ville: 'Lyon' } } },
      derniereSaisie: 'je cherche un plombier',
    });
    const r = await resolveur(entree);
    expect(r.ok).not.toBe(false);
    expect(appels).toHaveLength(1);
    expect(appels[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(appels[0]!.init.body))).toEqual({ ville: 'Lyon', question: 'je cherche un plombier' });
    // Le type de contenu est posé d'après ce qui part réellement.
    expect((appels[0]!.init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('la valeur système « maintenant » part avec le décalage du fuseau de l’espace', async () => {
    const { resolveur, entree, appels } = harnais({
      requete: {
        ...REQUETE, methode: 'POST', chemin: '/x',
        corps: { mode: 'champs', champs: [{ cle: 'le', valeur: '{{quand}}' }] },
        variables: [{ nom: 'quand', type: 'string', origine: { type: 'systeme', cle: 'maintenant' } }],
      },
    });
    await resolveur(entree);
    // Horloge figée à 09:45 UTC, fuseau Europe/Paris : l'heure LUE doit être 11:45, pas 09:45.
    expect(JSON.parse(String(appels[0]!.init.body))).toEqual({ le: '2026-09-02T11:45:00+02:00' });
  });

  it('🔴 une variable SANS VALEUR refuse l’appel : rien ne part avec une donnée inventée', async () => {
    // Envoyer une ville qu'on ne connaît pas ferait répondre le système du client sur autre chose, et l'agent
    // répéterait cette réponse au contact avec assurance.
    const { resolveur, entree, appels } = harnais({
      requete: {
        ...REQUETE, methode: 'POST', chemin: '/x',
        corps: { mode: 'json', gabarit: '{"v": "{{ville}}"}' },
        variables: [{ nom: 'ville', type: 'string', origine: { type: 'champ', cle: 'ville' }, requis: true }],
      },
      ctx: { contact: { nom: 'Léa', champs: {} } },
    });
    const r = await resolveur(entree);
    expect(r.ok).toBe(false);
    expect(appels).toHaveLength(0); // aucun appel réseau n'est parti
  });

  it('une variable FACULTATIVE dont la valeur est inconnue part en null, et l’appel a lieu', async () => {
    // Le pendant du cas précédent, sans lequel il ne prouverait pas grand-chose : toutes les absences ne se
    // valent pas, et c'est le client qui dit lesquelles empêchent l'appel. Décider à sa place refuserait des
    // appels parfaitement valides sur une API qui accepte un champ vide.
    const { resolveur, entree, appels } = harnais({
      requete: {
        ...REQUETE, methode: 'POST', chemin: '/x',
        corps: { mode: 'json', gabarit: '{"v": "{{ville}}"}' },
        variables: [{ nom: 'ville', type: 'string', origine: { type: 'champ', cle: 'ville' } }],
      },
      ctx: { contact: { nom: 'Léa', champs: {} } },
    });
    const r = await resolveur(entree);
    expect(r.ok).not.toBe(false);
    expect(JSON.parse(String(appels[0]!.init.body))).toEqual({ v: null });
  });

  it('les paramètres d’URL sont ajoutés à l’adresse', async () => {
    const { resolveur, entree, appels } = harnais({
      requete: {
        ...REQUETE, chemin: '/commandes', parametres: [{ cle: 'ville', valeur: '{{v}}' }],
        variables: [{ nom: 'v', type: 'string', origine: { type: 'fixe', valeur: 'Nice' } }],
      },
    });
    await resolveur(entree);
    expect(appels[0]!.url).toBe('https://api.client.fr/v1/commandes?ville=Nice');
  });

  it('🔴 un en-tête « authorization » saisi dans la requête ne recouvre pas celui de la SOURCE', async () => {
    // Deux gardes se recouvrent ici : la saisie est refusée par la route, et l'authentification de la source
    // est superposée EN DERNIER. Ce test tient même si la première tombe.
    const { resolveur, entree, appels } = harnais({
      requete: { ...REQUETE, entetes: [{ nom: 'authorization', valeur: 'Bearer FAUX' }] },
    });
    await resolveur(entree);
    expect((appels[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer JETON-SECRET-42');
  });
});


/**
 * 🔴 LA GARDE DE RÉSOLUTION, VUE DEPUIS LE CONNECTEUR (constat A3, 2026-09-02).
 *
 * `construireCible` refuse déjà tous les hôtes internes écrits en clair et tous les littéraux d'adresse. Elle
 * lit le TEXTE : elle ne peut rien contre `crm.exemple.fr` dont l'enregistrement A pointe vers le réseau
 * Docker du VPS ou vers le service de métadonnées du fournisseur. Le contrôle du NOM RÉSOLU est ici.
 */
describe('résolveur http : où le nom mène vraiment', () => {
  it('🔴 un nom qui résout vers l’intérieur : AUCUN appel ne part', async () => {
    // Le point du lot. « Aucun appel » et pas seulement « une erreur rendue » : la requête ne doit jamais
    // toucher le réseau interne, même pour en recevoir un refus.
    const h = harnais({ resolution: async () => ({ ok: false, raison: 'ce nom pointe vers une adresse interne' }) });
    const res = await h.resolveur(h.entree);
    expect(res.ok).toBe(false);
    expect(h.appels).toEqual([]);
    expect(String(res.erreur)).toContain('resolution_interne');
  });

  it('le refus est noté SUR LA SOURCE, et ce qu’on dit au modèle ne décrit pas notre réseau', async () => {
    const h = harnais({ resolution: async () => ({ ok: false, raison: 'ce nom pointe vers une adresse interne' }) });
    const res = await h.resolveur(h.entree);
    // Visible dans la console du client : un connecteur mal pointé doit se voir avant qu'un contact ne le
    // découvre.
    expect(h.epreuves.some((e) => e.ok === false && e.erreur === 'adresse interne')).toBe(true);
    // Et le modèle ne reçoit ni l'adresse, ni le mot « Docker », ni rien qui renseigne sur la topologie.
    const dit = JSON.stringify(res.contenu);
    expect(dit).not.toMatch(/172\.|169\.254|docker|localhost/i);
  });

  it('un nom public laisse l’appel partir normalement', async () => {
    const h = harnais();
    const res = await h.resolveur(h.entree);
    expect(res.ok).not.toBe(false);
    expect(h.appels).toHaveLength(1);
  });
});
