import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import { TenantConflictError, SecondNumeroRefuseError } from '../account/es-store.pg';
import { espaceVerifie, nonEmpty } from './scope';
import { makeJournal, type AuditSink } from '../audit/journal';
import { texteDe } from '../lib/erreur';
import type { Prise, VerrousCourts } from '../db/verrous-courts';

/** Les appels Graph de l'inscription, faits avec le business token que le parcours vient d'obtenir. */
export interface MetaInscriptionDep {
  exchangeCode(code: string): Promise<string>;
  /** Preuve d'appartenance du WABA (GET /{waba_id} avec le business token) : throw si le token ne le possède pas. */
  verifyWaba(wabaId: string, businessToken: string): Promise<void>;
  /**
   * Comptes WhatsApp auxquels le business token donne accès. Sert quand la popup n'a pas annoncé les identifiants
   * (client qui rouvre un parcours déjà abouti : Meta n'a plus rien à configurer, donc plus rien à annoncer).
   */
  wabasForToken(businessToken: string): Promise<string[]>;
  listPhones(wabaId: string, businessToken: string): Promise<Array<{ id: string }>>;
  getPhone(phoneNumberId: string, businessToken: string): Promise<{ displayPhoneNumber: string | null; verifiedName: string | null; status: string | null; codeVerificationStatus?: string | null }>;
  subscribeApp(wabaId: string, businessToken: string): Promise<void>;
  register(phoneNumberId: string, businessToken: string, pin: string): Promise<void>;
}

export interface EmbeddedSignupRouteDeps {
  /**
   * Journal d'audit (les fixtures qui ne l'observent pas passent `journalMuet`). Rattacher un numéro, c'est donner
   * une voix : le produit parle aux clients sous cette identité, et un token business chiffré est conservé.
   * 🔴 Le `detail` ne porte pas le numéro affiché (donnée personnelle, table jamais purgée), seulement les
   * identifiants Meta du compte et du numéro.
   */
  audit: AuditSink;
  /** config_id de la configuration ES (dashboard Meta, Facebook Login for Business). Vide -> feature OFF. */
  configId: string;
  /** App ID Meta (public : sert au FB.init du front). */
  appId: string;
  graphVersion: string;
  meta: MetaInscriptionDep;
  inscriptions: {
    linkTenant(input: { tenantId: string; wabaId: string; phoneNumberId: string; displayPhoneNumber: string | null; verifiedName: string | null }): Promise<void>;
    /**
     * Relie à l'espace un compte WhatsApp revenu de la fenêtre SANS numéro (lot 3b : le numéro fourni, que le serveur
     * ajoute ensuite). Lève `TenantConflictError` (compte d'un autre espace) ou `SecondNumeroRefuseError` (l'espace a
     * déjà un numéro).
     */
    lierCompteSansNumero(input: { tenantId: string; wabaId: string }): Promise<void>;
  };
  /**
   * Le crédit de bienvenue (`CREDIT_OFFERT_MICRO_EUR`, 1 € depuis le lot 6), pour un numéro de cet espace que Meta dit
   * VÉRIFIÉ. La route ne l'appelle qu'avec cette preuve : à l'inscription si Meta le dit déjà vérifié (ou vient
   * d'accepter son enregistrement), sinon à l'activation, dès que le code est accepté. Une fois par espace, jamais
   * deux fois pour un numéro : ce sont les contraintes de la base qui le tiennent (migrations 0191 et 0193), donc
   * l'appeler deux fois est sans effet. Requis : un câblage qui l'oublierait relierait des numéros sans rien offrir.
   * Ne fait pas attendre la route pour la clé de modèle : le câblage remonte son plafond en arrière-plan.
   */
  offrirCredit(tenantId: string, phoneNumberId: string): Promise<void>;
  /** Persiste le token business (le câblage chiffre avant, la route ne voit jamais le stockage en clair). */
  saveCredentials(wabaId: string, tenantId: string, businessToken: string, pin: string | null): Promise<void>;

  // ----- « Activer le numéro » : finir chez nous ce que la fenêtre Meta a laissé en plan -----
  //
  // Aucune de ces dépendances n'est optionnelle : un câblage qui les oublie ne compile pas. Aucune ne reçoit de
  // jeton : le câblage le résout, et un jeton qui n'entre pas dans la route ne peut ni fuiter ni partir.

  /**
   * Numéro principal de l'espace (identifiant Meta), `null` si aucun. 🔴 Lu en base, jamais pris dans le corps :
   * un admin ne peut pas activer le numéro d'un autre espace en forgeant un identifiant.
   */
  numeroDuTenant(tenantId: string): Promise<string | null>;
  /**
   * État du numéro chez Meta, relu avant chaque geste, jamais lu dans notre base : c'est Meta qui tranche, et
   * notre copie date du dernier pull.
   */
  etatNumero(tenantId: string, phoneNumberId: string): Promise<{ status: string | null; codeVerificationStatus: string | null }>;
  /** Demande à Meta d'envoyer le code, par appel (VOICE) ou par SMS. */
  demanderCode(tenantId: string, phoneNumberId: string, methode: 'VOICE' | 'SMS'): Promise<void>;
  /** Poste le code reçu par le client. */
  verifierCode(tenantId: string, phoneNumberId: string, code: string): Promise<void>;
  /** Enregistre le numéro sur la Cloud API avec ce PIN (c'est son PIN 2FA). */
  enregistrerNumero(tenantId: string, phoneNumberId: string, pin: string): Promise<void>;
  /** Conserve le PIN, chiffré par le câblage, seulement après que Meta l'a accepté. */
  sauverPin(tenantId: string, pin: string): Promise<void>;

  // ----- « Délier » et « Relier » : l'interrupteur du numéro sur l'Accueil -----
  //
  // Requises, comme les précédentes. Aucune ne parle à Meta : délier est un état de cet espace, le numéro reste
  // relié à son compte WhatsApp et son jeton reste chiffré chez nous.

  /**
   * Délie le numéro de l'espace et met en pause ses campagnes WhatsApp en cours ou programmées
   * (`PgNumeroDelieStore.delier`). `null` = l'espace n'a aucun numéro.
   */
  delierNumero(tenantId: string): Promise<{ delieLe: string; campagnesEnPause: number } | null>;
  /**
   * Relie le numéro et lève les pauses `numero_delie` (`PgNumeroDelieStore.relier`). `null` = aucun numéro.
   */
  relierNumero(tenantId: string): Promise<{ campagnesReprises: number; campagnesReprogrammees: number } | null>;

  /**
   * Les verrous courts partagés par les copies de l'API (`src/db/verrous-courts.ts`) : ils tiennent la minute entre
   * deux demandes de code d'un numéro, quelle que soit la copie qui sert chacune. Requis : en mémoire, deux copies
   * laissaient partir deux demandes dans la même minute, et chacune coûte un des dix essais de Meta.
   */
  verrous: Pick<VerrousCourts, 'prendre'>;
}

/**
 * Délai minimal entre deux demandes de code pour un même numéro. Ce n'est pas un plafond de débit, c'est le
 * quota de Meta : dix requêtes par numéro sur 72 heures, toutes étapes confondues, au-delà le numéro est bloqué
 * 72 heures (133016). Tenu par un verrou court, jamais relâché : son échéance EST le délai, et elle est commune à
 * toutes les copies de l'API (lot B, 2026-09-28).
 */
export const DELAI_ENTRE_CODES_MS = 60_000;

/**
 * Un seul numéro par espace : le message dit ce qui est déjà là et quoi faire, sinon l'opérateur conclut à une panne et
 * recommence. Rendu en 409 et non en 5xx, sinon Cloudflare remplace le corps par sa page.
 */
function messageSecondNumero(err: SecondNumeroRefuseError): string {
  return `Cet espace utilise déjà le numéro ${err.dejaRattache}. Un espace ne peut piloter qu'un seul numéro WhatsApp : pour en connecter un autre, crée un second espace, ou détache d'abord le numéro actuel.`;
}

/** La clé du délai d'un numéro dans les verrous courts, préfixée pour ne croiser aucun autre usage. */
export function cleDemandeCode(phoneNumberId: string): string {
  return `es-code:${phoneNumberId}`;
}

/**
 * Embedded Signup (Tech Provider), admin. Quatre routes :
 *  - GET  /embedded-signup/config   : de quoi le front lance la popup (appId + configId publics, pas de secret).
 *  - POST /embedded-signup/complete : reçoit { code, wabaId, phoneNumberId } de la popup (code TTL 30 s),
 *    échange le code contre un business token, rattache WABA et numéro à l'espace, abonne les webhooks, register
 *    un numéro neuf (jamais un numéro déjà CONNECTED ni non vérifié), stocke le token chiffré, et offre le crédit
 *    de bienvenue si Meta dit le numéro vérifié. Les étapes non bloquantes qui échouent remontent en `warnings`.
 *  - POST /numero/code              : Meta envoie le code de vérification du numéro (appel par défaut, ou SMS).
 *  - POST /numero/activer           : vérifie le code s'il le faut (le crédit de bienvenue part alors), puis
 *    enregistre le numéro sur la Cloud API.
 * Les deux dernières existent parce que la fenêtre Meta peut se terminer sur un numéro non vérifié.
 */
export function registerEmbeddedSignup(
  app: FastifyInstance,
  deps: EmbeddedSignupRouteDeps,
  /**
   * La garde des quatre routes de la connexion : `adminOuLien`, la session d'admin OU le lien que donne Claude Code
   * (lot 3c). « Délier » et « relier » ne sont pas de la connexion : elles restent sur `gardeAdmin`.
   */
  garde: Guard,
  gardeAdmin: Guard,
  limiteCouteuse?: PreHandler,
): void {
  const journal = makeJournal(deps.audit);
  const opts = { preHandler: garde };
  const optsAdmin = { preHandler: gardeAdmin };
  // Les deux routes d'activation appellent Meta sur un quota étroit : elles portent la limite coûteuse, comme
  // l'import ou l'aperçu de site.
  const couteux = gardeEtendue(garde, limiteCouteuse);

  /**
   * Le crédit de bienvenue, APRÈS le geste que Meta a accepté. Il ne lève jamais : Meta a déjà relié, vérifié ou
   * activé le numéro, et faire échouer la route annoncerait une panne au client, qui recommencerait un geste
   * compté par Meta. Un échec se journalise ; l'offre reste due au prochain geste réussi (elle est idempotente).
   */
  const offrir = async (tenant: string, phoneNumberId: string): Promise<void> => {
    try {
      await deps.offrirCredit(tenant, phoneNumberId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`credit offert: non ecrit (tenant ${tenant}, numéro ${phoneNumberId}) : ${texteDe(err)}`);
    }
  };

  app.get('/tenants/:tenantId/embedded-signup/config', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const enabled = deps.configId !== '' && deps.appId !== '';
    return reply.code(200).send({ enabled, appId: deps.appId, configId: deps.configId, graphVersion: deps.graphVersion });
  });

  app.post('/tenants/:tenantId/embedded-signup/complete', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (deps.configId === '') return reply.code(503).send({ error: 'Embedded Signup non configuré (META_ES_CONFIG_ID)' });
    const b = (req.body ?? {}) as { code?: unknown; wabaId?: unknown; phoneNumberId?: unknown; evenement?: unknown };
    // `wabaId` / `phoneNumberId` sont facultatifs : la popup ne les annonce que lorsqu'elle exécute vraiment la
    // configuration, et un client qui rouvre un parcours abouti n'obtient qu'un code. Absents -> retrouvés (1 bis).
    if (!nonEmpty(b.code)) return reply.code(400).send({ error: 'code requis' });
    const code = b.code.trim();

    // 1. Code -> business token. Échec = rien n'est rattaché (le code a un TTL de 30 s : re-cliquer suffit).
    let businessToken: string;
    try {
      businessToken = await deps.meta.exchangeCode(code);
    } catch (err) {
      const msg = texteDe(err);
      // eslint-disable-next-line no-console
      console.error(`embedded-signup: échange du code impossible (tenant ${tenant}) : ${msg}`);
      return reply.code(422).send({ error: `échange du code Meta échoué : ${msg}` });
    }

    // 1 bis. Identifiants non annoncés -> on les lit dans le token (les comptes auxquels il donne accès), puis
    //        dans le compte (ses numéros). Aucune perte de sûreté : ils viennent du token du client lui-même,
    //        ils ne peuvent donc pas désigner les biens d'un autre, et l'étape 2 les vérifie quand même. On
    //        refuse l'ambiguïté (plusieurs comptes ou plusieurs numéros) au lieu d'en choisir un au hasard :
    //        rattacher le mauvais numéro serait bien pire qu'un message d'erreur.
    let wabaId = nonEmpty(b.wabaId) ? b.wabaId.trim() : '';
    let phoneNumberId = nonEmpty(b.phoneNumberId) ? b.phoneNumberId.trim() : '';
    // Le compte n'a aucun numéro : le client a fini la fenêtre sans en ajouter (étape 1 ter).
    let sansNumero = false;
    if (wabaId === '' || phoneNumberId === '') {
      try {
        if (wabaId === '') {
          const wabas = await deps.meta.wabasForToken(businessToken);
          if (wabas.length === 0) {
            // eslint-disable-next-line no-console
            console.error(`embedded-signup: le token du tenant ${tenant} n'expose aucun compte WhatsApp (granular_scopes sans cible)`);
            return reply.code(422).send({ error: 'le compte Meta connecté n’expose aucun compte WhatsApp. Termine le parcours Meta jusqu’au bout, en partageant bien ton compte WhatsApp avec l’application.' });
          }
          if (wabas.length > 1) {
            return reply.code(409).send({ error: `ce compte Meta donne accès à ${wabas.length} comptes WhatsApp : impossible de deviner lequel rattacher.` });
          }
          wabaId = wabas[0]!;
        }
        if (phoneNumberId === '') {
          const phones = await deps.meta.listPhones(wabaId, businessToken);
          if (phones.length > 1) {
            return reply.code(409).send({ error: `ce compte WhatsApp contient ${phones.length} numéros : impossible de deviner lequel rattacher.` });
          }
          if (phones.length === 0) sansNumero = true;
          else phoneNumberId = phones[0]!.id;
        }
        // eslint-disable-next-line no-console
        console.info(`embedded-signup: identifiants retrouvés depuis le token (waba=${wabaId}, numéro=${sansNumero ? 'aucun' : phoneNumberId}) faute d'annonce par la popup`);
      } catch (err) {
        const msg = texteDe(err);
        // eslint-disable-next-line no-console
        console.error(`embedded-signup: repêchage des identifiants impossible (tenant ${tenant}) : ${msg}`);
        return reply.code(422).send({ error: `lecture du compte WhatsApp impossible : ${msg}` });
      }
    }

    // 1 ter. Compte SANS numéro (lot 3b) : en v4, la fenêtre laisse finir sans numéro, et c'est le parcours du
    //        numéro fourni, où le serveur ajoute ensuite le nôtre. On relie le compte et on garde son jeton, sans
    //        lequel rien ne pourra plus y être ajouté ; rien n'est offert, aucun numéro n'existe encore. Même preuve
    //        d'appartenance et mêmes refus qu'avec un numéro. Le jeton se garde APRÈS la liaison : sa table
    //        référence le compte.
    if (sansNumero) {
      try {
        await deps.meta.verifyWaba(wabaId, businessToken);
      } catch (err) {
        const msg = texteDe(err);
        // eslint-disable-next-line no-console
        console.error(`embedded-signup: preuve d'appartenance refusée (tenant ${tenant}, waba ${wabaId}, sans numéro) : ${msg}`);
        return reply.code(422).send({ error: `le compte Meta connecté ne donne pas accès à ce compte WhatsApp : ${msg}` });
      }
      try {
        await deps.inscriptions.lierCompteSansNumero({ tenantId: tenant, wabaId });
      } catch (err) {
        if (err instanceof TenantConflictError) {
          return reply.code(409).send({ error: 'ce compte WhatsApp est déjà rattaché à un autre workspace' });
        }
        if (err instanceof SecondNumeroRefuseError) return reply.code(409).send({ error: messageSecondNumero(err) });
        throw err;
      }
      const avertissements: string[] = [];
      try {
        await deps.meta.subscribeApp(wabaId, businessToken);
      } catch (err) {
        avertissements.push(`abonnement webhooks : ${texteDe(err)}`);
      }
      await deps.saveCredentials(wabaId, tenant, businessToken, null);
      await journal(tenant, req, 'compte.relie_sans_numero', { kind: 'waba', id: wabaId }, { avertissements: avertissements.length });
      // L'événement que la fenêtre a annoncé (`FINISH_ONLY_WABA` attendu) : ce que Meta renvoie sur une fin sans
      // numéro n'est pas documenté, la tâche 0 du plan le mesure. Majuscules et soulignés seulement.
      const evenement = typeof b.evenement === 'string' && /^[A-Z_]{1,40}$/.test(b.evenement) ? b.evenement : 'aucun';
      // eslint-disable-next-line no-console
      console.info(`embedded-signup: compte relié SANS numéro (tenant ${tenant}, waba ${wabaId}, événement de la fenêtre ${evenement})`);
      return reply.code(200).send({
        connected: false,
        sansNumero: true,
        wabaId,
        warnings: [
          'Ton compte WhatsApp est relié, sans numéro pour l’instant. Pour connecter ton propre numéro, relance « Connecter » et saisis-le dans la fenêtre Meta.',
          ...avertissements,
        ],
      });
    }

    // 2. 🔴 Preuve d'appartenance (garde anti-hijack entre espaces) : le business token ne peut lire le WABA et le
    //    numéro que s'ils appartiennent au client qui a complété l'ES. Appels bloquants : un échec -> 422 et rien
    //    n'est persisté. Sans ça, un espace rattacherait les assets d'un autre en forgeant wabaId/phoneNumberId.
    //    `getPhone` rend aussi le vrai `status` (décide du register).
    let phone: { displayPhoneNumber: string | null; verifiedName: string | null; status: string | null; codeVerificationStatus?: string | null };
    try {
      await deps.meta.verifyWaba(wabaId, businessToken);
      phone = await deps.meta.getPhone(phoneNumberId, businessToken);
    } catch (err) {
      const msg = texteDe(err);
      // eslint-disable-next-line no-console
      console.error(`embedded-signup: preuve d'appartenance refusée (tenant ${tenant}, waba ${wabaId}, numéro ${phoneNumberId}) : ${msg}`);
      return reply.code(422).send({ error: `le compte Meta connecté ne donne pas accès à ce numéro/WABA : ${msg}` });
    }

    const warnings: string[] = [];
    // 3. 🔴 Rattachement à l'espace. Un WABA ou numéro déjà rattaché à un autre espace est refusé (409), pas
    //    réaffecté en silence, avant webhooks, register et token. La migration volontaire passe par le chemin admin.
    try {
      await deps.inscriptions.linkTenant({ tenantId: tenant, wabaId, phoneNumberId, displayPhoneNumber: phone.displayPhoneNumber, verifiedName: phone.verifiedName });
    } catch (err) {
      if (err instanceof TenantConflictError) {
        return reply.code(409).send({ error: 'ce numéro ou ce WABA est déjà rattaché à un autre workspace' });
      }
      if (err instanceof SecondNumeroRefuseError) return reply.code(409).send({ error: messageSecondNumero(err) });
      throw err;
    }

    // 4. Webhooks du WABA -> notre app (idempotent). Échec = averti (sans webhooks : ni statuts ni réponses).
    try {
      await deps.meta.subscribeApp(wabaId, businessToken);
    } catch (err) {
      warnings.push(`abonnement webhooks : ${texteDe(err)}`);
    }

    // 5. Register seulement pour un numéro neuf (pas déjà sur la Cloud API), avec un PIN généré et conservé (le
    //    PIN 2FA du numéro, nécessaire aux re-régistrations). Et seulement s'il est vérifié : sinon `register` est
    //    refusé (133006) et chaque tentative consomme une des 10 requêtes par numéro sur 72 h. Seul `NOT_VERIFIED`
    //    retient le register (`EXPIRED` n'a jamais été vu). Le numéro reste rattaché : « Activer le numéro » finit.
    let pin: string | null = null;
    const aActiver = phone.status !== 'CONNECTED' && phone.codeVerificationStatus === 'NOT_VERIFIED';
    if (aActiver) {
      // eslint-disable-next-line no-console
      console.warn(`embedded-signup: numéro non vérifié, register non tenté (tenant ${tenant}, waba ${wabaId}, numéro ${phoneNumberId})`);
      warnings.push("ce numéro n'a pas encore été vérifié chez Meta : il est rattaché mais ne peut pas encore envoyer. Termine avec « Activer le numéro » sur l'Accueil.");
    } else if (phone.status !== 'CONNECTED') {
      pin = String(randomInt(100000, 1000000)); // PIN 2FA du numéro : CSPRNG (cohérent avec le reste du repo)
      try {
        await deps.meta.register(phoneNumberId, businessToken, pin);
      } catch (err) {
        const msg = texteDe(err);
        // Journalisé, et pas seulement rendu : `warnings` est effacé par l'écran au rechargement du compte.
        // eslint-disable-next-line no-console
        console.error(`embedded-signup: register refusé (tenant ${tenant}, waba ${wabaId}, numéro ${phoneNumberId}) : ${msg}`);
        warnings.push(`register du numéro : ${msg}`);
        pin = null; // le pin n'a pas été posé -> ne pas le stocker comme s'il l'était
      }
    }

    // 6. Token business conservé (chiffré au repos par le câblage).
    await deps.saveCredentials(wabaId, tenant, businessToken, pin);

    // Après l'enregistrement des identifiants (avant, on tracerait une intention). `avertissements` est
    // journalisé : un numéro rattaché avec des avertissements est un état réel.
    await journal(tenant, req, 'numero.connecte', { kind: 'phone_number', id: phoneNumberId }, {
      wabaId, avertissements: warnings.length,
    });

    // 7. 🔴 Le crédit de bienvenue, SEULEMENT pour un numéro que Meta dit vérifié : déjà sur la Cloud API, code
    //    vérifié, ou enregistrement que Meta vient d'accepter (`pin` n'est gardé que dans ce cas). Il était offert
    //    à l'étape 3, avant ce constat : un numéro `NOT_VERIFIED` recevait son crédit. Sinon, c'est l'activation qui
    //    l'offrira, dès que le code sera accepté.
    if (phone.status === 'CONNECTED' || phone.codeVerificationStatus === 'VERIFIED' || pin !== null) {
      await offrir(tenant, phoneNumberId);
    }
    return reply.code(200).send({
      connected: true,
      wabaId,
      phoneNumberId,
      displayPhoneNumber: phone.displayPhoneNumber,
      // `aActiver` n'est posé que dans ce cas : l'écran s'en sert pour envoyer tout de suite vers l'activation,
      // au lieu de laisser croire que le numéro est prêt à envoyer.
      ...(aActiver ? { aActiver: true } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  });

  /**
   * Demande à Meta d'envoyer le code de vérification du numéro de l'espace. Elle lit l'état avant d'agir : Meta
   * refuse une demande sur un numéro déjà vérifié (136024), et chaque refus consomme une des dix requêtes.
   */
  app.post('/tenants/:tenantId/numero/code', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const body = (req.body ?? {}) as { methode?: unknown };
    const methode = body.methode === undefined ? 'VOICE' : body.methode;
    // VOICE par défaut : Meta déconseille le SMS sur un numéro VoIP, et un numéro qui ne reçoit pas de SMS
    // laisserait le client sans recours. Le SMS reste offert, c'est lui qui sait ce qu'est son numéro.
    if (methode !== 'VOICE' && methode !== 'SMS') return reply.code(400).send({ error: "methode invalide ('VOICE' ou 'SMS')" });

    const phoneNumberId = await deps.numeroDuTenant(tenant);
    if (phoneNumberId === null) return reply.code(404).send({ error: 'aucun numéro rattaché à cet espace' });

    let etat: { status: string | null; codeVerificationStatus: string | null };
    try {
      etat = await deps.etatNumero(tenant, phoneNumberId);
    } catch (err) {
      const msg = texteDe(err);
      // eslint-disable-next-line no-console
      console.error(`numero/code: état illisible chez Meta (tenant ${tenant}, numéro ${phoneNumberId}) : ${msg}`);
      return reply.code(422).send({ error: `état du numéro illisible chez Meta : ${msg}` });
    }
    if (etat.status === 'CONNECTED') return reply.code(409).send({ error: 'ce numéro est déjà activé : il peut envoyer.' });
    if (etat.codeVerificationStatus === 'VERIFIED') {
      return reply.code(409).send({ error: 'ce numéro est déjà vérifié : il ne reste qu’à l’activer, sans nouveau code.' });
    }

    /**
     * La marque est posée avant l'appel : Meta compte des requêtes, pas des succès, et un refus consomme aussi un
     * essai. Marquer au seul succès laisserait sans protection le client qui reclique après un échec : une minute
     * d'attente contre 72 heures de numéro bloqué. 🔴 FERMÉ SUR PANNE : si la base ne dit pas qu'aucune demande n'est
     * partie dans la minute, Meta n'est pas appelé (un essai brûlé ne se rend pas).
     */
    let delai: Prise | null;
    try {
      delai = await deps.verrous.prendre([[cleDemandeCode(phoneNumberId), DELAI_ENTRE_CODES_MS]]);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`numero/code: délai entre deux codes illisible (tenant ${tenant}, numéro ${phoneNumberId}) : ${texteDe(err)}`);
      return reply.code(429).send({ error: 'impossible de vérifier le dernier envoi de code pour l’instant : réessaie dans un instant. Meta n’en permet que dix par numéro sur 72 heures.' });
    }
    if (delai === null) {
      return reply.code(429).send({ error: 'un code vient d’être envoyé. Attends une minute avant d’en redemander un : Meta n’en permet que dix par numéro sur 72 heures.' });
    }
    try {
      await deps.demanderCode(tenant, phoneNumberId, methode);
    } catch (err) {
      const msg = texteDe(err);
      // Journalisé avec le code de Meta, jamais avec le code reçu par le client.
      // eslint-disable-next-line no-console
      console.error(`numero/code: refus de Meta (tenant ${tenant}, numéro ${phoneNumberId}, ${methode}) : ${msg}`);
      return reply.code(422).send({ error: `Meta a refusé l’envoi du code : ${msg}` });
    }
    return reply.code(200).send({ envoye: true, methode });
  });

  /**
   * Active le numéro : vérifie le code s'il le faut, puis l'enregistre sur la Cloud API. Aucune relance
   * automatique : un échec laisse le numéro « à activer », et une répétition invisible consommerait le quota.
   */
  app.post('/tenants/:tenantId/numero/activer', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const body = (req.body ?? {}) as { code?: unknown };

    const phoneNumberId = await deps.numeroDuTenant(tenant);
    if (phoneNumberId === null) return reply.code(404).send({ error: 'aucun numéro rattaché à cet espace' });

    let etat: { status: string | null; codeVerificationStatus: string | null };
    try {
      etat = await deps.etatNumero(tenant, phoneNumberId);
    } catch (err) {
      const msg = texteDe(err);
      // eslint-disable-next-line no-console
      console.error(`numero/activer: état illisible chez Meta (tenant ${tenant}, numéro ${phoneNumberId}) : ${msg}`);
      return reply.code(422).send({ error: `état du numéro illisible chez Meta : ${msg}` });
    }
    // Déjà activé : on ne fait rien et on le dit. Un register de plus serait un essai brûlé pour confirmer ce
    // que Meta vient de nous dire. Le numéro est vérifié (Meta l'a activé, par exemple depuis son propre écran) :
    // le crédit de bienvenue lui revient s'il ne l'a pas déjà eu.
    if (etat.status === 'CONNECTED') {
      await offrir(tenant, phoneNumberId);
      return reply.code(200).send({ actif: true, deja: true });
    }

    // Vérification, seulement si Meta dit que le numéro ne l'est pas. Sur un numéro déjà vérifié, elle
    // échouerait, et l'échec coûterait un essai.
    if (etat.codeVerificationStatus !== 'VERIFIED') {
      if (!nonEmpty(body.code)) {
        return reply.code(400).send({ error: 'code requis : ce numéro n’est pas encore vérifié chez Meta. Demande un code, puis saisis-le.' });
      }
      try {
        await deps.verifierCode(tenant, phoneNumberId, body.code.trim());
      } catch (err) {
        const msg = texteDe(err);
        // Le code reçu n'est jamais journalisé, ni le PIN : seuls l'identifiant du numéro et le refus de Meta.
        // eslint-disable-next-line no-console
        console.error(`numero/activer: code refusé par Meta (tenant ${tenant}, numéro ${phoneNumberId}) : ${msg}`);
        return reply.code(422).send({ error: `Meta a refusé ce code : ${msg}` });
      }
    }

    // 🔴 Ici, Meta dit le numéro VÉRIFIÉ : il l'était déjà, ou il vient d'accepter le code. C'est le point juste du
    // crédit de bienvenue, avant l'enregistrement : un enregistrement refusé ensuite ne défait pas la vérification.
    await offrir(tenant, phoneNumberId);

    // Enregistrement sur la Cloud API. Le PIN est le PIN 2FA du numéro : tiré au CSPRNG, et conservé seulement
    // si Meta l'accepte. En conserver un que Meta n'a pas posé donnerait un secret faux en base, qui ferait
    // échouer la prochaine re-régistration sans cause visible.
    const pin = String(randomInt(100000, 1000000));
    try {
      await deps.enregistrerNumero(tenant, phoneNumberId, pin);
    } catch (err) {
      const msg = texteDe(err);
      // eslint-disable-next-line no-console
      console.error(`numero/activer: register refusé par Meta (tenant ${tenant}, numéro ${phoneNumberId}) : ${msg}`);
      return reply.code(422).send({ error: `Meta a refusé l’activation : ${msg}` });
    }
    // Au mieux, et après l'effet : Meta a activé le numéro, faire échouer la route annoncerait une panne et ferait
    // brûler un essai. Un numéro branché à la main n'a aucune ligne de credentials où écrire. L'échec est journalisé.
    try {
      await deps.sauverPin(tenant, pin);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`numero/activer: numéro activé mais PIN non conservé (tenant ${tenant}, numéro ${phoneNumberId}) : ${texteDe(err)}`);
    }
    await journal(tenant, req, 'numero.active', { kind: 'phone_number', id: phoneNumberId }, {
      verificationFaite: etat.codeVerificationStatus !== 'VERIFIED',
    });
    return reply.code(200).send({ actif: true });
  });

  /**
   * Délie le numéro de l'espace (interrupteur « Numéro WhatsApp » de l'Accueil, éteint) : aucun envoi ne part
   * (`NumeroDelieError`), les campagnes WhatsApp en cours ou programmées passent en pause `numero_delie`, et les
   * messages reçus ne sont plus enregistrés. Rien n'est touché chez Meta ni supprimé chez nous : « Relier » se
   * fait d'un clic. Admin seulement (`g.admin`).
   */
  app.post('/tenants/:tenantId/numero/delier', optsAdmin, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await deps.delierNumero(tenant);
    if (r === null) return reply.code(404).send({ error: 'aucun numéro rattaché à cet espace' });
    // L'identifiant de l'espace en cible : délier porte sur tous ses numéros, et le numéro affiché est une donnée
    // personnelle que ce journal, jamais purgé, n'a pas à porter.
    await journal(tenant, req, 'numero.delie', { kind: 'tenant', id: tenant }, { campagnesEnPause: r.campagnesEnPause });
    return reply.code(200).send({ delie: true, delieLe: r.delieLe, campagnesEnPause: r.campagnesEnPause });
  });

  /**
   * Relie le numéro, sans confirmation (éteindre se confirme, rallumer non). Les campagnes mises en pause par
   * « Délier » repartent : `running` pour celles qui tournaient (reprises par le balayage), `scheduled` pour les
   * programmées.
   */
  app.post('/tenants/:tenantId/numero/relier', optsAdmin, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const r = await deps.relierNumero(tenant);
    if (r === null) return reply.code(404).send({ error: 'aucun numéro rattaché à cet espace' });
    await journal(tenant, req, 'numero.relie', { kind: 'tenant', id: tenant }, { ...r });
    return reply.code(200).send({ relie: true, ...r });
  });
}
