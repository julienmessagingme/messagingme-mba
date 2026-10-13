import { ficheOutilMcp } from '../../web/lib/partage/catalogue-mcp';
import { ETAPES_NUMERO_FOURNI } from '../../web/lib/partage/etapes-numero-fourni';
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
  /**
   * La suite du numéro fourni que le Pro vivant annonce (lot 6, B2b, `PgAbonnementsOffreStore.suiteDuNumero`) : une
   * lecture légère, faite à chaque réponse d'outil pour le rappel.
   */
  suiteDuPro(tenantId: string): Promise<{ finPrevueLe: Date | null; rendreNumero: boolean } | null>;
  /** Rendre le numéro à la fin du Pro (`PgAbonnementsOffreStore.rendreLeNumero`) : `false` sans Pro vivant. */
  rendreLeNumero(tenantId: string, rendre: boolean): Promise<boolean>;
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
/**
 * Le rappel de la suite du numéro à la fin prévue du Pro (lot 6, B2b, décision de Julien : la console, Claude et un
 * e-mail l'annoncent). Rien tant que le Pro court sans fin, ni sans numéro fourni (`null`).
 */
export function rappelDeLaSuiteDuPro(s: { finPrevueLe: Date | null; rendreNumero: boolean } | null): string | null {
  if (s === null || s.finPrevueLe === null) return null;
  return s.rendreNumero
    ? `Rappel : le Pro de l’espace se termine le ${jour(s.finPrevueLe)}, et le numéro WhatsApp fourni sera alors rendu (ses `
      + 'envois coupés, puis libéré 7 jours après). return_number_at_plan_end avec rendre = false le garde.'
    : `Rappel : le Pro de l’espace se termine le ${jour(s.finPrevueLe)}. Le numéro WhatsApp fourni passera alors à 3,50 € HT `
      + 'par mois sur la même carte ; return_number_at_plan_end avec rendre = true le rend à la place.';
}

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

/**
 * La personne ne voit pas le résultat d'un outil : le lien n'existe pour elle que recopié. À l'essai réel 99
 * (2026-10-13), Claude a écrit « j'ai généré le lien » sans le lien, puis l'a donné dans un bloc de code, qu'un terminal
 * ne replie pas et coupe au bord de l'écran.
 */
const LIEN_EN_ENTIER = 'Écris ce lien EN ENTIER à la personne, en texte simple sur sa propre ligne : elle ne voit pas le '
  + 'résultat de cet outil, un résumé (« j’ai généré le lien ») ne lui donne rien, et un bloc de code le couperait dans '
  + 'un terminal. Dis-lui de garder la page ouverte jusqu’au bout. ';

/** Si la personne revient avant la fin (essai 99) : lui redire où elle en est, puis attendre à nouveau. */
const SI_ELLE_REVIENT = ' Si elle revient avant la fin, rappelle-lui où elle en est (la page du lien, la fenêtre de Meta, '
  + 'le numéro) avant d’attendre à nouveau.';

/** Des étapes numérotées sur une ligne : Claude les remet une par ligne, dans la langue de la personne. */
const numerotees = (etapes: readonly string[]): string => etapes.map((t, i) => `${i + 1}) ${t}`).join(' ');

/**
 * La consigne du numéro fourni : les étapes de la page (`ETAPES_NUMERO_FOURNI`, la même source), encadrées par le lien
 * et le paiement avant, et par le retour vers Claude après « Finish » (essai 99, ordre de Julien). En Pro (J4 de la
 * relecture de B2b), le numéro est inclus : la page l'obtient sans payer, et Claude n'annonce pas un prix qu'elle ne
 * demande pas.
 */
const consigneFourni = (inclusDansLePro: boolean): string =>
  LIEN_EN_ENTIER + 'Il ouvre la page de connexion de son numéro, sans se connecter, pendant une heure. Donne-lui ces '
  + 'étapes, numérotées, une par ligne, dans sa langue ; la page affiche les mêmes : '
  + numerotees([
    'Cliquer sur le lien.',
    inclusDansLePro
      ? '« Obtenir mon numéro » : il est inclus dans son Pro, rien à payer ; le numéro s’affiche sur la page.'
      : '« Payer 3,50 € HT par mois » ; une fois le paiement confirmé, le numéro s’affiche sur la page.',
    ...ETAPES_NUMERO_FOURNI.map((e) => e.fr),
    'Revenir te voir seulement une fois l’écran « Finish » passé.',
  ])
  + ' Appelle ensuite watch_whatsapp_connection : le code arrivera aussi ici, écris-le-lui en entier dès qu’il arrive.'
  + SI_ELLE_REVIENT;

const CONSIGNES = {
  apporte: LIEN_EN_ENTIER + 'Il ouvre la page de connexion de son numéro, sans se connecter, pendant une '
    + 'heure. Sur la page : la fenêtre de Meta, son numéro, et le code qu’elle reçoit elle-même. Appelle ensuite '
    + 'watch_whatsapp_connection pour savoir quand le numéro est connecté.' + SI_ELLE_REVIENT,
} as const;

const RAPPEL_ATTENTE = 'Rappelle watch_whatsapp_connection avec etat_connu égal à cette empreinte pour attendre la suite.';

/**
 * Ce que Claude dit ensuite, selon l'étape. À l'essai 99, il attendait en silence pendant que la personne ne savait plus
 * où aller, et annonçait le crédit lu avant la connexion (0 €) alors que le crédit offert venait d'arriver.
 */
function suiteDe(e: EtatConnexion): string {
  if (e.connecte?.aActiver) {
    return 'Le numéro est relié, mais Meta ne l’a pas encore activé : la vérification n’est pas allée au bout. Dis-le à la '
      + 'personne : elle peut la terminer dans l’Accueil de la console (« Activer le numéro »).';
  }
  if (e.connecte) {
    // Le crédit offert est écrit après la liaison, une fois Meta interrogé (relecture du lot) : quelques secondes.
    return 'Le numéro est connecté : le branchement est fini. Relis get_setup_state avant d’annoncer la suite : la '
      + 'connexion change l’état de l’espace. Le crédit offert au premier numéro arrive quelques secondes après : s’il '
      + 'est encore à 0, relis une fois quelques secondes plus tard avant d’en parler.';
  }
  if (e.code) {
    return 'Écris ce code en entier à la personne, en texte simple : elle le saisit dans la fenêtre de Meta (il s’affiche '
      + `aussi sur la page), puis va jusqu’au dernier écran, « Finish ». ${RAPPEL_ATTENTE}`;
  }
  if (e.fourni) {
    return `Le numéro ${e.fourni} est attribué. Redonne à la personne les étapes de la page si elle ne les a plus : `
      + `${numerotees(ETAPES_NUMERO_FOURNI.map((x) => x.fr))} Le code arrivera aussi ici. ${RAPPEL_ATTENTE}`;
  }
  if (e.abonnement?.statut === 'actif') {
    // Payé, mais la réserve s'est vidée entre-temps : la page dit « en préparation », Claude aussi.
    return 'Le paiement est reçu, mais le numéro est encore en préparation : la page l’affichera dès qu’il est prêt. '
      + `Dis-le à la personne, sans lui redonner le lien. ${RAPPEL_ATTENTE}`;
  }
  return 'Rien n’a encore bougé. Si la personne revient sans avoir avancé, redonne-lui le lien en entier et ses étapes '
    + `(start_whatsapp_connection en rend un neuf si l’heure est passée). ${RAPPEL_ATTENTE}`;
}

/** L'état tel que Claude le lit. Le code en clair n'y figure qu'à part (`code`), quand il est arrivé. */
function vueEtat(e: EtatConnexion): Record<string, unknown> {
  return {
    numero_fourni: e.fourni,
    code_recu_le: e.code?.recuLe ?? null,
    connecte: e.connecte !== null && !e.connecte.aActiver,
    a_activer: e.connecte?.aActiver === true,
    abonnement: e.abonnement?.statut ?? null,
    prochaine_echeance: e.abonnement?.periodeFin ?? null,
    inclus_dans_le_pro: e.inclusDansLePro,
    numero_connecte: e.connecte ? (e.connecte.chiffres ? `+${e.connecte.chiffres}` : null) : null,
  };
}

export const OUTILS_NUMERO: OutilMcp[] = [
  {
    ...ficheOutilMcp('return_number_at_plan_end'),
    fonction: null,
    description:
      'Choisit ce que devient le numéro WhatsApp fourni à la FIN du Pro de l’espace : rendre = true le rend (ses envois '
      + 'sont coupés à la fin du Pro, puis il est libéré 7 jours après) ; rendre = false le garde, à 3,50 € HT par mois sur '
      + 'la même carte que le Pro. Réversible tant que le Pro court ; refusé sans Pro en cours. Ne le faire que sur la '
      + 'demande explicite de la personne.',
    annotations: ecriture('Rendre le numéro à la fin du Pro', true),
    entree: {
      type: 'object',
      properties: { rendre: { type: 'boolean', description: 'true : rendre le numéro à la fin du Pro ; false : le garder.' } },
      required: ['rendre'],
      additionalProperties: false,
    },
    async executer(deps: DepsMcp, tenantId, args, personne) {
      signataire(personne);
      if (typeof args.rendre !== 'boolean') throw new RefusOutil('paramètre « rendre » requis : true ou false');
      if (!(await deps.numero.rendreLeNumero(tenantId, args.rendre))) {
        throw new RefusOutil('Cet espace n’a pas de Pro en cours : il n’y a pas de fin du Pro où rendre le numéro.');
      }
      return { rendre_numero: args.rendre };
    },
  },
  {
    ...ficheOutilMcp('get_number_subscription'),
    fonction: null,
    description:
      'L’abonnement du numéro WhatsApp fourni (3,50 € HT par mois) : son statut (actif, en_retard après un paiement échoué, '
      + 'resilie), la fin de la période payée, et le numéro. `abonnement: null` : l’espace n’a pas de numéro fourni payé. '
      + '`inclus_dans_le_pro: true` : le Pro de l’espace inclut le numéro, il n’y a rien à payer.',
    annotations: { title: 'Lire l’abonnement du numéro', readOnlyHint: true, openWorldHint: false },
    entree: { type: 'object', properties: {}, additionalProperties: false },
    async executer(deps: DepsMcp, tenantId) {
      // L'état calculé est un complément : une lecture qui échoue ne prive pas Claude du statut (jaune 7 de A).
      const [e, a] = await Promise.all([deps.numero.etat(tenantId), deps.numero.abonnement(tenantId).catch(() => null)]);
      return {
        abonnement: e.abonnement?.statut ?? null,
        prochaine_echeance: e.abonnement?.periodeFin ?? null,
        numero_fourni: e.fourni,
        prix: e.inclusDansLePro ? 'inclus dans le Pro' : '3,50 € HT par mois',
        inclus_dans_le_pro: e.inclusDansLePro,
        // Lot 4 : l'état calculé (actif, fin_prevue, en_retard, suspendu, libere) et ses dates.
        etat: a?.etat ?? null,
        fin_prevue: iso(a?.finPrevueLe),
        coupure_le: iso(a?.coupureLe),
        liberation_le: iso(a?.liberationLe),
      };
    },
  },
  {
    ...ficheOutilMcp('manage_number_subscription'),
    fonction: null,
    description:
      'Rend l’adresse du portail client de Stripe pour l’abonnement du numéro : changer de carte, lire les factures, '
      + 'résilier. À donner à la personne : le geste reste le sien. Compte dans les opérations lourdes de l’espace.',
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
    ...ficheOutilMcp('resubscribe_number'),
    fonction: null,
    description:
      'Renouvelle l’abonnement du numéro WhatsApp fourni quand il est impayé ou terminé, et rend l’adresse à donner à la '
      + 'personne. Impayé (en retard, ou suspendu faute de paiement) : le portail de Stripe, pour payer la facture ouverte '
      + 'ou changer de carte. Terminé, numéro encore gardé : un nouveau paiement, qui rend le MÊME numéro sans refaire la '
      + 'fenêtre de Meta. Résiliation programmée : le portail, pour l’annuler. Compte dans les opérations lourdes de l’espace.',
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
    ...ficheOutilMcp('start_whatsapp_connection'),
    fonction: null,
    description:
      'Rend le lien qui ouvre la page de connexion du numéro WhatsApp de l’espace, sans passer par la console, valable '
      + 'une heure : la personne y fait la fenêtre de Meta. `fourni` : on lui fournit un numéro dédié (3,50 € HT par mois, '
      + 'payé sur la page avant d’être attribué ; inclus, sans rien payer, pour un espace en Pro), dont le code de '
      + 'vérification arrive ici par watch_whatsapp_connection. `apporte` : son propre numéro ; demande-lui d’abord '
      + 's’il sert dans l’application WhatsApp, car la fenêtre de Meta le refuserait tant qu’il n’en est pas retiré. '
      + 'Refusé si l’espace a déjà un numéro connecté.',
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
      const etat = await deps.numero.etat(tenantId);
      const relie = etat.connecte;
      if (relie?.aActiver) {
        throw new RefusOutil('Un numéro est déjà relié à cet espace, mais Meta ne l’a pas encore activé : il reste à finir sa '
          + 'vérification, dans l’Accueil de la console (« Activer le numéro »).');
      }
      if (relie) throw new RefusOutil('Cet espace a déjà un numéro WhatsApp connecté : il n’y a rien à brancher.');
      const jeton = await deps.numero.signerLien({ tenantId, userId, mode });
      return {
        url: `${deps.numero.urlConsole.replace(/\/+$/, '')}/brancher#${jeton}`,
        expire_le: new Date(deps.numero.maintenant() + DUREE_LIEN_NUMERO_MS).toISOString(),
        consigne: mode === 'fourni' ? consigneFourni(etat.inclusDansLePro) : CONSIGNES.apporte,
      };
    },
  },
  {
    ...ficheOutilMcp('watch_whatsapp_connection'),
    fonction: null,
    description:
      `Attend le prochain changement de la connexion du numéro (numéro attribué, code de vérification reçu, numéro `
      + `connecté) et rend l’état, au plus tard au bout de ${DELAI_ATTENTE_MS / 1000} secondes. Passe l’empreinte rendue `
      + 'par l’appel précédent (etat_connu) pour n’être réveillé que par du neuf ; sans elle, l’état est rendu tout de '
      + 'suite. Quand `code` est présent, lis-le à la personne : elle le recopie dans la fenêtre de Meta. Rappelle-le '
      + 'jusqu’à `connecte: true`.',
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
            suite: suiteDe(e),
          };
        }
        await deps.numero.attendre(PAS_ATTENTE_MS);
      }
    },
  },
];
