import type { AnnotationsMcp, DepsMcp, OutilMcp, PersonneMcp } from './outils';
import { RefusOutil, valeurOuRefus } from './saisie';
import { MESSAGE_OPERATIONS_LOURDES } from '../auth/plafond-partage';
import type { Issue } from '../lib/issue';
import { DUREE_LIEN_NUMERO_MS, type LienNumero } from '../auth/token';
import { empreinteEtat, type EtatConnexion } from '../otp/etat-connexion';
import type { EtatDeLEspace } from '../stripe/abonnements.pg';

/**
 * LES OUTILS DE LA CONNEXION DU NUMÉRO (lot 3c, livraison A, spec `docs/superpowers/specs/2026-10-06-lien-attente-abonnement-design.md`).
 *
 * Le client ne passe jamais par la console (décision de Julien du 2026-10-06) : `start_whatsapp_connection` lui donne
 * un lien qui ouvre la page de connexion du numéro de SON espace, sans écran de connexion, pendant une heure ;
 * `watch_whatsapp_connection` attend le prochain changement (numéro attribué, code capté, numéro connecté) et rend le
 * code pour que Claude l'affiche dans le terminal.
 *
 * 🔴 Les deux exigent une PERSONNE : le lien agit en son nom (la garde relit à chaque appel qu'elle est encore admin),
 * et l'attente rend un code de vérification. Invisibles derrière une clé d'API.
 */
export interface DepsNumeroMcp {
  /** Signe le jeton du lien (`signLienNumero`, avec le secret des sessions). */
  signerLien(l: LienNumero): Promise<string>;
  /** L'état de la connexion, la MÊME lecture que la page (`lireEtatConnexion`). */
  etat(tenantId: string): Promise<EtatConnexion>;
  /** L'adresse de la console (`APP_URL`), où vit la page `/brancher`. */
  urlConsole: string;
  attendre(ms: number): Promise<void>;
  maintenant(): number;
  /** Le portail client de Stripe pour l'espace (`ouvrirPortail`, livraison B) : une adresse, ou un refus. */
  ouvrirPortail(tenantId: string, payeur: string): Promise<Issue<{ url: string }>>;
  /** L'état de l'abonnement et ses dates (lot 4) : la SEULE lecture (`PgAbonnementsNumeroStore.etatDeLEspace`). */
  abonnement(tenantId: string): Promise<EtatDeLEspace | null>;
  /** Un nouveau paiement de l'abonnement (lot 4, réabonnement du même numéro), retour sur `/paiement-recu`. */
  ouvrirAbonnement(tenantId: string, payeur: string): Promise<Issue<{ url: string }>>;
}

const jour = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

/**
 * Le rappel que porte chaque réponse d'outil MCP de l'espace (lot 4) : en retard, la date de la coupure ; suspendu, la
 * coupure et, si le numéro est gardé, sa libération. Rien dans les autres états. `src/mcp/serveur.ts` l'ajoute.
 */
export function rappelDeLAbonnement(a: EtatDeLEspace | null): string | null {
  if (a === null) return null;
  if (a.etat === 'en_retard') {
    // Sans date de coupure, rien ne sera coupé (un autre numéro que le numéro fourni envoie) : aucune date inventée.
    return a.coupureLe === null
      ? 'Rappel : le renouvellement de l’abonnement du numéro WhatsApp fourni a échoué. resubscribe_number donne le lien pour régler.'
      : `Rappel : le renouvellement de l’abonnement du numéro WhatsApp a échoué. Sans paiement, ses envois seront coupés le ${jour(a.coupureLe)}. `
        + 'resubscribe_number donne le lien pour régler.';
  }
  if (a.etat === 'suspendu') {
    return a.finiLe !== null
      ? `Les envois du numéro WhatsApp sont coupés : son abonnement est terminé. Sans réabonnement, le numéro sera libéré le ${jour(a.liberationLe)}. `
        + 'resubscribe_number donne le lien pour se réabonner au même numéro.'
      : 'Les envois du numéro WhatsApp sont coupés : son abonnement est impayé. resubscribe_number donne le lien pour régler.';
  }
  return null;
}

/**
 * L'attente rend la main au plus tard au bout de 25 secondes : le proxy de `api.messagingme.app` coupe une réponse à
 * 45 (`proxy_read_timeout 45s`, NPM, lu le 2026-10-06), et la marge couvre la dernière lecture et la réponse.
 */
export const DELAI_ATTENTE_MS = 25_000;
/** Une lecture de l'état toutes les deux secondes : le code arrive à l'écran comme sur la page (trois secondes). */
export const PAS_ATTENTE_MS = 2_000;
/** La forme d'une empreinte (`empreinteEtat`) : seize chiffres hexadécimaux. */
const EMPREINTE_RE = /^[0-9a-f]{16}$/;

const ecriture = (title: string, idempotentHint: boolean): AnnotationsMcp =>
  ({ title, readOnlyHint: false, destructiveHint: false, idempotentHint, openWorldHint: false });

function signataire(personne: PersonneMcp | null): string {
  if (personne === null) throw new RefusOutil('connexion OAuth requise : cet outil agit au nom d’une personne');
  return personne.userId;
}

const CONSIGNES = {
  fourni: 'Donne ce lien à la personne : il ouvre la page de connexion de son numéro, sans se connecter, pendant une '
    + 'heure. Sur la page : « Payer 3,50 € HT par mois », puis le numéro s’affiche ; ensuite la fenêtre de Meta, « Enter a '
    + 'new phone number », le numéro affiché, et la vérification par appel (« Phone call ») si Meta laisse choisir ; '
    + 'sinon Meta envoie un SMS, qui arrive aussi. Appelle ensuite watch_whatsapp_connection : le code '
    + 'arrivera ici, lis-le-lui pour qu’elle le recopie dans la fenêtre de Meta.',
  apporte: 'Donne ce lien à la personne : il ouvre la page de connexion de son numéro, sans se connecter, pendant une '
    + 'heure. Sur la page : la fenêtre de Meta, son numéro, et le code qu’elle reçoit elle-même. Appelle ensuite '
    + 'watch_whatsapp_connection pour savoir quand le numéro est connecté.',
} as const;

/** L'état tel que Claude le lit. Le code en clair n'y figure qu'à part (`code`), quand il est arrivé. */
function vueEtat(e: EtatConnexion): Record<string, unknown> {
  return {
    numero_fourni: e.fourni,
    code_recu_le: e.code?.recuLe ?? null,
    connecte: e.connecte !== null && !e.connecte.aActiver,
    a_activer: e.connecte?.aActiver === true,
    abonnement: e.abonnement?.statut ?? null,
    prochaine_echeance: e.abonnement?.periodeFin ?? null,
    numero_connecte: e.connecte ? (e.connecte.chiffres ? `+${e.connecte.chiffres}` : null) : null,
  };
}

export const OUTILS_NUMERO: OutilMcp[] = [
  {
    nom: 'get_number_subscription',
    description:
      'L’abonnement du numéro WhatsApp fourni (3,50 € HT par mois) : son statut (actif, en_retard après un paiement échoué, '
      + 'resilie), la fin de la période payée, et le numéro. `abonnement: null` : l’espace n’a pas de numéro fourni payé.',
    scope: 'mcp:read',
    annotations: { title: 'Lire l’abonnement du numéro', readOnlyHint: true, openWorldHint: false },
    entree: { type: 'object', properties: {}, additionalProperties: false },
    async executer(deps: DepsMcp, tenantId) {
      // L'état calculé est un complément : une lecture qui échoue ne prive pas Claude du statut (jaune 7 de A).
      const [e, a] = await Promise.all([deps.numero.etat(tenantId), deps.numero.abonnement(tenantId).catch(() => null)]);
      return {
        abonnement: e.abonnement?.statut ?? null,
        prochaine_echeance: e.abonnement?.periodeFin ?? null,
        numero_fourni: e.fourni,
        prix: '3,50 € HT par mois',
        // Lot 4 : l'état calculé (actif, fin_prevue, en_retard, suspendu, libere) et ses dates.
        etat: a?.etat ?? null,
        fin_prevue: iso(a?.finPrevueLe),
        coupure_le: iso(a?.coupureLe),
        liberation_le: iso(a?.liberationLe),
      };
    },
  },
  {
    nom: 'manage_number_subscription',
    description:
      'Rend l’adresse du portail client de Stripe pour l’abonnement du numéro : changer de carte, lire les factures, '
      + 'résilier. À donner à la personne : le geste reste le sien. Compte dans les opérations lourdes de l’espace.',
    scope: 'mcp:write',
    exigePersonne: true,
    // Monde ouvert : une session est créée chez Stripe. Une de plus à chaque appel.
    annotations: { title: 'Gérer l’abonnement du numéro', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    entree: { type: 'object', properties: {}, additionalProperties: false },
    async executer(deps: DepsMcp, tenantId, _args, personne) {
      const payeur = signataire(personne);
      const c = await deps.couteux.consommer(tenantId);
      if (!c.accepte) throw new RefusOutil(`${MESSAGE_OPERATIONS_LOURDES} (réessayer dans ${Math.max(1, Math.ceil(c.attenteMs / 1000))} s)`);
      return valeurOuRefus(await deps.numero.ouvrirPortail(tenantId, payeur));
    },
  },
  {
    nom: 'resubscribe_number',
    description:
      'Renouvelle l’abonnement du numéro WhatsApp fourni quand il est impayé ou terminé, et rend l’adresse à donner à la '
      + 'personne. Impayé (en retard, ou suspendu faute de paiement) : le portail de Stripe, pour payer la facture ouverte '
      + 'ou changer de carte. Terminé, numéro encore gardé : un nouveau paiement, qui rend le MÊME numéro sans refaire la '
      + 'fenêtre de Meta. Résiliation programmée : le portail, pour l’annuler. Compte dans les opérations lourdes de l’espace.',
    scope: 'mcp:write',
    exigePersonne: true,
    // Monde ouvert : une session est créée chez Stripe.
    annotations: { title: 'Renouveler l’abonnement du numéro', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    entree: { type: 'object', properties: {}, additionalProperties: false },
    async executer(deps: DepsMcp, tenantId, _args, personne) {
      const payeur = signataire(personne);
      const a = await deps.numero.abonnement(tenantId);
      if (a === null || a.etat === 'libere') {
        throw new RefusOutil('Cet espace n’a plus d’abonnement de numéro à renouveler : pour un nouveau numéro fourni, '
          + 'start_whatsapp_connection en mode « fourni ».');
      }
      if (a.etat === 'actif') throw new RefusOutil('L’abonnement du numéro est actif : rien à renouveler.');
      const c = await deps.couteux.consommer(tenantId);
      if (!c.accepte) throw new RefusOutil(`${MESSAGE_OPERATIONS_LOURDES} (réessayer dans ${Math.max(1, Math.ceil(c.attenteMs / 1000))} s)`);
      if (a.etat === 'suspendu' && a.finiLe !== null) {
        return {
          ...valeurOuRefus(await deps.numero.ouvrirAbonnement(tenantId, payeur)),
          consigne: 'Donne ce lien à la personne : le paiement rend le même numéro, et ses envois repartent dès que Stripe '
            + 'l’a confirmé (get_number_subscription le dit).',
        };
      }
      return {
        ...valeurOuRefus(await deps.numero.ouvrirPortail(tenantId, payeur)),
        consigne: a.etat === 'fin_prevue'
          ? 'Donne ce lien à la personne : dans le portail de Stripe, elle peut annuler la résiliation programmée.'
          : 'Donne ce lien à la personne : dans le portail de Stripe, elle paie la facture en attente ou change de carte.',
      };
    },
  },
  {
    nom: 'start_whatsapp_connection',
    description:
      'Rend le lien qui ouvre la page de connexion du numéro WhatsApp de l’espace, sans passer par la console, valable '
      + 'une heure : la personne y fait la fenêtre de Meta. `fourni` : on lui fournit un numéro dédié (3,50 € HT par mois, '
      + 'payé sur la page avant d’être attribué), dont le code de '
      + 'vérification arrive ici par watch_whatsapp_connection. `apporte` : son propre numéro ; demande-lui d’abord '
      + 's’il sert dans l’application WhatsApp, car la fenêtre de Meta le refuserait tant qu’il n’en est pas retiré. '
      + 'Refusé si l’espace a déjà un numéro connecté.',
    scope: 'mcp:write',
    exigePersonne: true,
    // Il ne touche rien chez un tiers et ne crée rien : un lien signé de plus à chaque appel.
    annotations: ecriture('Ouvrir la connexion du numéro WhatsApp', false),
    entree: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fourni', 'apporte'], description: 'fourni : un numéro que nous fournissons ; apporte : le numéro de la personne.' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    async executer(deps: DepsMcp, tenantId, args, personne) {
      const userId = signataire(personne);
      const mode = args.mode;
      if (mode !== 'fourni' && mode !== 'apporte') throw new RefusOutil('mode : « fourni » ou « apporte »');
      const relie = (await deps.numero.etat(tenantId)).connecte;
      if (relie?.aActiver) {
        throw new RefusOutil('Un numéro est déjà relié à cet espace, mais Meta ne l’a pas encore activé : il reste à finir sa '
          + 'vérification, dans l’Accueil de la console (« Activer le numéro »).');
      }
      if (relie) throw new RefusOutil('Cet espace a déjà un numéro WhatsApp connecté : il n’y a rien à brancher.');
      const jeton = await deps.numero.signerLien({ tenantId, userId, mode });
      return {
        url: `${deps.numero.urlConsole.replace(/\/+$/, '')}/brancher#${jeton}`,
        expire_le: new Date(deps.numero.maintenant() + DUREE_LIEN_NUMERO_MS).toISOString(),
        consigne: CONSIGNES[mode],
      };
    },
  },
  {
    nom: 'watch_whatsapp_connection',
    description:
      `Attend le prochain changement de la connexion du numéro (numéro attribué, code de vérification reçu, numéro `
      + `connecté) et rend l’état, au plus tard au bout de ${DELAI_ATTENTE_MS / 1000} secondes. Passe l’empreinte rendue `
      + 'par l’appel précédent (etat_connu) pour n’être réveillé que par du neuf ; sans elle, l’état est rendu tout de '
      + 'suite. Quand `code` est présent, lis-le à la personne : elle le recopie dans la fenêtre de Meta. Rappelle-le '
      + 'jusqu’à `connecte: true`.',
    scope: 'mcp:write',
    exigePersonne: true,
    // Écriture parce qu'il rend un code de vérification, pas parce qu'il modifie quoi que ce soit.
    annotations: ecriture('Suivre la connexion du numéro WhatsApp', true),
    entree: {
      type: 'object',
      properties: {
        etat_connu: {
          type: 'string', maxLength: 16, pattern: EMPREINTE_RE.source,
          description: 'L’empreinte rendue par l’appel précédent ; absente au premier appel.',
        },
      },
      additionalProperties: false,
    },
    async executer(deps: DepsMcp, tenantId, args, personne) {
      signataire(personne);
      const connu = args.etat_connu;
      if (connu !== undefined && (typeof connu !== 'string' || !EMPREINTE_RE.test(connu))) {
        throw new RefusOutil('etat_connu : l’empreinte rendue par l’appel précédent (16 caractères hexadécimaux)');
      }
      const debut = deps.numero.maintenant();
      for (;;) {
        const e = await deps.numero.etat(tenantId);
        const empreinte = empreinteEtat(e);
        const change = connu === undefined || empreinte !== connu;
        // 🔴 Jamais de lecture au-delà du délai : la boucle s'arrête d'elle-même, même si l'appelant a abandonné.
        if (change || deps.numero.maintenant() - debut + PAS_ATTENTE_MS > DELAI_ATTENTE_MS) {
          return {
            change,
            etat: vueEtat(e),
            code: e.code?.code ?? null,
            empreinte,
            suite: e.connecte?.aActiver
              ? 'Le numéro est relié, mais Meta ne l’a pas encore activé : la vérification n’est pas allée au bout. Dis-le à la '
                + 'personne : elle peut la terminer dans l’Accueil de la console (« Activer le numéro »).'
              : e.connecte
                ? 'Le numéro est connecté : le branchement est fini.'
                : 'Rappelle watch_whatsapp_connection avec etat_connu égal à cette empreinte pour attendre la suite.',
          };
        }
        await deps.numero.attendre(PAS_ATTENTE_MS);
      }
    },
  },
];
