import { creerAppelConnecteur, type DepsResolveurHttp } from '../agent/resolvers/http';
import type { JournalAppels } from '../agent/catalog';
import { texteDe } from '../lib/erreur';

/**
 * Pousser un refus vers le système du client au moment où il est déclaré, pour qu'il ne continue pas d'écrire
 * à cette personne depuis ses autres outils (CRM, back-office, e-mails).
 *
 * 🔴 L'appel ne bloque jamais l'écriture de l'opt-out : `opted_out` est écrit et validé d'abord, puis annoncé par
 * une mise en file. Aucune panne (connecteur, réseau, file) ne peut faire échouer le respect d'un refus ; seul
 * l'appel se réessaie (pg-boss : 5 tentatives, puis la DLQ visible de `/ops`).
 *
 * La poussée déclare un état (« untel est désabonné »), pas un événement : rejouer un lot entier est donc sans
 * incohérence, et aucun suivi par contact n'est nécessaire.
 */

/** La file, déclarée ici et importée par `names.ts` : le nom d'une file ne s'écrit qu'une fois. */
export const FILE_POUSSEE_OPTOUT = 'optout-poussee';

/**
 * Plafond de lecture de la réponse, en octets, plus bas que celui d'un bloc de scénario : personne ne lit cette
 * réponse, l'accusé ne sert qu'à savoir si l'appel a abouti.
 */
export const MAX_OCTETS_POUSSEE_OPTOUT = 16 * 1024;

/**
 * Délai d'attente du système du client, plus long que le bloc de scénario (10 s) : ici personne n'attend, et
 * abandonner tôt ajouterait une tentative inutile à un système lent mais sain.
 */
export const DELAI_POUSSEE_OPTOUT_MS = 20_000;

/**
 * Combien de refus voyagent dans un job : un découpage, pas un plafond, rien n'est jamais écarté. Un job par
 * contact ferait des milliers d'insertions avant que la requête HTTP ne rende la main ; un job unique porterait
 * un gros payload et rejouerait tout sur un seul échec.
 */
export const TAILLE_LOT_POUSSEE = 200;

/** Le job : un espace, et les `wa_id` des personnes qui viennent de refuser. */
export interface JobPousseeOptOut {
  tenantId: string;
  waIds: string[];
}

/**
 * Découpe les identités en lots, fonction pure. Déduplique et écarte les vides : une action en masse peut
 * toucher deux fois la même personne, et pousser deux fois le même refus doublerait le trafic chez le client.
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
 * Combien de temps un job de ce lot peut tourner avant que pg-boss le croie mort et le rejoue. Le défaut
 * (15 min) est dépassé par un lot lent, qui serait alors rejoué en parallèle de lui-même et doublerait le
 * trafic vers un système déjà en difficulté. Dérivé de la taille réelle du lot, plus une minute de marge.
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
 * L'annonce, appelée par `PgContactStore` après avoir écrit `opted_out` et validé la transaction.
 * 🔴 Ne lève jamais : une file indisponible ferait sinon rendre 500 à la route qui vient d'enregistrer le refus,
 * et l'opérateur croirait son geste perdu. Elle est attendue (`await`) : une promesse lancée dans le vide qui
 * échoue tuerait le process, et les tests doivent l'observer sans course. Elle n'attend qu'une insertion.
 */
export function creerAnnonceOptOut(deps: DepsAnnonceOptOut) {
  return async (tenantId: string, waIds: readonly string[]): Promise<void> => {
    const lots = lotsDePoussee(waIds);
    for (const lot of lots) {
      try {
        await deps.enfiler({ tenantId, waIds: lot }, { expireInSeconds: echeanceDuLot(lot.length) });
      } catch (err) {
        // Journalisé seulement : le refus est enregistré, c'est sa diffusion qui est perdue.
        deps.log?.(`poussee-optout: ${lot.length} refus non annonces pour ${tenantId}: ${texteDe(err)}`);
      }
    }
  };
}

export interface DepsTravailPousseeOptOut extends DepsResolveurHttp {
  /**
   * La requête branchée sur le consentement pour cet espace, ou `null`. 🔴 Relue à l'exécution, jamais portée
   * par le job : un job rejoué des heures plus tard pousserait sinon vers un connecteur que le client a débranché.
   */
  requeteConfiguree(tenantId: string): Promise<string | null>;
  /** Projection du contact (`{nom, tags, champs}`), source des variables `champ` et `contact`. */
  contacts: { projectionPourTiers(tenantId: string, waId: string): Promise<Record<string, unknown> | null> };
  /**
   * Le journal des appels de connecteur : sans lui, un refus non poussé est invisible du client, qui croit son
   * CRM prévenu. Les réessais et la DLQ sont notre filet, pas le sien. Absent : journal serveur seul.
   */
  journalAppels?: JournalAppels;
  /** Le libellé de la requête branchée, pour que le journal nomme ce qu'un humain reconnaît. */
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
 * Le travail : jouer la requête branchée pour chaque refus du lot. Lève si au moins un appel a échoué, seul
 * moyen de demander une nouvelle tentative à pg-boss ; rejouer les contacts déjà poussés est sans effet.
 */
export function creerTravailPousseeOptOut(deps: DepsTravailPousseeOptOut) {
  const appel = creerAppelConnecteur(deps);
  return async (data: unknown): Promise<void> => {
    const job = lireJob(data);
    if (job === null) throw new Error('poussee-optout : payload invalide (tenantId/waIds manquant)');
    if (job.waIds.length === 0) return;

    const requestId = await deps.requeteConfiguree(job.tenantId);
    // Aucun connecteur branché : rien à faire, et ce n'est pas un échec (lever remplirait la DLQ pour rien).
    if (requestId === null || requestId.trim() === '') {
      deps.log?.(`poussee-optout: aucun connecteur branche sur ${job.tenantId}, ${job.waIds.length} refus non pousses`);
      return;
    }

    // Le libellé est lu une fois pour tout le lot.
    const nom = (deps.libelleRequete ? await deps.libelleRequete(job.tenantId, requestId) : null) ?? requestId;

    const echecs: string[] = [];
    for (const waId of job.waIds) {
      try {
        const contact = await deps.contacts.projectionPourTiers(job.tenantId, waId);
        const r = await appel({
          tenantId: job.tenantId,
          waId,
          contact,
          requestId,
          maxBytes: MAX_OCTETS_POUSSEE_OPTOUT,
          // Aucun argument de modèle : il n'y a pas de modèle ici. Une requête qui exige une variable `modele` est
          // refusée avec sa raison plutôt que de partir sans elle.
          args: {},
          /** Une poussée ne lit rien : la réponse ne sert qu'à savoir si c'est passé (`r.ok`), et ne doit pas
           *  traverser. */
          lecture: { nature: 'pousse' } as const,
          signal: AbortSignal.timeout(DELAI_POUSSEE_OPTOUT_MS),
          journal: deps.journalAppels
            ? { journal: deps.journalAppels, source: 'optout', nom, sessionId: null, toolId: null }
            : null,
        });
        if (r.ok === false) echecs.push(`${waId}: ${r.erreur ?? 'sans raison'}`);
      } catch (err) {
        echecs.push(`${waId}: ${texteDe(err)}`);
      }
    }

    if (echecs.length > 0) {
      deps.log?.(`poussee-optout: ${echecs.length}/${job.waIds.length} refus non pousses pour ${job.tenantId} (${echecs.slice(0, 3).join(' | ')})`);
      throw new Error(`poussee-optout : ${echecs.length}/${job.waIds.length} appels en echec`);
    }
  };
}
