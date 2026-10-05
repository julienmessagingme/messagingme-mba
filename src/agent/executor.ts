import { z } from 'zod';
import type { Geste } from './gestes';
import type { JournalAppels, OrigineOutil, OutilDefini, StatutAppel, ToolCatalog } from './catalog';
import type { ParamOutil } from './llm/tool-schema';
import { paramsEffectifs } from './outils-maison';
import { completerArguments } from './completer-arguments';
import { tenter } from '../lib/tenter';
import { messageDe, texteDe } from '../lib/erreur';

/**
 * Le tronc commun d'exécution d'un outil : huit étapes dans l'ordre, chacune étant une garde.
 *
 * `executeTool` ne lève jamais sur un cas métier : une exception tue le tour, alors que le modèle sait se
 * corriger sur une erreur d'exécution rendue comme résultat (même principe que `isError: true` en MCP). Seule
 * une erreur de protocole (bug de notre client) remonte, avec `fatal`, pour arrêter le tour.
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
   * La fiche contact, ou `null` quand le contact est inconnu. Lue une fois par tour par l'appelant : elle sert
   * à l'autorisation (étape 2) et à l'injection (étape 4). Une projection bornée, pas la ligne de base :
   * `mba_lire_contact` la rend au modèle, donc au fournisseur.
   */
  contact: Record<string, unknown> | null;
  /** Politique de l'agent face à un contact inconnu (`agents.contact_inconnu`). */
  contactInconnu: 'aucun_outil' | 'lecture_seule' | 'tous';
  /** Appels d'outils encore autorisés dans cette session (plafond de la fiche moins les appels déjà faits). */
  appelsRestants: number;
  /** Budget restant, en micro-euros. */
  budgetRestantMicroEur: number;
  /** Échéance dure du tour (epoch ms). Le délai d'un outil ne la dépasse jamais. */
  deadline: number;
}

export interface EntreeResolveur {
  outil: OutilDefini;
  /** Arguments complets : ceux du modèle, validés, plus les valeurs injectées par le runtime. */
  args: Record<string, unknown>;
  ctx: ContexteAppel;
  /** Déclenché à l'échéance. Un résolveur qui l'ignore est quand même coupé par la course de l'étape 6. */
  signal: AbortSignal;
}

export interface SortieResolveur {
  /** Ce qui repart au modèle, tel quel une fois borné : un résolveur qui lit une réponse distante la filtre lui-même. */
  contenu: unknown;
  /** `false` = échec métier de l'outil (statut `erreur_outil`) : le modèle doit le savoir et peut réessayer. */
  ok?: boolean;
  httpStatus?: number;
  erreur?: string;
  /** L'outil demande de sortir du bloc agent par ce handle (`mba_terminer`). */
  sortie?: string;
  /**
   * Avec `sortie` seulement (`mba_terminer`) : le dernier message au contact, rogné, absent s'il est vide. Le
   * cerveau ne l'envoie que si la réponse qui porte l'appel n'a pas de texte.
   */
  dernierMessage?: string;
  /** L'outil a déjà rendu la main (escalade humaine) : le tour s'arrête, sans envoi ni autre sortie. */
  rendu?: boolean;
  /** Avec `rendu` seulement : c'est cet appel qui a pris la main, pas quelqu'un d'autre avant lui. Le tour
   *  s'en sert pour savoir s'il peut écrire une dernière phrase. */
  mainPrise?: boolean;
}

export type ResolveurOutil = (entree: EntreeResolveur) => Promise<SortieResolveur>;

export interface ResultatOutil {
  status: StatutAppel;
  /** Ce qui repart au modèle. Toujours présent, y compris sur un refus : c'est ce qui lui permet de se corriger. */
  contenu: unknown;
  sortie?: string;
  /** Voir `SortieResolveur.dernierMessage`. */
  dernierMessage?: string;
  rendu?: boolean;
  /** Voir `SortieResolveur.mainPrise`. */
  mainPrise?: boolean;
  /**
   * Erreur de protocole : bug de notre client, le tour s'arrête et on n'en reparle pas au modèle. L'alerte est
   * du ressort de l'appelant (le canal d'alerte est une dep du worker) : le tour alerte sur `fatal: true`.
   */
  fatal?: boolean;
}

export interface ToolExecutorDeps {
  catalogue: ToolCatalog;
  journal: JournalAppels;
  /** Un résolveur par origine. Origine sans résolveur -> refus propre, jamais une exception. */
  resolveurs: Partial<Record<OrigineOutil, ResolveurOutil>>;
  /**
   * 🔴 Incrémente le compteur d'appels de la session. Obligatoire : c'est un plafond de dépense, et un
   * paramètre optionnel pourrait être oublié au câblage, en silence.
   */
  sessions: { compterAppel(tenantId: string, sessionId: string): Promise<void> };
  /**
   * Exécute un geste du moment : poser un tag, écrire une valeur sur le contact. Obligatoire, pour la même
   * raison que `sessions.compterAppel`. Ne doit pas lever : un effet de bord manqué ne vaut pas une conversation morte.
   */
  executerGeste(tenantId: string, waId: string, geste: Geste): Promise<void>;
  now?: () => number;
}

/** Longueur maximale d'une valeur textuelle dans le journal. Le journal sert à instruire un incident, pas à
 *  archiver une réponse : le corps utile est ailleurs. */
const REDACTION_MAX = 200;

/** Le schéma de validation, depuis les seuls paramètres que le modèle remplit. `z.object` retire les clés
 *  inconnues : un `wa_id` envoyé par le modèle disparaît avant l'injection (première ceinture ; la seconde
 *  est l'ordre d'écriture de l'étape 4). */
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
    // rempli. Les `null` sont retirés juste après la validation.
    if (!p.required) s = s.nullish();
    shape[p.name] = s;
  }
  return z.object(shape);
}

/** Valeurs textuelles raccourcies pour le journal. Les valeurs injectées n'y entrent jamais : on journalise
 *  ce que le modèle a demandé. Entrée `unknown` : elle vient du JSON du modèle. */
export function rediger(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    out[k] = typeof v === 'string' && v.length > REDACTION_MAX ? `${v.slice(0, REDACTION_MAX)}...` : v;
  }
  return out;
}

/**
 * Borne la réponse à `max_bytes`, en rendant un aperçu marqué plutôt qu'une troncature silencieuse : le
 * modèle doit savoir qu'il ne voit pas tout. Comptée en octets, enveloppe comprise : c'est une ligne de
 * facturation directe.
 */
export function borner(valeur: unknown, maxBytes: number): { contenu: unknown; taille: number } {
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

/** Plafond du message d'exception écrit en journal (le distant peut l'écrire). Ce que reçoit le modèle est
 *  borné à part, par `max_bytes`. */
const MAX_RAISON_JOURNAL = 2000;

export async function executeTool(
  appel: { name: string; argumentsJson: string },
  ctx: ContexteAppel,
  deps: ToolExecutorDeps,
): Promise<ResultatOutil> {
  const maintenant = () => (deps.now ? deps.now() : Date.now());
  const debut = maintenant();

  // Journal best-effort dans les deux sens : un journal muet est un désagrément, un tour qui meurt pour une
  // insertion ratée est un incident.
  const ouvrirJournal = async (outil: OutilDefini | null, args: unknown): Promise<string | null> => {
    try {
      return await deps.journal.ouvrir({
        tenantId: ctx.tenantId,
        sessionId: ctx.sessionId,
        toolId: outil?.id ?? null,
        toolName: appel.name,
        origin: outil?.origin ?? 'inconnu',
        argsRediges: args,
        // Le chemin de l'agent ; les autres appelants de `creerAppelConnecteur` journalisent depuis leur module.
        source: 'agent',
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('journal d appel d outil ignoré (best-effort):', messageDe(err));
      return null;
    }
  };
  const clore = async (
    id: string | null,
    status: StatutAppel,
    extra: { httpStatus?: number; tailleReponse?: number; erreur?: string } = {},
  ): Promise<void> => {
    if (!id) return;
    await tenter('clôture de journal ignorée (best-effort):', () => deps.journal.clore({ tenantId: ctx.tenantId, id, status, dureeMs: maintenant() - debut, ...extra }));
  };
  /**
   * Un refus est journalisé avec ce que le modèle demandait : la trace d'une tentative d'IDOR. Arguments relus
   * défensivement (on refuse parfois avant de les avoir analysés) : illisibles, on garde le brut tronqué.
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

  // 1. Résoudre. Un nom inconnu ou un outil éteint n'est pas une exception : le modèle se corrige s'il sait
  // pourquoi. La lecture elle-même est gardée, sinon une panne du pooler tuerait le tour.
  let outil: OutilDefini | null;
  try {
    outil = await deps.catalogue.byName(ctx.tenantId, ctx.agentId, appel.name);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`agent: catalogue injoignable pour l'outil ${appel.name}:`, messageDe(err));
    return refuser(null, 'erreur_outil', 'catalogue temporairement indisponible, reessayez');
  }
  if (!outil) {
    return refuser(null, 'refuse', `outil inconnu ou desactive : ${appel.name}`);
  }

  // 2. Autoriser. Les plafonds d'abord : ils ne dépendent pas de l'outil.
  if (ctx.appelsRestants <= 0) {
    return refuser(outil, 'budget', 'plafond d appels d outils atteint pour cette conversation');
  }
  if (ctx.budgetRestantMicroEur <= 0) {
    return refuser(outil, 'budget', 'budget epuise pour cette conversation');
  }
  // L'autonomie sur une action irréversible est un réglage du client, outil par outil.
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

  // 3. Valider. `safeParse` : les arguments viennent du modèle, source non fiable. Contre les paramètres que le
  // modèle a vus (`paramsEffectifs`, imposés du catalogue compris) : la seule copie en base ferait retirer par
  // `z.object` un argument annoncé, en silence.
  const params = paramsEffectifs(outil);
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
  // Un facultatif à `null` vaut « non fourni » : gardé, il passerait au résolveur là où il attend une
  // absence, et occuperait la place d'une valeur injectée pour un paramètre déclaré deux fois.
  const argsModele: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parse.data)) {
    if (v !== null && v !== undefined) argsModele[k] = v;
  }

  // 4. Compléter. 🔴 C'est ici que le modèle perd la main sur la cible : l'injection écrit en dernier, après
  // les arguments du modèle (`completerArguments`, partagé avec le relais de l'agent de Meta).
  const args = completerArguments(params, argsModele, ctx);

  // 5. Journaliser avant l'appel, jamais après (raison sur `JournalAppels.ouvrir`).
  const journalId = await ouvrirJournal(outil, rediger(argsModele));

  // 6. Appeler sous une échéance = min(délai de l'outil, échéance du tour). Le signal arrête un résolveur
  // poli, la course rend la main même s'il ne l'écoute pas.
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
    // Rien n'a été tenté : seule issue postérieure au journal qui ne compte pas d'appel.
    await clore(journalId, 'timeout', { erreur: 'echeance du tour deja depassee' });
    return { status: 'timeout', contenu: { erreur: 'delai depasse' } };
  }
  /**
   * Compte l'appel sur toute issue qui a atteint le résolveur, pas seulement un succès : un outil qui pend
   * ou qui rejette après un aller-retour réseau est justement le plus cher.
   */
  const compter = async (): Promise<void> => {
    await tenter('compteur d appels d outils ignoré (best-effort):', () => deps.sessions.compterAppel(ctx.tenantId, ctx.sessionId));
  };
  /**
   * Les gestes du moment, exécutés ici. Avant l'appel, donc indépendants de sa réussite : un geste marque que
   * la situation s'est produite, et le placer après obligerait à le répéter sur chaque issue de la course.
   * Après les gardes : un appel refusé est un appel que l'agent n'a pas fait. Un geste qui échoue est
   * journalisé, le tour continue.
   */
  for (const geste of outil.gestes) {
    try {
      await deps.executerGeste(ctx.tenantId, ctx.waId, geste);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`geste ${geste.type} ignoré (best-effort) sur l'outil ${outil.name}:`, messageDe(err));
    }
  }

  const controleur = new AbortController();
  let minuteur: ReturnType<typeof setTimeout> | undefined;
  let sortie: SortieResolveur;
  try {
    const echeance = new Promise<typeof ECHEANCE>((resolve) => {
      // Ordre : on tranche la course avant d'abandonner. `abort()` déclenche ses écouteurs de façon synchrone,
      // et un résolveur qui se termine sur son signal glisserait sinon un résultat tardif après l'échéance.
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
    // Un résolveur qui lève est un cas nominal : le modèle reçoit la raison et peut se corriger. Ce message peut
    // être écrit par le distant : il est borné ici comme à l'étape 7, sans dépendre de la discipline de chaque
    // résolveur.
    const raison = texteDe(err);
    const { contenu: borne } = borner({ erreur: raison }, outil.maxBytes);
    await clore(journalId, 'erreur_outil', { erreur: raison.slice(0, MAX_RAISON_JOURNAL) });
    await compter();
    return { status: 'erreur_outil', contenu: borne };
  } finally {
    if (minuteur) clearTimeout(minuteur);
  }

  // 7. Assainir : borne de taille (une ligne de facturation directe). L'encadrement en bloc délimité est fait par
  // l'appelant, sur `ResultatOutil.contenu` : l'encadrer deux fois serait pire.
  /**
   * 🔴 Pas de filtre par `outputPaths` ici. Il est fait par le résolveur, le seul à lire la réponse brute
   * (`creerAppelConnecteur`, étape 9), qui rend des clés À PLAT portant le chemin entier. Refiltrer ici en
   * descendant dans l'objet jetait tout champ imbriqué, l'enveloppe d'un échec et celle du bac à sable, sans
   * erreur (2026-10-05). Un outil MCP rend du texte, un outil maison ne déclare aucun chemin.
   */
  const { contenu, taille } = borner(sortie.contenu, outil.maxBytes);

  // 8. Clore : statut, durée, taille, et compteur de session.
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
    ...(sortie.dernierMessage ? { dernierMessage: sortie.dernierMessage } : {}),
    ...(sortie.rendu ? { rendu: true } : {}),
    ...(sortie.mainPrise ? { mainPrise: true } : {}),
  };
}
