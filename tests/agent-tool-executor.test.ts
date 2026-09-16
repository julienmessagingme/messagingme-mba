import { describe, it, expect } from 'vitest';
import { executeTool, type ContexteAppel, type ResolveurOutil, type ToolExecutorDeps } from '../src/agent/executor';
import type { JournalAppels, OutilDefini, ToolCatalog } from '../src/agent/catalog';
import { SANS_MCP } from './outils-mcp';

/**
 * Tâche 16 : le tronc commun d'exécution d'outil (§3.3 du cadrage).
 *
 * La règle centrale est testée partout ici : `executeTool` NE LÈVE JAMAIS sur un cas métier. Chaque garde rend
 * une raison lisible au modèle, qui peut se corriger au tour suivant.
 */

const OUTIL: OutilDefini = { ...SANS_MCP,
  id: 'to1',
  tenantId: 't1',
  origin: 'mba',
  nePasUtiliser: '',
  name: 'lire_commande',
  description: 'lit une commande',
  params: [
    { name: 'reference', type: 'string', source: 'modele', required: true },
    { name: 'wa_id', type: 'string', source: 'contact', contactPath: 'wa_id' },
    { name: 'boutique', type: 'string', source: 'fixe', value: 'FR-01' },
  ],
  binding: { handler: 'peu_importe' }, sourceId: null, requestId: null,
  nature: 'integre' as const, outputPaths: [],
  risk: 'read',
  timeoutMs: 5_000,
  maxBytes: 16_384,
  autonome: false,
};

const CTX: ContexteAppel = {
  tenantId: 't1',
  agentId: 'ag1',
  sessionId: 's1',
  runId: 'r1',
  workflowId: 'wf1',
  waId: '33600',
  // 🔴 LA PROJECTION RÉELLE, celle que `src/worker.ts` construit : `{ nom, tags, champs }`, et SURTOUT PAS le
  // numéro. Elle part chez le fournisseur de modèle (`mba_lire_contact` la rend telle quelle), donc y verser
  // la ligne brute enverrait le numéro, le BSUID et l'opt-in. Le fixe portait `wa_id` jusqu'au 2026-08-28, ce
  // qui faisait passer des tests sur une forme que la production n'a jamais eue : c'est ainsi qu'un paramètre
  // `contactPath: 'wa_id'` d'un connecteur aurait reçu `null` en vrai.
  contact: { nom: 'Julien', tags: [], champs: {} },
  contactInconnu: 'lecture_seule',
  appelsRestants: 5,
  budgetRestantMicroEur: 10_000,
  deadline: 1_000_000 + 30_000,
};

interface LigneJournal { id: string; toolId: string | null; toolName: string; args: unknown; status?: string; dureeMs?: number; erreur?: string; tailleReponse?: number }

function harnais(over: {
  outil?: OutilDefini | null;
  resolveur?: ResolveurOutil;
  origines?: ToolExecutorDeps['resolveurs'];
} = {}) {
  const journal: LigneJournal[] = [];
  const vus: Array<{ args: Record<string, unknown>; aborte: boolean }> = [];
  const compteur: string[] = [];
  const outil = over.outil === undefined ? OUTIL : over.outil;
  const catalogue: ToolCatalog = {
    byName: async () => outil,
    listActifs: async () => (outil ? [outil] : []),
  };
  const j: JournalAppels = {
    ouvrir: async (i) => {
      const id = `j${journal.length + 1}`;
      journal.push({ id, toolId: i.toolId, toolName: i.toolName, args: i.argsRediges });
      return id;
    },
    clore: async (i) => {
      const l = journal.find((x) => x.id === i.id);
      if (l) Object.assign(l, { status: i.status, dureeMs: i.dureeMs, erreur: i.erreur, tailleReponse: i.tailleReponse });
    },
  };
  const resolveur: ResolveurOutil = over.resolveur ?? (async ({ args, signal }) => {
    vus.push({ args, aborte: signal.aborted });
    return { contenu: { ok: true } };
  });
  const deps: ToolExecutorDeps = {
    catalogue,
    journal: j,
    resolveurs: over.origines ?? { mba: resolveur },
    compterAppel: async (_t, s) => { compteur.push(s); },
    now: () => 1_000_000,
  };
  return { deps, journal, vus, compteur };
}

const args = (o: unknown) => JSON.stringify(o);

describe('tronc commun : résoudre et autoriser (étapes 1 et 2)', () => {
  it('outil inconnu ou desactive -> refus rendu au modele, jamais une exception', async () => {
    // `byName` filtre déjà `actif` en SQL : un outil éteint est indistinguable d'un outil absent, et c'est
    // voulu. Le modèle reçoit une raison, il ne fait pas tomber le tour.
    const { deps, journal } = harnais({ outil: null });
    const r = await executeTool({ name: 'inventé', argumentsJson: '{}' }, CTX, deps);
    expect(r.status).toBe('refuse');
    expect(r.contenu).toMatchObject({ erreur: expect.stringContaining('inconnu') });
    // La tentative est journalisée même sans outil résolu : c'est exactement ce qu'on veut voir en instruisant
    // un incident (un modèle qui appelle en boucle un nom qui n'existe pas).
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ toolId: null, toolName: 'inventé', status: 'refuse' });
  });

  it('🔴 action irreversible : refusee sans le drapeau autonome, servie avec', async () => {
    const dur = { ...OUTIL, risk: 'irreversible' as const, autonome: false };
    const a = harnais({ outil: dur });
    expect((await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, a.deps)).status).toBe('refuse');

    const b = harnais({ outil: { ...dur, autonome: true } });
    const r = await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, b.deps);
    expect(r.status).toBe('ok');
  });

  it('contact inconnu : « aucun_outil » refuse tout, « lecture_seule » ne laisse passer que la lecture', async () => {
    const sansContact: ContexteAppel = { ...CTX, contact: null };
    const a = harnais();
    expect((await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) },
      { ...sansContact, contactInconnu: 'aucun_outil' }, a.deps)).status).toBe('refuse');

    // lecture_seule + risk 'write' -> refus
    const b = harnais({ outil: { ...OUTIL, risk: 'write' } });
    expect((await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) },
      { ...sansContact, contactInconnu: 'lecture_seule' }, b.deps)).status).toBe('refuse');

    // lecture_seule + risk 'read' -> passe
    const c = harnais();
    expect((await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) },
      { ...sansContact, contactInconnu: 'lecture_seule' }, c.deps)).status).toBe('ok');

    // tous -> passe même en écriture
    const d = harnais({ outil: { ...OUTIL, risk: 'write' } });
    expect((await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) },
      { ...sansContact, contactInconnu: 'tous' }, d.deps)).status).toBe('ok');
  });

  it('plafond d appels atteint et budget epuise -> statut « budget », le resolveur n est pas appele', async () => {
    const a = harnais();
    const r1 = await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, { ...CTX, appelsRestants: 0 }, a.deps);
    expect(r1.status).toBe('budget');
    expect(a.vus).toEqual([]);

    const b = harnais();
    const r2 = await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, { ...CTX, budgetRestantMicroEur: 0 }, b.deps);
    expect(r2.status).toBe('budget');
    expect(b.vus).toEqual([]);
  });
});

describe('tronc commun : valider et compléter (étapes 3 et 4)', () => {
  it('JSON illisible et champ requis manquant -> refus rendu au modele, pas un throw', async () => {
    const a = harnais();
    const r1 = await executeTool({ name: OUTIL.name, argumentsJson: '{ pas du json' }, CTX, a.deps);
    expect(r1.status).toBe('refuse');
    expect(r1.contenu).toMatchObject({ erreur: expect.stringContaining('JSON') });

    const b = harnais();
    const r2 = await executeTool({ name: OUTIL.name, argumentsJson: args({}) }, CTX, b.deps);
    expect(r2.status).toBe('refuse');
    expect(r2.contenu).toMatchObject({ erreur: expect.stringContaining('reference') });
    expect(b.vus).toEqual([]);
  });

  it('type faux -> refus ; enumeration hors domaine -> refus', async () => {
    const outil: OutilDefini = {
      ...OUTIL,
      params: [
        { name: 'quantite', type: 'integer', source: 'modele', required: true },
        { name: 'canal', type: 'string', source: 'modele', required: true, enum: ['sms', 'email'] },
      ],
    };
    const a = harnais({ outil });
    expect((await executeTool({ name: OUTIL.name, argumentsJson: args({ quantite: 'trois', canal: 'sms' }) }, CTX, a.deps)).status).toBe('refuse');
    const b = harnais({ outil });
    expect((await executeTool({ name: OUTIL.name, argumentsJson: args({ quantite: 2, canal: 'pigeon' }) }, CTX, b.deps)).status).toBe('refuse');
    const c = harnais({ outil });
    expect((await executeTool({ name: OUTIL.name, argumentsJson: args({ quantite: 2, canal: 'sms' }) }, CTX, c.deps)).status).toBe('ok');
  });

  it('🔴 un parametre injecte envoye PAR LE MODELE n ecrase jamais la valeur du runtime', async () => {
    // LE point de vigilance de la tâche 15, un cran plus loin. Sans les deux ceintures (le schéma de
    // validation ne connaît que les paramètres `modele`, et l'injection écrit en dernier), il suffirait de
    // demander à l'agent la commande de quelqu'un d'autre : c'est un IDOR offert au premier venu qui écrit
    // sur le numéro.
    const { deps, vus, journal } = harnais();
    const r = await executeTool(
      { name: OUTIL.name, argumentsJson: args({ reference: 'CMD-1', wa_id: '33699999999', boutique: 'PIRATE' }) },
      CTX,
      deps,
    );
    expect(r.status).toBe('ok');
    expect(vus[0]?.args).toEqual({ reference: 'CMD-1', wa_id: '33600', boutique: 'FR-01' });
    // Et le journal ne garde que ce que le MODÈLE a demandé, jamais les valeurs injectées.
    expect(journal[0]?.args).toEqual({ reference: 'CMD-1' });
  });

  it('🔴 declaration AMBIGUE (même nom en « modele » ET en « contact ») : le runtime gagne', async () => {
    // `params` est du jsonb écrit par la console : rien n'empêche un doublon, et c'est le seul cas où la
    // PREMIÈRE ceinture (le schéma de validation ignore les sources injectées) laisse passer la valeur du
    // modèle. C'est donc ici, et seulement ici, que la SECONDE se voit : l'injection écrit en dernier.
    const ambigu: OutilDefini = {
      ...OUTIL,
      params: [
        { name: 'wa_id', type: 'string', source: 'modele', required: true },
        { name: 'wa_id', type: 'string', source: 'contact', contactPath: 'wa_id' },
      ],
    };
    const { deps, vus } = harnais({ outil: ambigu });
    const r = await executeTool({ name: OUTIL.name, argumentsJson: args({ wa_id: '33699999999' }) }, CTX, deps);
    expect(r.status).toBe('ok');
    expect(vus[0]?.args).toEqual({ wa_id: '33600' });
  });

  it('🔴 declaration CASSEE côté runtime : la valeur du modele n atteint quand meme pas le resolveur', async () => {
    // La seconde entrée n'a pas de type, donc la coercion l'écarte. Sans réservation du nom, `wa_id` serait
    // exposé, validé, et rien ne l'écraserait : le modèle désignerait la commande de quelqu'un d'autre.
    const casse: OutilDefini = {
      ...OUTIL,
      params: [
        { name: 'wa_id', type: 'string', source: 'modele', required: true },
        { name: 'wa_id', source: 'contact', contactPath: 'wa_id' },
      ],
    };
    const { deps, vus } = harnais({ outil: casse });
    const r = await executeTool({ name: OUTIL.name, argumentsJson: args({ wa_id: '33699999999' }) }, CTX, deps);
    expect(r.status).toBe('ok');
    expect(vus[0]?.args).toEqual({}); // ni la valeur du modèle, ni une injection depuis une entrée illisible
  });

  it('🔴 le NUMÉRO vient du TOUR, pas de la projection : il est là même quand le contact est inconnu', async () => {
    // La clé de voûte anti-IDOR d'un connecteur. Il sert d'abord à répondre « où en est MA commande » : la
    // ressource est identifiée par le contact. La projection ne porte PAS le numéro (elle part chez le
    // fournisseur de modèle), donc le lire là rendrait `null`, et l'appel partirait sans identifiant. Le
    // numéro vient de `ctx.waId`, authentifié par la signature du webhook Meta, et le modèle ne le voit
    // jamais : sa propre valeur (`33699999999`) est écrasée.
    const { deps, vus } = harnais();
    await executeTool(
      { name: OUTIL.name, argumentsJson: args({ reference: 'CMD-1', wa_id: '33699999999' }) },
      { ...CTX, contact: null, contactInconnu: 'tous' },
      deps,
    );
    expect(vus[0]?.args).toEqual({ reference: 'CMD-1', wa_id: '33600', boutique: 'FR-01' });
  });

  it('un AUTRE champ « contact » reste lu dans la projection, et vaut null si elle manque', async () => {
    // La correction du numéro ne doit pas transformer tous les paramètres « contact » en valeurs du tour.
    const parNom: OutilDefini = {
      ...OUTIL,
      params: [{ name: 'client', type: 'string', source: 'contact', contactPath: 'nom' }],
    };
    const { deps, vus } = harnais({ outil: parNom });
    await executeTool({ name: OUTIL.name, argumentsJson: args({}) }, CTX, deps);
    expect(vus[0]?.args).toEqual({ client: 'Julien' });

    const { deps: d2, vus: v2 } = harnais({ outil: parNom });
    await executeTool({ name: OUTIL.name, argumentsJson: args({}) }, { ...CTX, contact: null, contactInconnu: 'tous' }, d2);
    expect(v2[0]?.args).toEqual({ client: null });
  });
});

describe('tronc commun : journaliser, appeler, assainir, clore (étapes 5 à 8)', () => {
  it('la ligne de journal est ouverte AVANT l appel, et close ensuite avec son statut', async () => {
    // At-least-once : le process peut mourir en plein appel. On veut la trace d'une TENTATIVE, sinon un outil
    // qui tue le worker à tous les coups serait invisible.
    const ordre: string[] = [];
    const journalOrdonne: JournalAppels = {
      ouvrir: async () => { ordre.push('ouvrir'); return 'j1'; },
      clore: async () => { ordre.push('clore'); },
    };
    const { deps } = harnais();
    const r = await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, {
      ...deps,
      journal: journalOrdonne,
      resolveurs: { mba: async () => { ordre.push('appel'); return { contenu: {} }; } },
    });
    expect(ordre).toEqual(['ouvrir', 'appel', 'clore']);
    expect(r.status).toBe('ok');
  });

  it('un resolveur qui LEVE est rattrape : « erreur_outil », raison rendue au modele', async () => {
    const { deps, journal } = harnais({ resolveur: async () => { throw new Error('reseau coupe'); } });
    const r = await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, deps);
    expect(r.status).toBe('erreur_outil');
    expect(r.contenu).toEqual({ erreur: 'reseau coupe' });
    expect(journal[0]).toMatchObject({ status: 'erreur_outil', erreur: 'reseau coupe' });
  });

  it('un resolveur qui rend « ok: false » est un echec METIER : erreur_outil, le tour continue', async () => {
    const { deps } = harnais({ resolveur: async () => ({ ok: false, contenu: { erreur: 'commande introuvable' }, erreur: 'commande introuvable' }) });
    const r = await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, deps);
    expect(r.status).toBe('erreur_outil');
    expect(r.fatal).toBeUndefined();
    expect(r.contenu).toEqual({ erreur: 'commande introuvable' });
  });

  it('un resolveur qui pend est COUPE a l echeance, et son signal est declenche', async () => {
    // La course double l'`AbortSignal` : le signal permet à un résolveur poli de s'arrêter, la course garantit
    // qu'on rend la main même s'il ne l'écoute pas. Sans elle, un fournisseur qui pend immobiliserait un slot
    // de worker pendant des minutes.
    let signalVu: AbortSignal | null = null;
    const { deps, journal } = harnais({
      outil: { ...OUTIL, timeoutMs: 1_000 },
      resolveur: ({ signal }) => new Promise((resolve) => {
        signalVu = signal;
        signal.addEventListener('abort', () => resolve({ contenu: { tard: true } }), { once: true });
      }),
    });
    const r = await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, deps);
    expect(r.status).toBe('timeout');
    expect(signalVu).not.toBeNull();
    expect((signalVu as unknown as AbortSignal).aborted).toBe(true);
    expect(journal[0]?.status).toBe('timeout');
  }, 10_000);

  it('echeance du tour DEJA depassee -> timeout immediat, le resolveur n est pas appele', async () => {
    const { deps, vus } = harnais();
    const r = await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, { ...CTX, deadline: 999_000 }, deps);
    expect(r.status).toBe('timeout');
    expect(vus).toEqual([]);
  });

  it('origine sans resolveur = erreur de PROTOCOLE : fatale, elle arrete le tour', async () => {
    // C'est un bug de notre câblage, pas une erreur que le modèle puisse corriger : on ne lui en reparle pas.
    const { deps, journal } = harnais({ origines: {} });
    const r = await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, deps);
    expect(r.status).toBe('erreur_protocole');
    expect(r.fatal).toBe(true);
    expect(journal[0]?.status).toBe('erreur_protocole');
  });

  it('output_paths : seuls les chemins declares repartent au modele', async () => {
    const { deps } = harnais({
      outil: { ...OUTIL, nature: 'integre' as const, outputPaths: ['data.statut', 'data.absent'] },
      resolveur: async () => ({ contenu: { data: { statut: 'expediee', secret: 'ne pas exposer' }, meta: { taille: 12 } } }),
    });
    const r = await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, deps);
    expect(r.contenu).toEqual({ 'data.statut': 'expediee' });
  });

  it('la reponse est bornee a max_bytes, et la troncature est ANNONCEE au modele', async () => {
    // Tronquer en silence ferait conclure le modèle sur une réponse coupée.
    const { deps, journal } = harnais({
      outil: { ...OUTIL, maxBytes: 256 },
      resolveur: async () => ({ contenu: { texte: 'x'.repeat(2000) } }),
    });
    const r = await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, deps);
    expect(r.contenu).toMatchObject({ tronque: true });
    // La borne est en OCTETS et couvre l'enveloppe : un « moins de 600 » laisserait passer l'ancien découpage.
    expect(Buffer.byteLength(JSON.stringify(r.contenu), 'utf8')).toBeLessThanOrEqual(256);
    expect(journal[0]?.tailleReponse).toBeGreaterThan(2000);
  });

  it('🔴 le message d une EXCEPTION est borne lui aussi, avant de partir au modele', async () => {
    // Le retour du `catch` court-circuitait l'etape 7 : le message d'un resolveur qui leve entrait dans le
    // prompt sans plafond. Inoffensif tant que chaque resolveur attrape tout lui-meme, mais c'est faire
    // dependre une garde du prompt de la discipline de chaque resolveur, y compris celui qu'on n'a pas encore
    // ecrit. Or un resolveur MCP (lot L4) laissera remonter des erreurs JSON-RPC dont le message est ECRIT
    // PAR LE SERVEUR D EN FACE.
    const { deps, journal } = harnais({
      outil: { ...OUTIL, maxBytes: 256 },
      resolveur: async () => { throw new Error('C'.repeat(5000)); },
    });
    const r = await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, deps);
    expect(r.status).toBe('erreur_outil');
    expect(Buffer.byteLength(JSON.stringify(r.contenu), 'utf8')).toBeLessThanOrEqual(256);
    // Le journal aussi est borne : une ligne de journal n'a pas a porter un corps de reponse entier.
    expect(String(journal[0]?.erreur ?? '').length).toBeLessThanOrEqual(2000);
  });

  it('le compteur d appels de la session est incremente sur un appel servi', async () => {
    // Sans lui, le plafond d'appels lu par `runTurn` d'un tour sur l'autre serait décoratif.
    const { deps, compteur } = harnais();
    await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, deps);
    expect(compteur).toEqual(['s1']);
  });

  it('« sortie » et « rendu » remontent tels quels a l appelant', async () => {
    const a = harnais({ resolveur: async () => ({ contenu: {}, sortie: 'besoin_cerne' }) });
    expect((await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, a.deps)).sortie).toBe('besoin_cerne');

    const b = harnais({ resolveur: async () => ({ contenu: {}, rendu: true }) });
    expect((await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, b.deps)).rendu).toBe(true);
  });

  it('un journal en panne ne fait PAS tomber l appel (best-effort dans les deux sens)', async () => {
    // Un journal muet est un désagrément ; un tour qui meurt parce qu'une insertion a trébuché est un incident.
    const { deps } = harnais();
    const r = await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, {
      ...deps,
      journal: { ouvrir: async () => { throw new Error('base injoignable'); }, clore: async () => { throw new Error('base injoignable'); } },
    });
    expect(r.status).toBe('ok');
  });
});

describe('tronc commun : les issues coûteuses se comptent aussi (revue tâche 16)', () => {
  it('🔴 le compteur d appels avance AUSSI sur un timeout et sur un resolveur qui leve', async () => {
    // Ce sont les deux issues les plus chères : un outil qui pend jusqu'à son délai, et un outil qui rejette
    // après un aller-retour réseau déjà payé. Ne compter que les succès inverserait la garde, et une
    // injection qui fait boucler l'agent sur des outils en échec brûlerait le compte prépayé sans l'entamer.
    const a = harnais({
      outil: { ...OUTIL, timeoutMs: 200 },
      resolveur: () => new Promise(() => {}), // ne se termine jamais
    });
    expect((await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, a.deps)).status).toBe('timeout');
    expect(a.compteur).toEqual(['s1']);

    const b = harnais({ resolveur: async () => { throw new Error('reseau coupe'); } });
    await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, b.deps);
    expect(b.compteur).toEqual(['s1']);
  });

  it('rien n est compté quand le résolveur n a jamais été atteint', async () => {
    const a = harnais();
    await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, { ...CTX, appelsRestants: 0 }, a.deps);
    expect(a.compteur).toEqual([]);

    const b = harnais();
    await executeTool({ name: OUTIL.name, argumentsJson: args({}) }, CTX, b.deps); // requis manquant
    expect(b.compteur).toEqual([]);
  });

  it('🔴 un catalogue injoignable ne fait PAS tomber le tour', async () => {
    // C'était le seul `await` non gardé du module, alors que le journal l'était déjà : une panne de pooler
    // aurait fait mentir la règle centrale.
    const { deps } = harnais();
    const r = await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, {
      ...deps,
      catalogue: { byName: async () => { throw new Error('pooler injoignable'); }, listActifs: async () => [] },
    });
    expect(r.status).toBe('erreur_outil');
    expect(r.contenu).toMatchObject({ erreur: expect.stringContaining('catalogue') });
  });

  it('un refus journalise CE QUE LE MODELE DEMANDAIT, y compris avant toute analyse', async () => {
    // C'est la trace qu'on voudra en instruisant une tentative sur un outil irréversible.
    const a = harnais({ outil: { ...OUTIL, risk: 'irreversible' } });
    await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'CMD-9' }) }, CTX, a.deps);
    expect(a.journal[0]?.args).toEqual({ reference: 'CMD-9' });

    // JSON illisible : on garde le brut tronqué plutôt que rien.
    const b = harnais();
    await executeTool({ name: OUTIL.name, argumentsJson: '{ casse' }, CTX, b.deps);
    expect(b.journal[0]?.args).toEqual({ brut: '{ casse' });
  });

  it('la duree est REELLEMENT mesuree et journalisee', async () => {
    // Avec une horloge gelée, remplacer le calcul par `dureeMs: 0` en dur laisserait la suite verte.
    let t = 1_000_000;
    const { deps, journal } = harnais();
    const r = await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, {
      ...deps, now: () => { t += 5; return t; },
    });
    expect(r.status).toBe('ok');
    expect(journal[0]?.dureeMs).toBeGreaterThan(0);
  });

  it('la borne max_bytes tient VRAIMENT, enveloppe et accents compris', async () => {
    // `slice` découpe en caractères contre un plafond en octets, et l'enveloppe de troncature s'ajoute
    // par-dessus : sans correction la sortie dépassait le plafond que le client a réglé.
    const { deps } = harnais({
      outil: { ...OUTIL, maxBytes: 300 },
      resolveur: async () => ({ contenu: { texte: 'éàü"'.repeat(500) } }),
    });
    const r = await executeTool({ name: OUTIL.name, argumentsJson: args({ reference: 'X' }) }, CTX, deps);
    expect(r.contenu).toMatchObject({ tronque: true });
    expect(Buffer.byteLength(JSON.stringify(r.contenu), 'utf8')).toBeLessThanOrEqual(300);
  });

  it('un parametre facultatif rendu a null par le fournisseur vaut « non fourni », pas « invalide »', async () => {
    const { deps, vus } = harnais({
      outil: { ...OUTIL, params: [{ name: 'note', type: 'string', source: 'modele' }] },
    });
    const r = await executeTool({ name: OUTIL.name, argumentsJson: args({ note: null }) }, CTX, deps);
    expect(r.status).toBe('ok');
    expect(vus[0]?.args).toEqual({});
  });
});
