import { creerAppelConnecteur, type DepsResolveurHttp } from '../agent/resolvers/http';
import type { JournalAppels } from '../agent/catalog';

/**
 * POUSSER UN REFUS VERS LE SYSTÈME DU CLIENT, au moment où il est déclaré.
 *
 * 🔴 CE QUI REND LE REFUS OPPOSABLE AILLEURS QUE CHEZ NOUS. Un opt-out qui ne vit que dans notre base laisse
 * le client continuer à écrire à cette personne depuis ses autres outils (son CRM, son back-office, son
 * routeur d'e-mails), et c'est LUI qui en répond. C'est la raison pour laquelle Julien a nommé les Tools en
 * demandant cette fonctionnalité le 2026-09-13.
 *
 * 🔴 L'APPEL NE BLOQUE JAMAIS L'ÉCRITURE DE L'OPT-OUT, ET L'ORDRE EST LA FONCTIONNALITÉ. On écrit
 * `opted_out` d'abord, on ANNONCE ensuite, et l'annonce n'est même pas l'appel : c'est une mise en file. Un
 * connecteur en panne, une source désactivée, un réseau coupé, une base de files indisponible : rien de tout
 * cela ne peut faire échouer le respect d'un refus, parce qu'au moment où ces choses peuvent rater, le refus
 * est déjà enregistré et la transaction est déjà validée. L'inverse serait exactement le manquement que le
 * centre de sécurité existe pour empêcher.
 *
 * ⚠️ IL N'Y A DONC PAS DE « on réessaie l'opt-out » : il n'a jamais échoué. Ce qui se réessaie, c'est l'appel,
 * et c'est pg-boss qui s'en charge (5 tentatives à intervalle croissant, puis la DLQ, visible de `/ops`).
 *
 * 🔴 LA POUSSÉE EST IDEMPOTENTE PAR NATURE, et c'est ce qui autorise le rejeu d'un lot entier. Elle ne
 * raconte pas un ÉVÉNEMENT (« untel vient de se désabonner »), elle déclare un ÉTAT (« untel est
 * désabonné »). Rejouer un lot dont trois contacts sur quatre étaient déjà passés ne fabrique donc aucune
 * incohérence chez le client : il repose un drapeau qui était déjà posé. Sans cette propriété, il aurait
 * fallu un suivi par contact, c'est-à-dire une table de plus pour un gain nul.
 */

/** La file. Déclarée ICI et importée par `names.ts` : le nom d'une file ne s'écrit qu'une fois. */
export const FILE_POUSSEE_OPTOUT = 'optout-poussee';

/**
 * Plafond de lecture de la réponse, en octets.
 *
 * ⚠️ PLUS BAS QUE CELUI D'UN BLOC DE SCÉNARIO (64 Ko) : personne ne LIT cette réponse. Le connecteur reçoit
 * une information, son accusé ne sert qu'à savoir si l'appel a abouti. Un plafond généreux ne servirait qu'à
 * charger en mémoire un corps que l'on jette.
 */
export const MAX_OCTETS_POUSSEE_OPTOUT = 16 * 1024;

/**
 * Combien de temps on attend le système du client.
 *
 * ⚠️ PLUS LONG QUE LE BLOC DE SCÉNARIO (10 s) : là-bas, un contact attend la suite de son parcours devant son
 * téléphone. Ici, personne n'attend, et abandonner tôt ne ferait qu'ajouter une tentative inutile à un
 * système lent mais sain.
 */
export const DELAI_POUSSEE_OPTOUT_MS = 20_000;

/**
 * Combien de refus voyagent dans UN job.
 *
 * 🔴 CE N'EST PAS UN PLAFOND, C'EST UN DÉCOUPAGE : rien n'est jamais écarté, `lotsDePoussee` rend tous les
 * lots. La distinction compte, parce qu'un plafond silencieux sur ce chemin-ci voudrait dire « on a cessé de
 * pousser des refus sans le dire à personne ».
 *
 * ⚠️ Une action en masse du mini-CRM peut désabonner des milliers de personnes d'un geste. Un job par
 * contact ferait des milliers d'insertions AVANT que la requête HTTP ne rende la main (l'annonce est
 * attendue, cf. `creerAnnonceOptOut`) ; un job unique porterait un payload de plusieurs centaines de kilo-
 * octets et rejouerait tout le lot sur un seul échec. Deux cents est le compromis.
 */
export const TAILLE_LOT_POUSSEE = 200;

/** Le job : un espace, et les `wa_id` des personnes qui viennent de refuser. */
export interface JobPousseeOptOut {
  tenantId: string;
  waIds: string[];
}

/**
 * Découpe les identités en lots. PURE, donc testable sans file ni base.
 *
 * ⚠️ Elle DÉDUPLIQUE et écarte les identités vides : une action en masse peut toucher deux fois la même
 * personne (deux fiches, un même numéro), et pousser deux fois le même refus dans le même lot ne servirait
 * qu'à doubler le trafic chez le client.
 */
export function lotsDePoussee(waIds: readonly string[]): string[][] {
  const propres = [...new Set(waIds.map((w) => w.trim()).filter((w) => w !== ''))];
  const lots: string[][] = [];
  for (let i = 0; i < propres.length; i += TAILLE_LOT_POUSSEE) {
    lots.push(propres.slice(i, i + TAILLE_LOT_POUSSEE));
  }
  return lots;
}

/**
 * Combien de temps un job de ce lot a le droit de TOURNER, avant que pg-boss le croie mort et le rejoue.
 *
 * 🔴 SANS CE CALCUL, UN LOT LENT SERAIT REJOUÉ EN PARALLÈLE DE LUI-MÊME. Le défaut de pg-boss est de quinze
 * minutes, et un lot de deux cents refus dont le système du client ne répond plus les dépasse (chaque appel
 * s'accorde `DELAI_POUSSEE_OPTOUT_MS`). Le dommage serait limité, la poussée étant idempotente, mais on
 * doublerait le trafic vers un système déjà en difficulté, ce qui est exactement le mauvais moment.
 *
 * ⚠️ DÉRIVÉ de la taille RÉELLE du lot et de l'échéance d'un appel, jamais écrit en dur : c'est la leçon de
 * `campaign-run`, dont l'échéance est dimensionnée sur son travail réel pour la même raison. La minute de
 * marge couvre la lecture des projections de contact.
 */
export function echeanceDuLot(taille: number): number {
  return Math.ceil((taille * DELAI_POUSSEE_OPTOUT_MS) / 1000) + 60;
}

export interface DepsAnnonceOptOut {
  /** Met un lot en file, avec l'échéance que ce lot mérite. Peut lever : l'annonce l'absorbe. */
  enfiler(job: JobPousseeOptOut, opts: { expireInSeconds: number }): Promise<void>;
  /** Journal serveur, injecté pour être observé en test. */
  log?(message: string): void;
}

/**
 * L'ANNONCE : ce que le dépôt de contacts appelle APRÈS avoir écrit `opted_out`.
 *
 * 🔴 ELLE NE LÈVE JAMAIS, ET C'EST SA RAISON D'ÊTRE. Elle est appelée depuis `PgContactStore`, après la
 * validation de la transaction : si elle laissait remonter une exception, une base de files indisponible
 * ferait rendre 500 à la route qui vient pourtant d'enregistrer le refus. L'opérateur croirait son geste
 * perdu et le referait, ou pire, y renoncerait.
 *
 * ⚠️ ELLE EST ATTENDUE (`await`), pas lancée dans le vide. Deux raisons : une promesse non attendue qui
 * échoue est un rejet non géré, qui tue le process ; et les tests d'un chemin d'écriture doivent pouvoir
 * observer l'annonce sans course. Ce qu'elle attend est une INSERTION, pas un appel réseau.
 */
export function creerAnnonceOptOut(deps: DepsAnnonceOptOut) {
  return async (tenantId: string, waIds: readonly string[]): Promise<void> => {
    const lots = lotsDePoussee(waIds);
    for (const lot of lots) {
      try {
        await deps.enfiler({ tenantId, waIds: lot }, { expireInSeconds: echeanceDuLot(lot.length) });
      } catch (err) {
        // Journalisé et rien d'autre : le refus EST enregistré, c'est sa diffusion qui est perdue. La dire
        // perdue est plus honnête que de faire échouer un geste de conformité déjà accompli.
        deps.log?.(`poussee-optout: ${lot.length} refus non annonces pour ${tenantId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
}

export interface DepsTravailPousseeOptOut extends DepsResolveurHttp {
  /**
   * La requête branchée sur le consentement pour cet espace, ou `null`.
   *
   * 🔴 RELUE À L'EXÉCUTION, jamais portée par le job. Le réglage peut avoir été retiré entre l'enfilement et
   * la reprise (un job en DLQ peut être rejoué des heures plus tard) : pousser vers un connecteur que le
   * client vient de débrancher enverrait ses données à un système dont il ne veut plus.
   */
  requeteConfiguree(tenantId: string): Promise<string | null>;
  /** Projection du contact (`{nom, tags, champs}`), source des variables `champ` et `contact`. */
  projectionContact(tenantId: string, waId: string): Promise<Record<string, unknown> | null>;
  /**
   * Le journal des appels de connecteur (migration 0142).
   *
   * 🔴 SANS LUI, UN REFUS NON POUSSÉ EST INVISIBLE DU CLIENT. C'est le pire des trois cas d'appel : il croit
   * son CRM prévenu, et il répond d'un manquement qu'il ne peut pas voir. Les réessais de pg-boss puis la
   * DLQ sont NOTRE filet, pas le sien.
   *
   * ⚠️ Optionnel : absent, on retombe sur le journal serveur seul, c'est-à-dire le comportement d'avant.
   */
  journalAppels?: JournalAppels;
  /** Le LIBELLÉ de la requête branchée, pour que le journal nomme ce qu'un humain reconnaît. */
  libelleRequete?(tenantId: string, requestId: string): Promise<string | null>;
  log?(message: string): void;
}

/** Payload valide ? Lu défensivement : le job vient de la base, pas du compilateur. */
function lireJob(data: unknown): JobPousseeOptOut | null {
  if (data === null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.tenantId !== 'string' || d.tenantId === '') return null;
  if (!Array.isArray(d.waIds)) return null;
  const waIds = d.waIds.filter((w): w is string => typeof w === 'string' && w.trim() !== '');
  return { tenantId: d.tenantId, waIds };
}

/**
 * LE TRAVAIL : jouer la requête branchée, pour chaque refus du lot.
 *
 * ⚠️ IL LÈVE quand au moins un appel a échoué, et c'est voulu : c'est le seul moyen de demander une nouvelle
 * tentative à pg-boss. Le prix est le rejeu des contacts déjà poussés du même lot, accepté parce que la
 * poussée déclare un état et non un événement (voir l'en-tête de ce fichier).
 */
export function creerTravailPousseeOptOut(deps: DepsTravailPousseeOptOut) {
  const appel = creerAppelConnecteur(deps);
  return async (data: unknown): Promise<void> => {
    const job = lireJob(data);
    if (job === null) throw new Error('poussee-optout : payload invalide (tenantId/waIds manquant)');
    if (job.waIds.length === 0) return;

    const requestId = await deps.requeteConfiguree(job.tenantId);
    // AUCUN connecteur branché : il n'y a rien à faire, et ce n'est pas un échec. Lever ici ferait remplir la
    // DLQ de jobs qu'un simple débranchement rend sans objet.
    if (requestId === null || requestId.trim() === '') {
      deps.log?.(`poussee-optout: aucun connecteur branche sur ${job.tenantId}, ${job.waIds.length} refus non pousses`);
      return;
    }

    // Le libellé est lu UNE FOIS pour tout le lot : deux cents refus ne doivent pas coûter deux cents
    // lectures de la même requête.
    const nom = (deps.libelleRequete ? await deps.libelleRequete(job.tenantId, requestId) : null) ?? requestId;

    const echecs: string[] = [];
    for (const waId of job.waIds) {
      try {
        const contact = await deps.projectionContact(job.tenantId, waId);
        const r = await appel({
          tenantId: job.tenantId,
          waId,
          contact,
          requestId,
          maxBytes: MAX_OCTETS_POUSSEE_OPTOUT,
          // ⚠️ AUCUN ARGUMENT DE MODÈLE : il n'y a pas de modèle ici. Une requête qui déclare une variable
          // `modele` REQUISE sera refusée avec sa raison, ce qui est le bon comportement : l'appel partirait
          // sinon sans la valeur qui le rend juste.
          args: {},
          /**
           * 🔴 UNE POUSSÉE NE LIT RIEN, ET CE N'EST PAS UN OUBLI. Elle prévient le système du client qu'un
           * contact s'est désabonné ; la réponse ne sert qu'à savoir si c'est passé, et ce code ne lit
           * effectivement que `r.ok`. Le déclarer ici évite que la réponse d'un système tiers traverse pour
           * rien, et c'est ce que le champ obligatoire force à écrire.
           */
          lecture: { nature: 'pousse' } as const,
          signal: AbortSignal.timeout(DELAI_POUSSEE_OPTOUT_MS),
          journal: deps.journalAppels
            ? { journal: deps.journalAppels, source: 'optout', nom, sessionId: null, toolId: null }
            : null,
        });
        if (r.ok === false) echecs.push(`${waId}: ${r.erreur ?? 'sans raison'}`);
      } catch (err) {
        echecs.push(`${waId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (echecs.length > 0) {
      deps.log?.(`poussee-optout: ${echecs.length}/${job.waIds.length} refus non pousses pour ${job.tenantId} (${echecs.slice(0, 3).join(' | ')})`);
      throw new Error(`poussee-optout : ${echecs.length}/${job.waIds.length} appels en echec`);
    }
  };
}
