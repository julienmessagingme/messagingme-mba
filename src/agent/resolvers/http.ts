import type { EntreeResolveur, ResolveurOutil, SortieResolveur } from '../executor';
import type { JournalAppels, SourceAppel, StatutAppel } from '../catalog';
import type { SourceStore } from '../sources';
import type { RequeteStore } from '../requetes';
import { construireCible, enTetesAuthSource } from '../http-cible';
import { resolutionPublique, type VerdictResolution } from '../../lib/adresse-privee';
import { fetchPublic, estRefusAdresseInterne, estRedirectionRefusee } from '../../lib/connexion-publique';
import { lireCorpsBorne } from '../../lib/corps-borne';
import { assemblerAppel } from '../requete-http';
import { resoudreVariable, type ValeurResolue } from '../variables';

/**
 * Le résolveur des outils de connecteur : un appel HTTP vers le système du client.
 *
 * 🔴 `contenu` et `erreur` repartent au modèle, donc chez le fournisseur : jamais le secret, jamais le corps
 * brut d'une erreur du client (chemins internes, identifiants), jamais un champ absent de `outputPaths`.
 * Pas d'exception sur un cas métier : `ok: false` avec une raison lisible (une `erreur_protocole` arrêterait
 * le tour). `redirect: 'error'` : une API qui redirige est une anomalie, et suivre le second saut
 * contournerait les gardes de `http-cible.ts`.
 */

export interface DepsResolveurHttp {
  sources: Pick<SourceStore, 'pourAppel' | 'marquerEpreuve'>;
  /** La requête désignée par l'outil : méthode, chemin, corps, variables. */
  requetes: Pick<RequeteStore, 'parId'>;
  /**
   * Les valeurs que seule la base connaît, chargées paresseusement, seulement si une variable en dépend : un
   * connecteur qui n'envoie qu'un numéro ne paie pas deux requêtes de plus sur un chemin chaud. Pas les champs
   * personnalisés : la projection du contact les porte déjà.
   */
  inbox?: { derniereSaisieDuContact(tenantId: string, waId: string): Promise<string | null> };
  fuseau?: (tenantId: string) => Promise<string>;
  /** Injecté pour tester sans réseau, comme partout dans ce dépôt. */
  fetchImpl?: typeof fetch;
  /** Injectée pour que la valeur système « maintenant » soit reproductible en test. */
  now?: () => Date;
  /** Injectée pour tester la garde de résolution sans DNS. Défaut : la vraie résolution. */
  verifierResolution?: (url: string) => Promise<VerdictResolution>;
}

/** Ce qu'on dit au modèle quand ça ne va pas. Volontairement pauvre : il n'a pas à savoir pourquoi le
 *  système du client refuse, seulement qu'il ne peut pas répondre depuis cette source. */
const MESSAGES: Record<string, string> = {
  auth: 'le système du client a refusé l’authentification de ce connecteur',
  indispo: 'le système du client n’a pas répondu',
  illisible: 'le système du client a répondu dans un format inattendu',
  trop_gros: 'la réponse du système du client est trop volumineuse',
  coupe: 'le système du client a interrompu sa réponse en cours d’envoi',
  redirige: 'le système du client a redirigé l’appel, ce qui n’est pas accepté sur un connecteur',
  interne: 'l’adresse de ce connecteur n’est pas joignable depuis notre infrastructure',
};

/** Extrait un chemin pointé (`livraison.date`) d'une réponse JSON. Ni joker ni index de tableau : nommer
 *  des champs suffit. */
function extraire(source: unknown, chemin: string): unknown {
  let courant: unknown = source;
  for (const cle of chemin.split('.')) {
    if (courant === null || typeof courant !== 'object') return undefined;
    courant = (courant as Record<string, unknown>)[cle];
  }
  return courant;
}

/**
 * Ce qu'il faut pour appeler un connecteur, quel que soit l'appelant (agent, scénario, poussée d'opt-out,
 * relais du MBA). Un seul chemin pour les sept gardes (source active, filtre de sortie, variables requises,
 * adresse interne, redirection, échéance, corps borné), sinon les copies divergeraient.
 */
export interface AppelConnecteur {
  tenantId: string;
  waId: string;
  /** Projection du contact (`{nom, tags, champs}`), source des variables `champ` et `contact`. `null` : un
   *  appel dont une variable la réclame est refusé, jamais envoyé avec une valeur inventée. */
  contact: Record<string, unknown> | null;
  /** La requête à jouer (`connector_requests`). */
  requestId: string;
  /** Plafond de lecture du corps, en octets. */
  maxBytes: number;
  /** Valeurs des variables d'origine `modele`. Vide pour un scénario : une variable `modele` requise y est
   *  refusée avec sa raison. */
  args: Record<string, unknown>;
  signal: AbortSignal;
  /**
   * Où journaliser cet appel, ou `null` quand l'appelant le fait déjà. Obligatoire : un champ optionnel
   * s'oublierait au prochain appelant, dont les échecs ne laisseraient aucune trace consultable. `null` est
   * une décision : le résolveur d'agent le passe parce que son exécuteur journalise déjà.
   */
  journal: JournalDAppel | null;
  /**
   * Ce que l'appelant fait de la réponse, obligatoire pour la même raison que `journal`. `champs: null` veut
   * dire « ceux de la requête » (un scénario n'a pas d'outil) ; un outil d'agent porte sa propre liste, car un
   * appel est partagé et ce qu'un agent en lit ne l'est pas.
   */
  lecture:
    | { nature: 'pousse' }
    | { nature: 'integre'; champs: readonly string[] | null }
    /**
     * La réponse entière, bornée à `maxBytes` : le mode du relais du Meta Business Agent, pour qu'un modèle qui
     * ne voit rien ne conclue pas à un échec. Les échecs gardent le message sûr de l'étape 8.
     */
    | { nature: 'entier' };
}

/** De quoi ouvrir et clore une ligne de journal pour un appel de connecteur. */
export interface JournalDAppel {
  journal: JournalAppels;
  source: SourceAppel;
  /** Le nom lisible de l'appel. Pour un scénario ou une poussée, le libellé de la requête : un humain le
   *  reconnaît, un uuid ne dit rien. */
  nom: string;
  /** La session d'agent, ou `null` : un scénario et une poussée d'opt-out n'en ouvrent pas. */
  sessionId: string | null;
  toolId: string | null;
}

/**
 * L'appel lui-même, partagé par tous les appelants : les mêmes gardes, dans le même ordre, avec les mêmes
 * messages.
 */
export function creerAppelConnecteur(deps: DepsResolveurHttp): (p: AppelConnecteur) => Promise<SortieResolveur> {
  // Le `fetch` vérifié à la connexion (DNS rebinding) : `src/lib/connexion-publique.ts`.
  const appeler = deps.fetchImpl ?? fetchPublic;
  const estPublique = deps.verifierResolution ?? ((url: string) => resolutionPublique(url));

  /** L'enveloppe de journal, best-effort dans les deux sens : un appel ne meurt pas d'une insertion ratée. */
  const journaliser = async (p: AppelConnecteur, faire: () => Promise<SortieResolveur>): Promise<SortieResolveur> => {
    if (p.journal === null) return faire();
    const j = p.journal;
    const debut = Date.now();
    let ligne: string | null = null;
    try {
      ligne = await j.journal.ouvrir({
        tenantId: p.tenantId, sessionId: j.sessionId, toolId: j.toolId, toolName: j.nom,
        origin: 'http', argsRediges: p.args, source: j.source,
      });
    } catch {
      ligne = null; // journal indisponible : l'appel part quand même.
    }
    const sortie = await faire();
    if (ligne !== null) {
      // `timeout` se distingue d'une panne : « votre système n'a pas répondu à temps » et « votre système a
      // refusé » appellent des corrections opposées.
      const statut: StatutAppel = sortie.ok === false
        ? (p.signal.aborted ? 'timeout' : 'erreur_outil')
        : 'ok';
      await j.journal.clore({
        tenantId: p.tenantId, id: ligne, status: statut, dureeMs: Date.now() - debut,
        ...(sortie.httpStatus !== undefined ? { httpStatus: sortie.httpStatus } : {}),
        ...(sortie.erreur !== undefined ? { erreur: sortie.erreur } : {}),
      }).catch(() => {});
    }
    return sortie;
  };

  return async (p: AppelConnecteur): Promise<SortieResolveur> => journaliser(p, async () => {
    const { args, signal } = p;
    const ctx = { tenantId: p.tenantId, waId: p.waId, contact: p.contact };
    const outil = { requestId: p.requestId, maxBytes: p.maxBytes };

    // 1. La requête. Un outil orphelin (requête supprimée) refuse au lieu d'inventer un appel.
    const requestId = typeof outil.requestId === 'string' ? outil.requestId : '';
    const requete = requestId === '' ? null : await deps.requetes.parId(ctx.tenantId, requestId);
    if (!requete) return { ok: false, contenu: { erreur: 'ce connecteur n’est pas configuré' }, erreur: 'requête introuvable' };

    /**
     * 2. Le filtre de sortie, avant tout le reste, fourni par l'appelant : la requête est partagée entre agents.
     * Un scénario passe `null` et retombe sur celui de la requête. Un `integre` sans aucun champ est un refus :
     * ne rien divulguer vaut mieux que tout. Un `pousse` n'a rien à déclarer.
     */
    const champsLus = p.lecture.nature === 'integre'
      ? (p.lecture.champs ?? requete.outputPaths)
      : [];
    if (p.lecture.nature === 'integre' && (!Array.isArray(champsLus) || champsLus.length === 0)) {
      return { ok: false, contenu: { erreur: 'ce connecteur ne déclare aucun champ à lire' }, erreur: 'outputPaths vide' };
    }

    // 3. La source. Absente, d'un autre tenant, ou pas active : aucun appel réseau ne part.
    const source = await deps.sources.pourAppel(ctx.tenantId, requete.sourceId);
    if (!source) return { ok: false, contenu: { erreur: 'ce connecteur n’est pas configuré' }, erreur: 'source introuvable' };
    /**
     * 🔴 Même garde que le résolveur MCP : la clé étrangère de `source_kind` ne couvre pas les lignes anciennes
     * (MATCH SIMPLE). Sans elle, une requête rattachée à un serveur MCP partirait en HTTP brut sur son point MCP,
     * avec le secret du client.
     */
    if (source.kind !== 'http') {
      return { ok: false, contenu: { erreur: 'ce connecteur n’est pas un système HTTP' }, erreur: `source kind=${source.kind}` };
    }
    if (source.status !== 'active') {
      return { ok: false, contenu: { erreur: 'ce connecteur n’est pas actif' }, erreur: `source ${source.status}` };
    }

    // 4. Les valeurs. Celles du modèle viennent de `args`, déjà validées ; les autres sont calculées ici,
    // paresseusement (dernière saisie et fuseau seulement si une variable les réclame).
    const besoin = (t: string, c?: string): boolean =>
      requete.variables.some((v) => v.origine.type === t && (c === undefined || (v.origine as { cle?: string }).cle === c));
    // Champs personnalisés lus défensivement dans la projection : absents, les variables `champ` valent
    // `null` (refus si elles sont requises), jamais une valeur inventée.
    const brutChamps = ctx.contact ? (ctx.contact as { champs?: unknown }).champs : null;
    const champs = brutChamps !== null && typeof brutChamps === 'object' && !Array.isArray(brutChamps)
      ? (brutChamps as Record<string, unknown>) : null;
    const derniereSaisie = besoin('systeme', 'derniere_saisie') && deps.inbox
      ? await deps.inbox.derniereSaisieDuContact(ctx.tenantId, ctx.waId) : null;
    // Le fuseau ne sert qu'à « maintenant ». Sans dépendance, UTC, dit dans la valeur (`+00:00`).
    const fuseau = besoin('systeme', 'maintenant') && deps.fuseau ? await deps.fuseau(ctx.tenantId) : 'UTC';

    const contexte = {
      waId: ctx.waId, contact: ctx.contact, champs, derniereSaisie,
      maintenant: deps.now ? deps.now() : new Date(), fuseau,
    };
    const valeurs: Record<string, ValeurResolue> = {};
    for (const v of requete.variables) {
      valeurs[v.nom] = v.origine.type === 'modele'
        ? ((args[v.nom] ?? null) as ValeurResolue)
        : resoudreVariable(v.origine, contexte);
    }

    // 4bis. Les variables obligatoires. Sans l'identifiant, « les commandes de ce contact » interroge la
    // mauvaise ressource, ou toutes. C'est `requis` qui tranche, réglé par le client requête par requête.
    const absentes = requete.variables.filter((v) => v.requis === true && (valeurs[v.nom] === null || valeurs[v.nom] === undefined));
    if (absentes.length > 0) {
      const noms = absentes.map((v) => v.nom).sort().join(', ');
      return {
        ok: false,
        // Le message parle de l'information manquante, que le modèle peut dire au contact, pas de la
        // configuration.
        contenu: { erreur: `information manquante pour interroger le système du client : ${noms}` },
        erreur: `variables requises absentes : ${noms}`,
      };
    }

    // 5. L'assemblage, point de passage partagé avec le bouton « Test » de la console.
    const appel = assemblerAppel({
      baseUrl: source.baseUrl, methode: requete.methode, chemin: requete.chemin,
      parametres: requete.parametres, entetes: requete.entetes, corps: requete.corps,
      valeurs, construireCible,
    });
    if (!appel.ok) return { ok: false, contenu: { erreur: 'ce connecteur est mal configuré' }, erreur: appel.raison };

    // 5bis. 🔴 Où ce nom mène-t-il vraiment ? `construireCible` lit le texte de l'hôte, et ne peut rien contre
    // un nom public qui résout vers les métadonnées du fournisseur ou le réseau Docker du VPS. Vérifié sur
    // l'URL finale, après l'assemblage.
    const resolution = await estPublique(appel.url);
    if (!resolution.ok) {
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, false, 'adresse interne').catch(() => {});
      return { ok: false, contenu: { erreur: MESSAGES.interne }, erreur: `resolution_interne: ${resolution.raison ?? '?'}` };
    }

    // 6. L'appel. Le secret n'existe que dans cet objet d'en-têtes. 🔴 L'authentification est superposée en
    // dernier : aucun en-tête saisi ne peut la recouvrir.
    const headers = { ...appel.entetes, ...enTetesAuthSource(source) };

    let res: Response;
    try {
      res = await appeler(appel.url, {
        method: appel.methode,
        headers,
        ...(appel.corps !== null ? { body: appel.corps } : {}),
        redirect: 'error',
        signal,
      });
    } catch (err) {
      // Panne réseau, DNS, échéance ou redirection refusée : l'échec est noté sur la source, pour qu'un
      // connecteur mort se voie dans la console. Un refus à la connexion (DNS rebinding, fermé par `fetchPublic`)
      // rend le même verdict que la vérification préalable : même cause.
      if (estRefusAdresseInterne(err)) {
        await deps.sources.marquerEpreuve(ctx.tenantId, source.id, false, 'adresse interne').catch(() => {});
        return { ok: false, contenu: { erreur: MESSAGES.interne }, erreur: 'connexion_interne' };
      }
      const redirige = estRedirectionRefusee(err);
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, false, redirige ? 'redirection refusée' : 'injoignable').catch(() => {});
      const cle = redirige ? 'redirige' : 'indispo';
      return { ok: false, contenu: { erreur: MESSAGES[cle] }, erreur: cle };
    }

    // Certaines implémentations de `fetch` rendent la redirection au lieu de lever : on la refuse aussi ici.
    if (res.status >= 300 && res.status < 400) {
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, false, 'redirection refusée').catch(() => {});
      return { ok: false, contenu: { erreur: MESSAGES.redirige }, erreur: 'redirige', httpStatus: res.status };
    }

    // 7. Le corps, lu en flux et borné sur ce qu'on a lu (pas `content-length`, qui peut mentir), en octets.
    // Au-delà, refus plutôt que troncature : un JSON tronqué est illisible.
    const corps = await lireCorpsBorne(res, outil.maxBytes);
    if (corps.trop_gros) {
      return { ok: false, contenu: { erreur: MESSAGES.trop_gros }, erreur: 'trop_gros', httpStatus: res.status };
    }
    /**
     * Un flux coupé n'est pas un corps vide : sans ce cas, le `catch` de l'étape 9 marquerait saine une source
     * dont la connexion lâche à chaque appel.
     */
    if (corps.casse) {
      // Marquée en échec, comme « injoignable » et « redirection refusée ».
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, false, 'réponse interrompue').catch(() => {});
      // Clé de journal distincte d'`illisible` : une coupure de connexion n'est pas un JSON invalide.
      return { ok: false, contenu: { erreur: MESSAGES.coupe }, erreur: 'coupe', httpStatus: res.status };
    }
    const brut = corps.texte;

    // 8. Le statut. Un 4xx ou 5xx est un échec métier : le modèle le sait, sans le corps brut de l'erreur
    // (chemins internes, parfois des identifiants).
    if (!res.ok) {
      const authentification = res.status === 401 || res.status === 403;
      // Un 4xx est une réponse du système du client : la source reste saine, sauf refus d'authentification, le
      // symptôme d'un jeton mort.
      const sourceSaine = res.status >= 400 && res.status < 500 && !authentification;
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, sourceSaine, authentification ? 'authentification refusée' : `HTTP ${res.status}`).catch(() => {});
      return {
        ok: false,
        contenu: { erreur: authentification ? MESSAGES.auth : MESSAGES.indispo },
        erreur: authentification ? 'auth' : `http_${res.status}`,
        httpStatus: res.status,
      };
    }

    /**
     * 9bis. 🔴 Un appel qui pousse ne lit pas le corps : la réponse d'un succès porte souvent la ressource
     * entière (fiche, e-mail, identifiants), qu'aucune raison n'autorise à partir chez le fournisseur du
     * modèle. On rend le verdict seul ; un échec est déjà traité à l'étape 8, avec son message sûr.
     */
    if (p.lecture.nature === 'pousse') {
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, true).catch(() => {});
      return { contenu: { ok: true, statut: res.status }, httpStatus: res.status };
    }

    // 9ter. La réponse entière (relais du MBA), déjà bornée par la lecture en flux. Un corps vide vaut `null`,
    // un corps non JSON est rendu en texte : ni l'un ni l'autre n'est un échec.
    if (p.lecture.nature === 'entier') {
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, true).catch(() => {});
      let reponse: unknown = null;
      if (brut !== '') {
        try { reponse = JSON.parse(brut) as unknown; } catch { reponse = brut; }
      }
      return { contenu: { reponse }, httpStatus: res.status };
    }

    // 9. Le filtre. Ce qui repart au modèle est exactement ce que le client a listé, et rien d'autre.
    let json: unknown;
    try {
      json = JSON.parse(brut) as unknown;
    } catch {
      await deps.sources.marquerEpreuve(ctx.tenantId, source.id, true).catch(() => {});
      return { ok: false, contenu: { erreur: MESSAGES.illisible }, erreur: 'illisible', httpStatus: res.status };
    }
    const contenu: Record<string, unknown> = {};
    for (const chemin of champsLus) {
      const v = extraire(json, chemin);
      if (v !== undefined) contenu[chemin] = v;
    }
    await deps.sources.marquerEpreuve(ctx.tenantId, source.id, true).catch(() => {});
    return { contenu, httpStatus: res.status };
  });
}

/** Le résolveur d'outil d'agent : un adaptateur au-dessus de `creerAppelConnecteur`, qui porte toutes les
 *  gardes. */
export function creerResolveurHttp(deps: DepsResolveurHttp): ResolveurOutil {
  const appel = creerAppelConnecteur(deps);
  return async (entree: EntreeResolveur): Promise<SortieResolveur> => appel({
    tenantId: entree.ctx.tenantId,
    waId: entree.ctx.waId,
    contact: entree.ctx.contact,
    requestId: typeof entree.outil.requestId === 'string' ? entree.outil.requestId : '',
    maxBytes: entree.outil.maxBytes,
    /** Ce que cet agent a le droit de lire est une propriété de son outil, pas de l'appel partagé. */
    lecture: entree.outil.nature === 'pousse'
      ? { nature: 'pousse' }
      : { nature: 'integre', champs: entree.outil.outputPaths },
    args: entree.args,
    signal: entree.signal,
    // `null` : l'exécuteur d'agent journalise déjà autour de ce résolveur, une seconde ligne compterait deux
    // fois le même appel.
    journal: null,
  });
}
