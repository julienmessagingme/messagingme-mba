import type { JournalAppels, StatutAppel } from '../agent/catalog';
import { HttpTimeoutError } from '../meta/http';
import { BATCH_FENETRE_EVENEMENT_MS, BatchApiError, versBatch, type ClesBatch, type ProfilBatch } from './batch';
import { NOM_APPEL_SIGNAUX, schemaJobSignaux, type Signal, type SignalComplet } from './types';
import { texteDe } from '../lib/erreur';

/** Le réglage d'un espace, déchiffré par le câblage. `suspendu` = l'outil a refusé les clés. */
export interface ReglageBatchClair {
  cles: ClesBatch;
  envoyerResume: boolean;
  suspendu: boolean;
}

export interface DepsTravailBatch {
  /** Relu à chaque job : l'espace a pu débrancher l'outil, ou changer l'option, depuis l'émission. */
  reglage(tenantId: string): Promise<ReglageBatchClair | null>;
  completer(tenantId: string, signal: Signal): Promise<SignalComplet | null>;
  pousser(requete: ProfilBatch[], cles: ClesBatch): Promise<{ partiel: string | null }>;
  batch: { noterSansIdentifiant(tenantId: string, n: number): Promise<void> };
  suspendre(tenantId: string): Promise<void>;
  journal: JournalAppels;
  /** L'horloge, en millisecondes : durée d'un appel, et fenêtre des événements acceptés par l'outil. */
  maintenant?: () => number;
  log?: (message: string) => void;
}

/**
 * Le texte recopié dans le journal des erreurs ne nomme pas l'outil : ce journal est un écran de la marque, et le
 * nom de l'outil est réservé à l'écran de réglage de son adaptateur (comme `NOM_APPEL_SIGNAUX`). Le texte vient
 * en partie de l'outil (détail d'un 4xx, raison d'un succès partiel) ou porte son adresse : on neutralise les
 * deux, quelle que soit la casse, et le reste du message passe tel quel.
 */
function neutraliserOutil(message: string): string {
  return message
    .replace(/https?:\/\/\S*batch\S*/gi, 'l’adresse de l’outil')
    .replace(/batch/gi, 'outil');
}

/**
 * Le travail de la file `signaux-batch`. Un job = un espace, de 1 à `SIGNAUX_PAR_JOB` signaux, complétés un par un
 * puis traduits ensemble (`versBatch` regroupe par fiche et découpe aux bornes).
 *
 * - Un job hors contrat lève : la file le rejoue puis le range en DLQ, visible de `/ops`.
 * - Un 4xx est terminal : une ligne dans le journal des erreurs, et la tranche suivante part quand même. 401 et
 *   403 suspendent en plus la remontée jusqu'à de nouvelles clés, et arrêtent le job : les mêmes clés
 *   échoueraient sur chaque tranche, et chaque ligne irait dans `agent_tool_calls`, que rien ne purge.
 * - 429, 5xx, panne réseau : déjà rejoués par `pousserVersBatch` ; épuisés, ils s'écrivent et lèvent, et la file
 *   rejoue le job entier. Les mêmes `em_event_id` repartent : l'outil peut dédupliquer.
 * - Un événement de plus de 24 heures serait refusé par l'outil : il n'est pas envoyé, le job le dit dans son
 *   journal, et seul l'état relu de la fiche part (`attributsDuSignal`). Rien dans le journal de la marque.
 * - Le compte des fiches sans identifiant s'écrit après la dernière tranche : un job rejoué après un 5xx
 *   recompterait les mêmes fiches, et seul un job qui ne lève pas arrive jusque-là.
 * - La ligne de journal ne porte que le nombre de signaux, leurs noms et l'`em_event_id` du premier, jamais une
 *   donnée de la personne.
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

    // Après la dernière tranche : seul le passage qui va jusqu'ici compte, une fois.
    if (sansIdentifiant > 0) {
      try {
        await deps.batch.noterSansIdentifiant(tenantId, sansIdentifiant);
      } catch (err) {
        deps.log?.(`signaux-batch: compte sans identifiant non ecrit pour ${tenantId}: ${texteDe(err)}`);
      }
    }
  };
}
