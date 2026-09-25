import type { JournalAppels, StatutAppel } from '../agent/catalog';
import { HttpTimeoutError } from '../meta/http';
import { BATCH_FENETRE_EVENEMENT_MS, BatchApiError, versBatch, type ClesBatch, type ProfilBatch } from './batch';
import { NOM_APPEL_SIGNAUX, schemaJobSignaux, type Signal, type SignalComplet } from './types';
import { texteDe } from '../lib/erreur';

/** Le réglage d'un espace, DÉCHIFFRÉ par le câblage. `suspendu` = l'outil a refusé les clés. */
export interface ReglageBatchClair {
  cles: ClesBatch;
  envoyerResume: boolean;
  suspendu: boolean;
}

export interface DepsTravailBatch {
  /** Relu à CHAQUE job : l'espace a pu débrancher l'outil, ou changer l'option, depuis l'émission. */
  reglage(tenantId: string): Promise<ReglageBatchClair | null>;
  completer(tenantId: string, signal: Signal): Promise<SignalComplet | null>;
  pousser(requete: ProfilBatch[], cles: ClesBatch): Promise<{ partiel: string | null }>;
  noterSansIdentifiant(tenantId: string, n: number): Promise<void>;
  suspendre(tenantId: string): Promise<void>;
  journal: JournalAppels;
  /** L'horloge, en millisecondes : durée d'un appel, et fenêtre des événements acceptés par l'outil. */
  maintenant?: () => number;
  log?: (message: string) => void;
}

/**
 * 🔴 LE TEXTE RECOPIÉ DANS LE JOURNAL DES ERREURS NE NOMME PAS L'OUTIL.
 *
 * Ce texte vient en partie de l'outil lui-même (le détail d'un 4xx, la raison d'un succès partiel), ou porte son
 * adresse (un délai dépassé, une panne réseau). Il s'affiche dans Sécurité > Journal des erreurs, un écran de la
 * MARQUE, et la spec (§ 10) y réserve le nom de l'outil à l'écran de réglage de son adaptateur, comme pour
 * `NOM_APPEL_SIGNAUX`. Une adresse qui le nomme devient « l’adresse de l’outil », son nom devient « outil », quelle
 * que soit la casse ; le reste du message, qui dit ce qui a été refusé, passe tel quel.
 */
function neutraliserOutil(message: string): string {
  return message
    .replace(/https?:\/\/\S*batch\S*/gi, 'l’adresse de l’outil')
    .replace(/batch/gi, 'outil');
}

/**
 * Le travail de la file `signaux-batch` (spec 2026-09-24, § 8). Un job = UN espace, de 1 à `SIGNAUX_PAR_JOB`
 * signaux, complétés un par un puis traduits ENSEMBLE (`versBatch` regroupe par fiche et découpe aux bornes).
 *
 * - Un job hors contrat LÈVE : la file le rejoue puis le range en DLQ, visible de `/ops`.
 * - Un 4xx est TERMINAL : une ligne dans la moitié « système » du journal des erreurs, et la tranche suivante
 *   part quand même (une fiche refusée ne doit pas bloquer les autres). 401 et 403 SUSPENDENT en plus la
 *   remontée, jusqu'à de nouvelles clés, et arrêtent le job : les mêmes clés échoueraient sur chaque tranche, et
 *   chaque signal écrirait sa ligne dans `agent_tool_calls`, que rien ne purge.
 * - 429, 5xx, panne réseau : déjà rejoués par `pousserVersBatch` ; épuisés, ils s'écrivent ET lèvent, et la file
 *   rejoue le job ENTIER plus tard, tranches déjà passées comprises. Les mêmes `em_event_id` repartent : l'outil
 *   peut dédupliquer, et un attribut de fiche réécrit à l'identique ne coûte rien.
 * - 🔴 UN ÉVÉNEMENT DE PLUS DE 24 HEURES (un job rejoué tard, un worker longtemps arrêté) : l'outil le
 *   refuserait. Il n'est pas envoyé et le job le DIT dans son journal (nombre, noms, espace). Seul l'état de la
 *   fiche RELU au moment de pousser part quand même (identifiant, désabonnements) : ce que le signal apprenait
 *   lui-même (dernière réponse, joignabilité RCS, dernière analyse) datait de lui, et l'écrire maintenant
 *   écraserait un état plus récent (`attributsDuSignal`). Ce n'est pas un refus de l'outil : rien n'est écrit
 *   dans le journal des erreurs de la marque.
 * - 🔴 LE COMPTE DES FICHES SANS IDENTIFIANT S'ÉCRIT APRÈS LA DERNIÈRE TRANCHE, jamais avant : un job rejoué
 *   après un 5xx recompterait les mêmes fiches, et l'écran du réglage annoncerait des signaux perdus qui ne
 *   l'ont été qu'une fois. Seul un job qui ne LÈVE pas arrive jusque-là, et la file ne rejoue que ceux qui lèvent.
 * - La ligne de journal ne porte que le nombre de signaux, leurs NOMS et l'`em_event_id` du premier, jamais une
 *   donnée de la personne ; son libellé (`NOM_APPEL_SIGNAUX`) et son message (`neutraliserOutil`) ne nomment pas
 *   l'outil.
 */
export function creerTravailSignauxBatch(deps: DepsTravailBatch): (data: unknown) => Promise<void> {
  const maintenant = deps.maintenant ?? Date.now;

  const journaliser = async (
    tenantId: string, signaux: readonly Signal[], statut: StatutAppel, debut: number, erreur: string, httpStatus?: number,
  ): Promise<void> => {
    try {
      const id = await deps.journal.ouvrir({
        tenantId, sessionId: null, toolId: null, toolName: NOM_APPEL_SIGNAUX, origin: 'http',
        argsRediges: {
          signaux: signaux.length,
          noms: [...new Set(signaux.map((s) => s.nom))].sort().join(','),
          em_event_id: signaux[0]?.id ?? null,
        },
        source: 'signaux',
      });
      await deps.journal.clore({
        tenantId, id, status: statut, ...(httpStatus !== undefined ? { httpStatus } : {}),
        dureeMs: maintenant() - debut, erreur: neutraliserOutil(erreur).slice(0, 500),
      });
    } catch (err) {
      deps.log?.(`signaux-batch: journal impossible pour ${tenantId}: ${texteDe(err)}`);
    }
  };

  return async (data) => {
    const job = schemaJobSignaux.safeParse(data);
    if (!job.success) {
      const i = job.error.issues[0];
      throw new Error(`signaux-batch : payload invalide (${i ? `${i.path.join('.')} ${i.message}` : 'forme'})`);
    }
    const { tenantId, signaux } = job.data;

    const reglage = await deps.reglage(tenantId);
    if (reglage === null || reglage.suspendu) return;

    // Un à un : chaque lecture est sur clé, et un job en porte au plus `SIGNAUX_PAR_JOB`.
    const complets: SignalComplet[] = [];
    for (const s of signaux) {
      const c = await deps.completer(tenantId, s);
      if (c !== null) complets.push(c);
    }
    if (complets.length === 0) return;

    const depuis = maintenant() - BATCH_FENETRE_EVENEMENT_MS;
    const { requetes, sansIdentifiant, tropVieux } = versBatch(complets, {
      resume: reglage.envoyerResume,
      evenementsDepuis: new Date(depuis).toISOString(),
    });
    if (tropVieux > 0) {
      const noms = [...new Set(complets.filter((c) => Date.parse(c.le) < depuis).map((c) => c.contenu.nom))].sort().join(',');
      deps.log?.(`signaux-batch: ${tropVieux} evenement(s) de plus de 24 h non envoye(s) pour ${tenantId} (${noms}) : l'outil les refuserait, seul l'etat relu des fiches part`);
    }

    for (const requete of requetes) {
      const debut = maintenant();
      try {
        const r = await deps.pousser(requete, reglage.cles);
        if (r.partiel !== null) await journaliser(tenantId, signaux, 'erreur_outil', debut, r.partiel, 202);
      } catch (err) {
        if (err instanceof BatchApiError && !err.retryable) {
          await journaliser(tenantId, signaux, 'refuse', debut, err.message, err.status);
          if (err.status === 401 || err.status === 403) {
            try {
              await deps.suspendre(tenantId);
            } catch (e) {
              deps.log?.(`signaux-batch: suspension non ecrite pour ${tenantId}: ${texteDe(e)}`);
            }
            break;
          }
          continue;
        }
        await journaliser(
          tenantId, signaux, err instanceof HttpTimeoutError ? 'timeout' : 'erreur_outil', debut, texteDe(err),
          err instanceof BatchApiError ? err.status : undefined,
        );
        throw err;
      }
    }

    // APRÈS la dernière tranche (cf. le docblock) : un job qui a levé plus haut sera rejoué, et c'est le passage
    // qui ira jusqu'ici qui comptera, une fois.
    if (sansIdentifiant > 0) {
      try {
        await deps.noterSansIdentifiant(tenantId, sansIdentifiant);
      } catch (err) {
        deps.log?.(`signaux-batch: compte sans identifiant non ecrit pour ${tenantId}: ${texteDe(err)}`);
      }
    }
  };
}
