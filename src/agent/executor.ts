import { z } from 'zod';
import type { JournalAppels, OrigineOutil, OutilDefini, StatutAppel, ToolCatalog } from './catalog';
import { paramsOutil, type ParamOutil } from './llm/tool-schema';
import { champDuContact } from './champs-contact';

/**
 * Le tronc commun d'exécution d'un outil : les huit étapes du §3.3 du cadrage, dans l'ordre, chacune étant
 * une garde.
 *
 * 🔴 RÈGLE CENTRALE : `executeTool` NE LÈVE JAMAIS sur un cas métier. Une exception qui remonte tue le tour,
 * alors que le modèle sait se corriger sur une erreur d'exécution : c'est la leçon directe de hyundai, où un
 * slug inconnu renvoie `{ erreur: "slug inconnu, utilise un slug du catalogue" }` et où le modèle se rattrape
 * seul. La spec MCP le pose d'ailleurs par le même mécanisme (`isError: true` est un résultat, pas une
 * erreur). Seule exception : une erreur de PROTOCOLE, qui est un bug de notre client, et qui remonte avec
 * `fatal` pour arrêter le tour.
 */

/** Ce que le tour sait de la conversation en cours, et que chaque appel d'outil doit connaître. */
export interface ContexteAppel {
  tenantId: string;
  agentId: string;
  sessionId: string;
  runId: string;
  workflowId: string;
  waId: string;
  /**
   * La fiche contact, ou `null` quand le contact est INCONNU. Lue une fois par tour par l'appelant, pas une
   * fois par appel : elle sert à deux choses ici, l'autorisation (étape 2) et l'injection (étape 4).
   *
   * ⚠️ C'est une PROJECTION, bornée par l'appelant, pas la ligne de base. L'outil maison `mba_lire_contact`
   * la rend telle quelle au modèle, donc au fournisseur : y verser une ligne brute enverrait chez lui des
   * champs que personne n'a décidé de partager.
   */
  contact: Record<string, unknown> | null;
  /** Politique de l'agent face à un contact inconnu (`agents.contact_inconnu`). */
  contactInconnu: 'aucun_outil' | 'lecture_seule' | 'tous';
  /** Appels d'outils encore autorisés dans cette session (plafond de la fiche moins les appels déjà faits). */
  appelsRestants: number;
  /** Budget restant, en micro-euros. */
  budgetRestantMicroEur: number;
  /** Échéance DURE du tour (epoch ms). Le délai d'un outil ne la dépasse jamais. */
  deadline: number;
}

export interface EntreeResolveur {
  outil: OutilDefini;
  /** Arguments COMPLETS : ceux du modèle, validés, plus les valeurs injectées par le runtime. */
  args: Record<string, unknown>;
  ctx: ContexteAppel;
  /** Déclenché à l'échéance. Un résolveur qui l'ignore est quand même coupé par la course de l'étape 6. */
  signal: AbortSignal;
}

export interface SortieResolveur {
  /** Ce qui repart au modèle. */
  contenu: unknown;
  /** `false` = échec MÉTIER de l'outil (statut `erreur_outil`) : le modèle doit le savoir et peut réessayer. */
  ok?: boolean;
  httpStatus?: number;
  erreur?: string;
  /** L'outil demande de SORTIR du bloc agent par ce handle (`mba_terminer`). */
  sortie?: string;
  /** L'outil a DÉJÀ rendu la main (escalade humaine) : le tour s'arrête, sans envoi ni autre sortie. */
  rendu?: boolean;
}

export type ResolveurOutil = (entree: EntreeResolveur) => Promise<SortieResolveur>;

export interface ResultatOutil {
  status: StatutAppel;
  /** Ce qui repart au modèle. Toujours présent, y compris sur un refus : c'est ce qui lui permet de se corriger. */
  contenu: unknown;
  sortie?: string;
  rendu?: boolean;
  /**
   * Erreur de PROTOCOLE : bug de notre client, le tour s'arrête et on n'en reparle pas au modèle.
   *
   * ⚠️ L'ALERTE est du ressort de l'APPELANT. Ce module journalise (`erreur_protocole` en base et une trace
   * serveur) mais n'alerte pas lui-même : le canal d'alerte est une dep du worker (`src/worker.ts`), et
   * l'ajouter ici ferait descendre le worker dans une fonction qui doit rester appelable sans lui. Le tour
   * doit donc alerter sur `fatal: true`.
   */
  fatal?: boolean;
}

export interface ToolExecutorDeps {
  catalogue: ToolCatalog;
  journal: JournalAppels;
  /** Un résolveur par origine. Origine sans résolveur -> refus propre, jamais une exception. */
  resolveurs: Partial<Record<OrigineOutil, ResolveurOutil>>;
  /**
   * Incrémente le compteur d'appels de la session. OBLIGATOIRE, contrairement aux autres deps du repo : c'est
   * un plafond de DÉPENSE, et la seule façon de le désarmer serait de ne pas le câbler, en silence. Un
   * paramètre obligatoire fait poser la question au câblage plutôt qu'à la facture.
   */
  compterAppel(tenantId: string, sessionId: string): Promise<void>;
  now?: () => number;
}

/** Longueur maximale d'une valeur textuelle dans le journal. Le journal sert à instruire un incident, pas à
 *  archiver une réponse : le corps utile est ailleurs. */
const REDACTION_MAX = 200;

/** Construit le schéma de validation depuis les SEULS paramètres que le modèle remplit.
 *
 * 🔴 `z.object` RETIRE les clés inconnues (comportement par défaut, conservé en Zod 4). C'est la première des
 * deux ceintures contre l'écrasement d'une valeur injectée : un `wa_id` envoyé par le modèle n'est pas dans
 * ce schéma, il disparaît donc avant même qu'on parle d'injection. La seconde ceinture est l'ordre d'écriture
 * de l'étape 4. */
function schemaArguments(params: ParamOutil[]): z.ZodObject {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of params) {
    let s: z.ZodTypeAny = p.type === 'string' && p.enum && p.enum.length > 0
      ? z.enum(p.enum as [string, ...string[]])
      : p.type === 'string' ? z.string()
        : p.type === 'integer' ? z.number().int()
          : p.type === 'number' ? z.number()
            : z.boolean();
    // `nullish` et non `optional` : plusieurs fournisseurs émettent `null` pour un paramètre facultatif non
    // rempli. Le refuser brûlerait un aller-retour de modèle sur une convention, pas sur une erreur. Les
    // `null` sont retirés juste après la validation.
    if (!p.required) s = s.nullish();
    shape[p.name] = s;
  }
  return z.object(shape);
}

/** Valeurs textuelles raccourcies pour le journal. Les valeurs INJECTÉES n'entrent jamais ici : on journalise
 *  ce que le modèle a demandé, pas ce que le runtime a complété.
 *
 *  L'entrée est `unknown` et non `Record` : elle vient du JSON du modèle, et l'affirmer par un `as` serait un
 *  mensonge au compilateur sur un payload externe. */
function rediger(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    out[k] = typeof v === 'string' && v.length > REDACTION_MAX ? `${v.slice(0, REDACTION_MAX)}...` : v;
  }
  return out;
}

/** Extraction par `output_paths`. Aucun chemin -> la réponse entière (bornée juste après). Un chemin absent
 *  est simplement omis : rendre `undefined` au modèle serait du bruit qu'il paierait à chaque tour. */
function extraire(valeur: unknown, chemins: string[]): unknown {
  if (chemins.length === 0) return valeur;
  const out: Record<string, unknown> = {};
  for (const chemin of chemins) {
    let courant: unknown = valeur;
    for (const cle of chemin.split('.')) {
      courant = courant && typeof courant === 'object' ? (courant as Record<string, unknown>)[cle] : undefined;
      if (courant === undefined) break;
    }
    if (courant !== undefined) out[chemin] = courant;
  }
  return out;
}

/**
 * Borne la réponse à `max_bytes`. Au-delà, on rend un aperçu MARQUÉ plutôt que de tronquer en silence : le
 * modèle doit savoir qu'il ne voit pas tout, sinon il conclut sur une réponse coupée.
 *
 * La borne est comptée en OCTETS et couvre l'enveloppe : `slice` découpe en caractères, un accent en coûte
 * deux, et `{"tronque":true,"apercu":"..."}` en ajoute une trentaine. Sans ces deux corrections, la sortie
 * réelle dépassait le plafond que le client a réglé, et ce plafond est une ligne de facturation directe.
 */
function borner(valeur: unknown, maxBytes: number): { contenu: unknown; taille: number } {
  let json: string;
  try {
    json = JSON.stringify(valeur ?? null) ?? 'null';
  } catch {
    return { contenu: { erreur: 'reponse non serialisable' }, taille: 0 };
  }
  const taille = Buffer.byteLength(json, 'utf8');
  if (taille <= maxBytes) return { contenu: valeur, taille };
  const enveloppe = Buffer.byteLength(JSON.stringify({ tronque: true, apercu: '' }), 'utf8');
  let apercu = json.slice(0, Math.max(0, maxBytes - enveloppe));
  // Les échappements JSON d'un aperçu (guillemets, accents) peuvent encore le faire déborder : on rogne
  // jusqu'à ce que la sortie tienne vraiment. La boucle termine, `apercu` décroît strictement.
  while (apercu.length > 0
    && Buffer.byteLength(JSON.stringify({ tronque: true, apercu }), 'utf8') > maxBytes) {
    apercu = apercu.slice(0, Math.floor(apercu.length * 0.9));
  }
  return { contenu: { tronque: true, apercu }, taille };
}

/** Sentinelle de la course de l'étape 6. Un résolveur qui ignore son `AbortSignal` est coupé quand même. */
const ECHEANCE = Symbol('echeance');

/** Plafond du message d'exception ÉCRIT EN JOURNAL. Le distant peut l'écrire, et une ligne de journal n'a pas
 *  à porter son corps de réponse entier. Ce que reçoit le modèle est borné à part, par `max_bytes`. */
const MAX_RAISON_JOURNAL = 2000;

export async function executeTool(
  appel: { name: string; argumentsJson: string },
  ctx: ContexteAppel,
  deps: ToolExecutorDeps,
): Promise<ResultatOutil> {
  const maintenant = () => (deps.now ? deps.now() : Date.now());
  const debut = maintenant();

  // Journal BEST-EFFORT dans les deux sens : un journal muet est un désagrément, un tour qui meurt parce
  // qu'une insertion a trébuché est un incident. Même doctrine que `mesurer` dans l'exécuteur de scénario.
  const ouvrirJournal = async (outil: OutilDefini | null, args: unknown): Promise<string | null> => {
    try {
      return await deps.journal.ouvrir({
        tenantId: ctx.tenantId,
        sessionId: ctx.sessionId,
        toolId: outil?.id ?? null,
        toolName: appel.name,
        origin: outil?.origin ?? 'inconnu',
        argsRediges: args,
        // C'est le chemin de l'AGENT, et c'est le seul de cet exécuteur : les deux autres appelants de
        // `creerAppelConnecteur` (le bloc HTTP d'un scénario, la poussée d'un opt-out) journalisent depuis
        // leur propre module, avec leur propre source.
        source: 'agent',
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('journal d appel d outil ignoré (best-effort):', err instanceof Error ? err.message : err);
      return null;
    }
  };
  const clore = async (
    id: string | null,
    status: StatutAppel,
    extra: { httpStatus?: number; tailleReponse?: number; erreur?: string } = {},
  ): Promise<void> => {
    if (!id) return;
    try {
      await deps.journal.clore({ tenantId: ctx.tenantId, id, status, dureeMs: maintenant() - debut, ...extra });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('clôture de journal ignorée (best-effort):', err instanceof Error ? err.message : err);
    }
  };
  /**
   * Un refus est journalisé comme tout le reste, AVEC ce que le modèle demandait : c'est exactement la trace
   * qu'on voudra en instruisant une tentative d'IDOR sur un outil irréversible. Les arguments sont relus
   * défensivement (on refuse parfois AVANT de les avoir analysés) : illisibles, on garde le brut tronqué.
   */
  const refuser = async (outil: OutilDefini | null, status: StatutAppel, raison: string): Promise<ResultatOutil> => {
    let vus: unknown;
    try {
      vus = rediger(JSON.parse(appel.argumentsJson || '{}'));
    } catch {
      vus = { brut: appel.argumentsJson.slice(0, REDACTION_MAX) };
    }
    const id = await ouvrirJournal(outil, vus);
    await clore(id, status, { erreur: raison });
    return { status, contenu: { erreur: raison } };
  };

  // 1. RÉSOUDRE. Un nom inconnu ou un outil éteint n'est PAS une exception : le modèle a halluciné un nom, il
  // se corrige au tour suivant s'il sait pourquoi.
  //
  // La lecture elle-même est gardée : une panne du pooler ne doit pas faire une exception de plus que le
  // journal, qui est déjà best-effort. Sans ce try, ce `select` était le SEUL `await` capable de tuer le tour,
  // et donc de faire mentir la règle centrale du module.
  let outil: OutilDefini | null;
  try {
    outil = await deps.catalogue.byName(ctx.tenantId, ctx.agentId, appel.name);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`agent: catalogue injoignable pour l'outil ${appel.name}:`, err instanceof Error ? err.message : err);
    return refuser(null, 'erreur_outil', 'catalogue temporairement indisponible, reessayez');
  }
  if (!outil) {
    return refuser(null, 'refuse', `outil inconnu ou desactive : ${appel.name}`);
  }

  // 2. AUTORISER. Les plafonds d'abord : ils ne dépendent pas de l'outil, et les évaluer avant évite de
  // valider des arguments qu'on ne servira pas.
  if (ctx.appelsRestants <= 0) {
    return refuser(outil, 'budget', 'plafond d appels d outils atteint pour cette conversation');
  }
  if (ctx.budgetRestantMicroEur <= 0) {
    return refuser(outil, 'budget', 'budget epuise pour cette conversation');
  }
  // L'autonomie sur une action irréversible est un réglage du CLIENT, outil par outil (tranché le
  // 2026-08-26). Non cochée, l'agent ne l'exécute pas seul.
  if (outil.risk === 'irreversible' && !outil.autonome) {
    return refuser(outil, 'refuse', 'action irreversible non autorisee en autonomie pour cet outil');
  }
  if (ctx.contact === null) {
    if (ctx.contactInconnu === 'aucun_outil') {
      return refuser(outil, 'refuse', 'contact inconnu : aucun outil autorise');
    }
    if (ctx.contactInconnu === 'lecture_seule' && outil.risk !== 'read') {
      return refuser(outil, 'refuse', 'contact inconnu : seuls les outils de lecture sont autorises');
    }
  }

  // 3. VALIDER. `safeParse`, jamais `parse` : les arguments viennent du modèle, donc d'une source non fiable.
  const params = paramsOutil(outil.params);
  const duModele = params.filter((p) => p.source === 'modele');
  let brut: unknown;
  try {
    brut = appel.argumentsJson.trim() === '' ? {} : JSON.parse(appel.argumentsJson);
  } catch {
    return refuser(outil, 'refuse', 'arguments illisibles : ce n est pas du JSON valide');
  }
  const parse = schemaArguments(duModele).safeParse(brut);
  if (!parse.success) {
    const detail = parse.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');
    return refuser(outil, 'refuse', `arguments invalides : ${detail}`);
  }
  // Un paramètre facultatif que le fournisseur rend à `null` vaut « non fourni ». Le garder ferait passer un
  // `null` explicite au résolveur là où il attend une absence, et surtout il occuperait la place d'une valeur
  // injectée pour un paramètre déclaré deux fois.
  const argsModele: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parse.data)) {
    if (v !== null && v !== undefined) argsModele[k] = v;
  }

  // 4. COMPLÉTER. 🔴 C'EST ICI QUE LE MODÈLE PERD LA MAIN SUR LA CIBLE. L'injection écrit EN DERNIER, après
  // les arguments du modèle : même si une clé injectée avait survécu à la validation (elle ne survit pas,
  // `z.object` la retire), elle serait écrasée ici par la valeur du runtime, jamais l'inverse. Sans cette
  // séparation, un connecteur client serait un IDOR offert au premier venu qui écrit sur le numéro.
  const args: Record<string, unknown> = { ...argsModele };
  for (const p of params) {
    if (p.source === 'contact') {
      const chemin = p.contactPath ?? p.name;
      // 🔴 LE NUMÉRO VIENT DU TOUR, PAS DE LA PROJECTION, et c'est la clé de voûte anti-IDOR d'un connecteur.
      // Un connecteur sert d'abord à répondre « où en est MA commande » : la ressource est identifiée par le
      // contact lui-même. Or la projection (`ctx.contact`) est bornée EXPRÈS et ne porte pas le numéro : elle
      // part chez le fournisseur de modèle, et y verser la ligne brute enverrait le numéro, le BSUID et
      // l'opt-in. Le lire là rendrait `null`, donc un appel de connecteur sans identifiant, c'est-à-dire sur
      // la mauvaise ressource ou sur aucune. `ctx.waId` est authentifié par la signature du webhook Meta.
      args[p.name] = chemin === 'wa_id' ? ctx.waId : (ctx.contact ? (ctx.contact[chemin] ?? null) : null);
    } else if (p.source === 'champ') {
      // 🔴 UN CHAMP PERSONNALISÉ DU CLIENT, ET LE MODÈLE NE SAIT MÊME PAS QU'IL EXISTE. C'est ce qui permet
      // de clouer un identifiant que le serveur distant attend (un e-mail, une référence client) à la fiche
      // du contact qui écrit, plutôt que de le laisser remplir par un texte que ce contact influence.
      // ⚠️ Un champ absent rend `null` et l'appel part quand même : le serveur décide. Refuser serait faux
      // pour un paramètre facultatif (décision de Julien du 2026-09-16).
      args[p.name] = champDuContact(ctx.contact, p.cle ?? '');
    } else if (p.source === 'fixe') {
      args[p.name] = p.value ?? null;
    }
  }

  // 5. JOURNALISER AVANT L'APPEL, jamais après. La raison est portée par `JournalAppels.ouvrir`.
  const journalId = await ouvrirJournal(outil, rediger(argsModele));

  // 6. APPELER, sous une échéance = min(délai de l'outil, échéance du tour). La course est doublée d'un
  // `AbortSignal` : le signal permet à un résolveur poli de s'arrêter, la course garantit qu'on rend la main
  // même s'il ne l'écoute pas.
  const resolveur = deps.resolveurs[outil.origin];
  if (!resolveur) {
    await clore(journalId, 'erreur_protocole', { erreur: `aucun resolveur pour l origine ${outil.origin}` });
    // eslint-disable-next-line no-console
    console.error(`agent: aucun résolveur pour l'origine ${outil.origin} (outil ${outil.name})`);
    return { status: 'erreur_protocole', contenu: null, fatal: true };
  }
  const restant = ctx.deadline - maintenant();
  const delai = Math.min(outil.timeoutMs, restant);
  if (delai <= 0) {
    // Rien n'a été tenté : c'est la seule issue postérieure au journal qui NE compte PAS d'appel.
    await clore(journalId, 'timeout', { erreur: 'echeance du tour deja depassee' });
    return { status: 'timeout', contenu: { erreur: 'delai depasse' } };
  }
  /**
   * Compte l'appel dans la session. Appelé sur TOUTE issue qui a ATTEINT le résolveur, pas seulement sur un
   * succès : un outil qui pend jusqu'à son délai et un outil qui rejette après un aller-retour réseau sont
   * justement les plus chers. Ne compter que les succès inverserait la garde décrite sur
   * `AgentSessionStore.compterAppel`.
   */
  const compter = async (): Promise<void> => {
    try {
      await deps.compterAppel(ctx.tenantId, ctx.sessionId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('compteur d appels d outils ignoré (best-effort):', err instanceof Error ? err.message : err);
    }
  };
  const controleur = new AbortController();
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  let sortie: SortieResolveur;
  try {
    const echeance = new Promise<typeof ECHEANCE>((resolve) => {
      // ⚠️ ORDRE : on tranche la course AVANT d'abandonner. `abort()` déclenche ses écouteurs de façon
      // SYNCHRONE, donc un résolveur qui se termine sur son signal résoudrait sa promesse en premier et
      // glisserait un résultat tardif après l'échéance. L'issue ne doit pas dépendre de la politesse du
      // résolveur.
      minuteur = setTimeout(() => { resolve(ECHEANCE); controleur.abort(); }, delai);
    });
    const course = await Promise.race([
      resolveur({ outil, args, ctx, signal: controleur.signal }),
      echeance,
    ]);
    if (course === ECHEANCE) {
      await clore(journalId, 'timeout', { erreur: `delai de ${delai} ms depasse` });
      await compter();
      return { status: 'timeout', contenu: { erreur: 'delai depasse, l outil n a pas repondu a temps' } };
    }
    sortie = course;
  } catch (err) {
    // Un résolveur qui LÈVE est un cas nominal ici : réseau coupé, réponse illisible, refus distant. Le
    // modèle reçoit la raison et peut se corriger, le tour continue.
    //
    // 🔴 MAIS CE MESSAGE PEUT ÊTRE ÉCRIT PAR LE DISTANT, et ce retour court-circuitait l'étape 7. Un
    // résolveur qui laisse remonter une erreur du serveur d'en face (une erreur JSON-RPC, un corps d'API
    // recopié dans un `Error`) faisait entrer ce texte dans le prompt SANS plafond de taille. Inoffensif tant
    // que les résolveurs attrapent tout eux-mêmes, ce qu'ils font aujourd'hui ; mais compter là-dessus, c'est
    // faire dépendre une garde du prompt de la discipline de chaque résolveur, y compris celui qu'on n'a pas
    // encore écrit. On borne donc ici, comme à l'étape 7.
    //
    // `extraire` n'est PAS appliqué : `output_paths` décrit la forme d'une réponse RÉUSSIE, la chercher dans
    // une enveloppe d'erreur ne rendrait jamais rien et effacerait la raison.
    const raison = err instanceof Error ? err.message : String(err);
    const { contenu: borne } = borner({ erreur: raison }, outil.maxBytes);
    await clore(journalId, 'erreur_outil', { erreur: raison.slice(0, MAX_RAISON_JOURNAL) });
    await compter();
    return { status: 'erreur_outil', contenu: borne };
  } finally {
    if (minuteur) clearTimeout(minuteur);
  }

  // 7. ASSAINIR : extraction par `output_paths` puis borne de taille. La sortie ne part JAMAIS entière quand
  // des chemins sont déclarés : c'est le consensus du marché, et c'est une ligne de facturation directe.
  //
  // ⚠️ L'ENCADREMENT EN BLOC DÉLIMITÉ, troisième volet de l'étape 7 au cadrage, n'est PAS fait ici : ce
  // module rend une VALEUR, et c'est le constructeur de prompt du tour qui la met en forme. L'encadrer deux
  // fois serait pire que pas du tout. La règle maison (une entrée non fiable entre dans un prompt par un bloc
  // délimité, jamais concaténée) s'applique donc à l'appelant, sur `ResultatOutil.contenu`.
  /**
   * 🔴 LE FILTRE PAR CHEMINS NE S'APPLIQUE PAS À UN OUTIL MCP, ET C'EST UNE GARDE, PAS UNE OPTIMISATION.
   * Un serveur MCP rend du TEXTE : il n'y a aucun chemin JSON à y choisir. Or `extraire` filtre la valeur
   * dès que `outputPaths` n'est pas vide, et rendrait donc `{}` à l'agent, sans erreur et sans trace.
   * C'est MOT POUR MOT le défaut que la migration 0150 a corrigé ailleurs (une liste vide qui rendait zéro
   * champ pendant que le bac à sable promettait « exactement ce que l'agent recevra »).
   *
   * ⚠️ POURQUOI ICI ET PAS À L'IMPORT. L'import écrit bien `outputPaths: []` sur un outil MCP, ce qui
   * suffirait aujourd'hui. Mais cette garantie-là vit trois fichiers plus loin et repose sur un seul
   * écrivain : une écriture SQL directe, ou un second chemin d'import ajouté un jour, la ferait sauter en
   * silence. L'invariant se tient au point de passage, là où le filtre s'applique.
   */
  const aFiltrer = outil.origin === 'mcp' ? sortie.contenu : extraire(sortie.contenu, outil.outputPaths);
  const { contenu, taille } = borner(aFiltrer, outil.maxBytes);

  // 8. CLORE : statut, durée, taille, et compteur de session.
  const status: StatutAppel = sortie.ok === false ? 'erreur_outil' : 'ok';
  await clore(journalId, status, {
    tailleReponse: taille,
    ...(sortie.httpStatus !== undefined ? { httpStatus: sortie.httpStatus } : {}),
    ...(sortie.erreur ? { erreur: sortie.erreur } : {}),
  });
  await compter();
  return {
    status,
    contenu,
    ...(sortie.sortie ? { sortie: sortie.sortie } : {}),
    ...(sortie.rendu ? { rendu: true } : {}),
  };
}
