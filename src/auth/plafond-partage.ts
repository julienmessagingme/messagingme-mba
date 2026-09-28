import type { FastifyReply } from 'fastify';
import type { CodeApi } from '../api/erreurs';
import { restantDe, type CompteurDebit } from '../db/debit';
import { journaliser } from '../lib/journal';
import { refuserTropDeRequetes } from './rate-limit';

/**
 * Un plafond de débit à une fenêtre, compté dans le compteur PARTAGÉ par toutes les copies de l'API
 * (`src/db/debit.ts`) : le plafond annoncé est tenu au total, pas une fois par copie. Sert les opérations coûteuses
 * d'un espace et les tentatives de connexion ; le plafond de l'API publique a ses deux fenêtres à lui
 * (`plafond-espace.ts`).
 *
 * 🔴 CE QUE LE PLAFOND FAIT QUAND LA BASE NE RÉPOND PAS est une décision, et elle est REQUISE à la construction
 * (`siLaBaseEchoue`) : un plafond ne peut pas oublier d'en avoir une.
 * - `laisser-passer` : l'appel passe, sans en-têtes (on ne sait rien de la fenêtre). Pour ce qui protège la charge
 *   (opérations coûteuses) : la requête elle-même a besoin de la base et échouera si elle est vraiment tombée, et
 *   refuser tous les clients sur une panne de quelques secondes serait pire qu'un plafond non tenu le temps de la
 *   panne.
 * - `refuser` : 429, avec un message qui dit que la vérification est impossible (pas « trop de tentatives »). Pour
 *   ce qui protège d'une attaque (connexion, inscription, mot de passe oublié) : une panne ne doit jamais ouvrir un
 *   essai de plus.
 * Dans les deux cas l'échec se journalise, au plus une fois par minute et par plafond.
 */
export type SiLaBaseEchoue = 'laisser-passer' | 'refuser';

export interface OptionsPlafondPartage {
  /** Le préfixe de ses clés dans le compteur (`couteux`, `connexion.login`), et son nom dans le journal. */
  readonly nom: string;
  /** Appels par fenêtre ; `0` (ou moins) le désactive, la convention du dépôt. */
  readonly max: number;
  readonly dureeMs: number;
  readonly siLaBaseEchoue: SiLaBaseEchoue;
}

/** Ce qu'un appel a obtenu. */
export interface Consommation {
  readonly accepte: boolean;
  /** La base n'a pas pu compter : `accepte` vient alors de `siLaBaseEchoue`, et rien d'autre n'est connu. */
  readonly indisponible: boolean;
  readonly limite: number;
  readonly restant: number;
  /** Fin de la fenêtre, en millisecondes depuis l'époque (horloge de la base). */
  readonly resetAt: number;
  /** Combien attendre avant de réessayer, en millisecondes. */
  readonly attenteMs: number;
}

/** L'attente conseillée quand la base n'a pas répondu : quelques secondes, pas une fenêtre entière. */
const ATTENTE_SI_INDISPONIBLE_MS = 5_000;

export class PlafondPartage {
  private dernierAvertissement = Number.NEGATIVE_INFINITY;

  constructor(private readonly compteur: CompteurDebit, private readonly o: OptionsPlafondPartage) {}

  get desactive(): boolean {
    return this.o.max <= 0;
  }

  /** Compte un appel pour `discriminant` (l’espace, l’empreinte d’une tentative de connexion...) : jamais un secret ni une adresse en clair, la clé vit en base. Ne lève jamais : la politique décide. */
  async consommer(discriminant: string): Promise<Consommation> {
    if (this.desactive) return { accepte: true, indisponible: false, limite: 0, restant: 0, resetAt: 0, attenteMs: 0 };
    try {
      const v = await this.compteur.compter([{ cle: `${this.o.nom}|${discriminant}`, dureeMs: this.o.dureeMs, max: this.o.max }]);
      const f = v.fenetres[0]!;
      return {
        accepte: v.accepte,
        indisponible: false,
        limite: this.o.max,
        restant: restantDe(f),
        resetAt: f.finMs,
        attenteMs: Math.max(0, f.finMs - v.maintenantMs),
      };
    } catch (err) {
      const t = Date.now();
      if (t - this.dernierAvertissement >= 60_000) {
        this.dernierAvertissement = t;
        journaliser('error', 'plafond_partage_indisponible', { plafond: this.o.nom, siLaBaseEchoue: this.o.siLaBaseEchoue, err });
      }
      return {
        accepte: this.o.siLaBaseEchoue === 'laisser-passer',
        indisponible: true,
        limite: this.o.max,
        restant: 0,
        resetAt: 0,
        attenteMs: ATTENTE_SI_INDISPONIBLE_MS,
      };
    }
  }
}

/** Le refus d'un plafond qui n'a pas pu compter (`siLaBaseEchoue: 'refuser'`) : il ne dit pas « trop de tentatives ». */
export const MESSAGE_PLAFOND_INDISPONIBLE = 'vérification momentanément impossible, réessaie dans un instant';

/**
 * Compte un appel et pose les en-têtes `x-ratelimit-*` ; `false` = refusé, le 429 est déjà parti. Le pendant de
 * `consommerAvecEntetes` (`rate-limit.ts`) pour un plafond partagé. Désactivé, ou base muette avec la politique
 * `laisser-passer` : aucun en-tête, `x-ratelimit-limit: 0` sur un appel accepté ferait croire à un quota épuisé.
 */
export async function consommerPartageAvecEntetes(
  plafond: PlafondPartage,
  cle: string,
  reply: FastifyReply,
  message = 'trop de requêtes, patientez un instant',
  code?: CodeApi,
): Promise<boolean> {
  if (plafond.desactive) return true;
  const c = await plafond.consommer(cle);
  if (c.indisponible) {
    if (c.accepte) return true;
    await refuserTropDeRequetes(reply, c.attenteMs, MESSAGE_PLAFOND_INDISPONIBLE, code);
    return false;
  }
  reply.header('x-ratelimit-limit', String(c.limite));
  reply.header('x-ratelimit-remaining', String(c.restant));
  reply.header('x-ratelimit-reset', String(Math.ceil(c.resetAt / 1000)));
  if (c.accepte) return true;
  await refuserTropDeRequetes(reply, c.attenteMs, message, code);
  return false;
}
