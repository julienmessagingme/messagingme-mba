import { randomInt } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import { TenantConflictError, SecondNumeroRefuseError } from '../account/es-store.pg';
import { scopeTenant, nonEmpty } from './scope';
import { makeJournal, type AuditSink } from '../audit/journal';

export interface EmbeddedSignupRouteDeps {
  /**
   * Journal d'audit (2026-09-16). Optionnel : absent -> aucune trace (câblages de test).
   *
   * 🔴 RATTACHER UN NUMÉRO, C'EST DONNER UNE VOIX. À partir de cet instant, le produit parle aux clients SOUS
   * CETTE IDENTITÉ, et un token business chiffré est conservé. C'est le geste le plus structurant de tout
   * l'embarquement, et il ne laissait aucune trace.
   *
   * 🔴 LE `detail` NE PORTE PAS LE NUMÉRO AFFICHÉ (`displayPhoneNumber`), qui est un numéro de téléphone,
   * donc une donnée personnelle dans une table jamais purgée. Il porte les IDENTIFIANTS META, qui désignent
   * le compte et le numéro sans être le numéro.
   */
  audit?: AuditSink;
  /** config_id de la configuration ES (dashboard Meta, Facebook Login for Business). Vide -> feature OFF. */
  configId: string;
  /** App ID Meta (public : sert au FB.init du front). */
  appId: string;
  graphVersion: string;
  exchangeCode(code: string): Promise<string>;
  /** Preuve d'appartenance du WABA (GET /{waba_id} avec le business token) : throw si le token ne le possède pas. */
  verifyWaba(wabaId: string, businessToken: string): Promise<void>;
  /**
   * Comptes WhatsApp auxquels le business token donne accès. Sert quand la popup n'a PAS annoncé les
   * identifiants (client qui rouvre un parcours déjà abouti : Meta n'a plus rien à configurer, donc plus rien à
   * annoncer). Optionnelles : sans elles, la route garde son ancien contrat (les deux identifiants exigés).
   */
  wabasForToken?(businessToken: string): Promise<string[]>;
  listPhones?(wabaId: string, businessToken: string): Promise<Array<{ id: string }>>;
  getPhone(phoneNumberId: string, businessToken: string): Promise<{ displayPhoneNumber: string | null; verifiedName: string | null; status: string | null; codeVerificationStatus?: string | null }>;
  subscribeApp(wabaId: string, businessToken: string): Promise<void>;
  register(phoneNumberId: string, businessToken: string, pin: string): Promise<void>;
  link(input: { tenantId: string; wabaId: string; phoneNumberId: string; displayPhoneNumber: string | null; verifiedName: string | null }): Promise<void>;
  /** Persiste le token business (le câblage chiffre AVANT, la route ne voit jamais le stockage en clair). */
  saveCredentials(wabaId: string, tenantId: string, businessToken: string, pin: string | null): Promise<void>;

  // ----- « Activer le numéro » : finir chez nous ce que la fenêtre Meta a laissé en plan -----
  //
  // 🔴 AUCUNE DE CES DÉPENDANCES N'EST OPTIONNELLE, et c'est délibéré. Le dépôt a payé deux fois le motif
  // « dépendance optionnelle absente = garde qui ne tourne pas » (la garde d'authentification, puis
  // `estDesabonne`). Un câblage qui les oublie ne compile pas.
  //
  // ⚠️ AUCUNE NE REÇOIT DE JETON : le câblage le résout et ne laisse passer que le `tenantId`. Un jeton qui
  // n'entre pas dans la route ne peut ni fuiter dans un journal ni partir dans un corps de réponse.

  /**
   * Numéro principal de l'espace (identifiant Meta), `null` si aucun.
   *
   * 🔴 LU EN BASE, JAMAIS PRIS DANS LE CORPS DE LA REQUÊTE. C'est ce qui empêche un admin d'activer le numéro
   * d'un autre espace en forgeant un identifiant : il n'y a rien à forger.
   */
  numeroDuTenant(tenantId: string): Promise<string | null>;
  /**
   * État du numéro chez Meta. RELU AVANT CHAQUE GESTE, jamais lu dans notre base : c'est Meta qui tranche, et
   * notre copie date du dernier pull.
   */
  etatNumero(tenantId: string, phoneNumberId: string): Promise<{ status: string | null; codeVerificationStatus: string | null }>;
  /** Demande à Meta d'envoyer le code, par appel (VOICE) ou par SMS. */
  demanderCode(tenantId: string, phoneNumberId: string, methode: 'VOICE' | 'SMS'): Promise<void>;
  /** Poste le code reçu par le client. */
  verifierCode(tenantId: string, phoneNumberId: string, code: string): Promise<void>;
  /** Enregistre le numéro sur la Cloud API avec ce PIN (c'est son PIN 2FA). */
  enregistrerNumero(tenantId: string, phoneNumberId: string, pin: string): Promise<void>;
  /** Conserve le PIN, chiffré par le câblage, SEULEMENT après que Meta l'a accepté. */
  sauverPin(tenantId: string, pin: string): Promise<void>;

  // ----- « Délier » et « Relier » : l'interrupteur du numéro sur l'Accueil (migration 0180) -----
  //
  // 🔴 REQUISES, pour la même raison que les précédentes. Et AUCUNE NE PARLE À META : délier est un état de
  // CET espace, le numéro reste relié à son compte WhatsApp et son jeton reste chiffré chez nous.

  /**
   * Délie le numéro de l'espace et met en pause ses campagnes WhatsApp en cours ou programmées
   * (`PgNumeroDelieStore.delier`). `null` = l'espace n'a aucun numéro.
   */
  delierNumero(tenantId: string): Promise<{ delieLe: string; campagnesEnPause: number } | null>;
  /**
   * Relie le numéro et lève les pauses `numero_delie` (`PgNumeroDelieStore.relier`). `null` = aucun numéro.
   */
  relierNumero(tenantId: string): Promise<{ campagnesReprises: number; campagnesReprogrammees: number } | null>;
}

/**
 * Délai minimal entre deux demandes de code pour un même numéro.
 *
 * 🔴 CE N'EST PAS UN PLAFOND DE DÉBIT, C'EST LE QUOTA DE META QU'ON PROTÈGE. Il permet DIX requêtes par numéro
 * sur 72 heures, toutes étapes confondues ; au-delà, erreur 133016 et numéro bloqué 72 heures. Un client qui
 * clique trois fois parce que « rien ne se passe » brûlerait un tiers de son quota en dix secondes, et rien ne
 * le lui rendrait avant trois jours.
 *
 * ⚠️ EN MÉMOIRE DU PROCESS, comme les autres plafonds du dépôt : un redémarrage le remet à zéro, et c'est sans
 * conséquence pour une minute. Le persister demanderait une table pour une protection contre le double-clic.
 */
const DELAI_ENTRE_CODES_MS = 60_000;

/**
 * Embedded Signup (Tech Provider), admin-only. Quatre routes :
 *  - GET  /embedded-signup/config   : de quoi le front lance la popup (appId + configId publics, pas de secret).
 *  - POST /embedded-signup/complete : reçoit { code, wabaId, phoneNumberId } de la popup (code TTL 30 s !),
 *    échange le code -> business token, rattache WABA + numéro au workspace, abonne les webhooks, register si
 *    numéro neuf (jamais pour un numéro déjà CONNECTED, jamais pour un numéro NON vérifié : la v4 laisse finir
 *    le parcours sans vérification, et Meta refuserait), stocke le token chiffré. Les étapes NON bloquantes qui
 *    échouent remontent en `warnings` (jamais de demi-échec silencieux).
 *  - POST /numero/code              : Meta envoie le code de vérification du numéro (appel par défaut, ou SMS).
 *  - POST /numero/activer           : vérifie le code s'il le faut, puis enregistre le numéro sur la Cloud API.
 *
 * 🔴 LES DEUX DERNIÈRES EXISTENT PARCE QUE LA v4 LAISSE FINIR SANS VÉRIFICATION. Avant elle, un parcours abouti
 * donnait toujours un numéro vérifié ; depuis, il peut rendre la main sur un numéro que Meta refuse d'enregistrer,
 * et le client n'avait alors aucun recours dans la console (vécu le 2026-09-22 : passage par WhatsApp Manager).
 */
export function registerEmbeddedSignup(app: FastifyInstance, deps: EmbeddedSignupRouteDeps, garde: Guard, limiteCouteuse?: PreHandler): void {
  const journal = makeJournal(deps.audit);
  const opts = { preHandler: garde };
  // Les deux routes d'activation appellent Meta sur un quota étroit : elles portent la limite coûteuse, comme
  // l'import ou l'aperçu de site.
  const couteux = gardeEtendue(garde, limiteCouteuse);
  /** Dernier envoi de code PAR NUMÉRO. Porté par l'instance de serveur (et non par le module) : deux serveurs
   *  montés dans le même process, ce qui n'arrive qu'en test, ne se gênent pas l'un l'autre. */
  const dernierCode = new Map<string, number>();

  app.get('/tenants/:tenantId/embedded-signup/config', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const enabled = deps.configId !== '' && deps.appId !== '';
    return reply.code(200).send({ enabled, appId: deps.appId, configId: deps.configId, graphVersion: deps.graphVersion });
  });

  app.post('/tenants/:tenantId/embedded-signup/complete', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    if (deps.configId === '') return reply.code(503).send({ error: 'Embedded Signup non configuré (META_ES_CONFIG_ID)' });
    const b = (req.body ?? {}) as { code?: unknown; wabaId?: unknown; phoneNumberId?: unknown };
    // `wabaId` / `phoneNumberId` sont FACULTATIFS : la popup ne les annonce que lorsqu'elle exécute vraiment les
    // étapes de configuration. Un client qui rouvre le parcours après un premier passage abouti n'obtient qu'un
    // code, et restait donc bloqué DÉFINITIVEMENT (mesuré le 2026-08-17). Absents -> on les retrouve (1 bis).
    if (!nonEmpty(b.code)) return reply.code(400).send({ error: 'code requis' });
    const code = b.code.trim();

    // 1. Code -> business token. Échec = rien n'est rattaché (le code a un TTL de 30 s : re-cliquer suffit).
    let businessToken: string;
    try {
      businessToken = await deps.exchangeCode(code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`embedded-signup: échange du code impossible (tenant ${tenant}) : ${msg}`);
      return reply.code(422).send({ error: `échange du code Meta échoué : ${msg}` });
    }

    // 1 bis. Identifiants non annoncés -> on les lit dans le TOKEN (les comptes auxquels il donne accès), puis
    //        dans le compte (ses numéros). Aucune perte de sûreté : ils viennent du token du client lui-même,
    //        ils ne peuvent donc pas désigner les biens d'un autre, et l'étape 2 les vérifie quand même. On
    //        REFUSE l'ambiguïté (plusieurs comptes ou plusieurs numéros) au lieu d'en choisir un au hasard :
    //        rattacher le mauvais numéro serait bien pire qu'un message d'erreur.
    let wabaId = nonEmpty(b.wabaId) ? b.wabaId.trim() : '';
    let phoneNumberId = nonEmpty(b.phoneNumberId) ? b.phoneNumberId.trim() : '';
    if (wabaId === '' || phoneNumberId === '') {
      if (!deps.wabasForToken || !deps.listPhones) {
        return reply.code(400).send({ error: 'code, wabaId et phoneNumberId requis' });
      }
      try {
        if (wabaId === '') {
          const wabas = await deps.wabasForToken(businessToken);
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
          const phones = await deps.listPhones(wabaId, businessToken);
          if (phones.length === 0) {
            return reply.code(422).send({ error: 'ce compte WhatsApp ne contient aucun numéro. Ajoute-le dans le parcours Meta.' });
          }
          if (phones.length > 1) {
            return reply.code(409).send({ error: `ce compte WhatsApp contient ${phones.length} numéros : impossible de deviner lequel rattacher.` });
          }
          phoneNumberId = phones[0]!.id;
        }
        // eslint-disable-next-line no-console
        console.info(`embedded-signup: identifiants retrouvés depuis le token (waba=${wabaId}, numéro=${phoneNumberId}) faute d'annonce par la popup`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(`embedded-signup: repêchage des identifiants impossible (tenant ${tenant}) : ${msg}`);
        return reply.code(422).send({ error: `lecture du compte WhatsApp impossible : ${msg}` });
      }
    }

    // 2. PREUVE D'APPARTENANCE (garde anti-hijack cross-tenant) : le business token est scopé au client qui a
    //    complété l'ES ; il ne peut lire le WABA et le numéro QUE s'ils lui appartiennent. Ces deux appels sont
    //    BLOQUANTS : si l'un échoue, le token ne possède pas l'asset demandé -> 422 et on ne persiste RIEN (ni
    //    rattachement, ni webhooks, ni register, ni token). Sans ça, un tenant pourrait rattacher les assets d'un
    //    autre en forgeant wabaId/phoneNumberId. `getPhone` renvoie aussi le vrai `status` (décide du register).
    let phone: { displayPhoneNumber: string | null; verifiedName: string | null; status: string | null; codeVerificationStatus?: string | null };
    try {
      await deps.verifyWaba(wabaId, businessToken);
      phone = await deps.getPhone(phoneNumberId, businessToken);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`embedded-signup: preuve d'appartenance refusée (tenant ${tenant}, waba ${wabaId}, numéro ${phoneNumberId}) : ${msg}`);
      return reply.code(422).send({ error: `le compte Meta connecté ne donne pas accès à ce numéro/WABA : ${msg}` });
    }

    const warnings: string[] = [];
    // 3. Rattachement au workspace. Un WABA/numéro déjà rattaché à un AUTRE workspace est REFUSÉ (409), pas réaffecté
    //    en silence : on interrompt AVANT d'abonner les webhooks, de register ou de stocker le token. La migration
    //    volontaire d'un numéro entre workspaces passe par le chemin admin dédié, pas par l'Embedded Signup.
    try {
      await deps.link({ tenantId: tenant, wabaId, phoneNumberId, displayPhoneNumber: phone.displayPhoneNumber, verifiedName: phone.verifiedName });
    } catch (err) {
      if (err instanceof TenantConflictError) {
        return reply.code(409).send({ error: 'ce numéro ou ce WABA est déjà rattaché à un autre workspace' });
      }
      // Un seul numéro par workspace. Le message dit CE QUI EST DÉJÀ LÀ et quoi faire : sans ça, l'opérateur
      // conclut à une panne et recommence. 409 et non 5xx, sinon Cloudflare remplace le corps par sa page.
      if (err instanceof SecondNumeroRefuseError) {
        return reply.code(409).send({
          error: `Cet espace utilise déjà le numéro ${err.dejaRattache}. Un espace ne peut piloter qu'un seul numéro WhatsApp : pour en connecter un autre, crée un second espace, ou détache d'abord le numéro actuel.`,
        });
      }
      throw err;
    }

    // 4. Webhooks du WABA -> notre app (idempotent). Échec = averti (sans webhooks : ni statuts ni réponses).
    try {
      await deps.subscribeApp(wabaId, businessToken);
    } catch (err) {
      warnings.push(`abonnement webhooks : ${err instanceof Error ? err.message : String(err)}`);
    }

    // 5. Register : SEULEMENT si le numéro n'est pas déjà sur la Cloud API (numéro neuf). PIN généré et conservé
    //    (c'est le PIN 2FA du numéro : nécessaire aux re-régistrations).
    //
    // 🔴 ET SEULEMENT SI LE NUMÉRO EST VÉRIFIÉ. Depuis la v4 de l'inscription, le client peut terminer le
    //    parcours Meta avec un numéro NON vérifié (la v2 finissait toujours vérifié) : `register` le refuse
    //    alors (133006) et chaque tentative consomme une des 10 requêtes permises par numéro sur 72 h, au-delà
    //    desquelles Meta bloque le numéro pour 72 h (133016). On ne brûle pas un essai pour rien.
    //    Seul `NOT_VERIFIED` retient le register : `EXPIRED` n'a jamais été mesuré ici, et le refuser sur une
    //    valeur qu'on n'a jamais vue casserait un embarquement qui marche aujourd'hui.
    //    Le numéro RESTE rattaché : c'est le bouton « Activer le numéro » de l'Accueil qui finit le travail,
    //    sans redemander au client de refaire tout le parcours Meta pour un code qu'il peut saisir chez nous.
    let pin: string | null = null;
    const aActiver = phone.status !== 'CONNECTED' && phone.codeVerificationStatus === 'NOT_VERIFIED';
    if (aActiver) {
      // eslint-disable-next-line no-console
      console.warn(`embedded-signup: numéro non vérifié, register non tenté (tenant ${tenant}, waba ${wabaId}, numéro ${phoneNumberId})`);
      warnings.push("ce numéro n'a pas encore été vérifié chez Meta : il est rattaché mais ne peut pas encore envoyer. Termine avec « Activer le numéro » sur l'Accueil.");
    } else if (phone.status !== 'CONNECTED') {
      pin = String(randomInt(100000, 1000000)); // PIN 2FA du numéro : CSPRNG (cohérent avec le reste du repo)
      try {
        await deps.register(phoneNumberId, businessToken, pin);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // ⚠️ JOURNALISÉ, et pas seulement rendu. Le 2026-09-22 au soir, un register a échoué en silence : la
        // route ne le mettait que dans `warnings`, que l'écran effaçait en rechargeant le compte. La cause a
        // failli être perdue, et c'est ce qui a coûté la soirée.
        // eslint-disable-next-line no-console
        console.error(`embedded-signup: register refusé (tenant ${tenant}, waba ${wabaId}, numéro ${phoneNumberId}) : ${msg}`);
        warnings.push(`register du numéro : ${msg}`);
        pin = null; // le pin n'a pas été posé -> ne pas le stocker comme s'il l'était
      }
    }

    // 6. Token business conservé (chiffré au repos par le câblage).
    await deps.saveCredentials(wabaId, tenant, businessToken, pin);

    // ⚠️ APRÈS l'enregistrement des identifiants : avant, on tracerait une intention, pas un rattachement.
    // `avertissements` est journalisé parce qu'un numéro rattaché AVEC des avertissements est un état réel,
    // et la question « pourquoi les statuts n'arrivent pas ? » se pose des semaines plus tard.
    await journal(tenant, req, 'numero.connecte', { kind: 'phone_number', id: phoneNumberId }, {
      wabaId, avertissements: warnings.length,
    });
    return reply.code(200).send({
      connected: true,
      wabaId,
      phoneNumberId,
      displayPhoneNumber: phone.displayPhoneNumber,
      // `aActiver` n'est posé QUE dans ce cas : l'écran s'en sert pour envoyer tout de suite vers l'activation,
      // au lieu de laisser croire que le numéro est prêt à envoyer.
      ...(aActiver ? { aActiver: true } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
  });

  /**
   * Demande à Meta d'envoyer le code de vérification du numéro de l'espace.
   *
   * 🔴 ELLE LIT L'ÉTAT AVANT D'AGIR, et ce n'est pas une précaution : c'est la seule séquence valide. Meta
   * refuse une demande de code sur un numéro déjà vérifié (136024), et chaque refus consomme une des dix
   * requêtes permises sur 72 heures. Apprendre l'état en le demandant à Meta coûterait donc un essai au client.
   */
  app.post('/tenants/:tenantId/numero/code', couteux, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
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
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`numero/code: état illisible chez Meta (tenant ${tenant}, numéro ${phoneNumberId}) : ${msg}`);
      return reply.code(422).send({ error: `état du numéro illisible chez Meta : ${msg}` });
    }
    if (etat.status === 'CONNECTED') return reply.code(409).send({ error: 'ce numéro est déjà activé : il peut envoyer.' });
    if (etat.codeVerificationStatus === 'VERIFIED') {
      return reply.code(409).send({ error: 'ce numéro est déjà vérifié : il ne reste qu’à l’activer, sans nouveau code.' });
    }

    const precedent = dernierCode.get(phoneNumberId);
    const maintenant = Date.now();
    if (precedent !== undefined && maintenant - precedent < DELAI_ENTRE_CODES_MS) {
      const reste = Math.ceil((DELAI_ENTRE_CODES_MS - (maintenant - precedent)) / 1000);
      return reply.code(429).send({ error: `un code vient d’être envoyé. Attends ${reste} s avant d’en redemander un : Meta n’en permet que dix par numéro sur 72 heures.` });
    }

    // 🔴 LA MARQUE EST POSÉE AVANT L'APPEL, ET C'EST LE SENS DE LA GARDE. Meta compte des REQUÊTES, pas des
    //    succès : un envoi qu'il REFUSE a quand même consommé un des dix essais du numéro. Ne marquer qu'en
    //    cas de succès laisserait donc le chemin d'échec sans protection, c'est-à-dire précisément celui où
    //    le client reclique parce que « rien ne s'est passé ». Le prix est une minute d'attente quand l'appel
    //    n'a même pas atteint Meta, contre 72 heures de numéro bloqué dans l'autre sens.
    dernierCode.set(phoneNumberId, maintenant);
    try {
      await deps.demanderCode(tenant, phoneNumberId, methode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Journalisé AVEC le code de Meta, jamais avec le code reçu par le client : c'est ce qui manquait le
      // 2026-09-22 au soir, et la cause d'un échec a failli être perdue.
      // eslint-disable-next-line no-console
      console.error(`numero/code: refus de Meta (tenant ${tenant}, numéro ${phoneNumberId}, ${methode}) : ${msg}`);
      return reply.code(422).send({ error: `Meta a refusé l’envoi du code : ${msg}` });
    }
    return reply.code(200).send({ envoye: true, methode });
  });

  /**
   * Active le numéro : vérifie le code s'il le faut, puis l'enregistre sur la Cloud API.
   *
   * 🔴 AUCUNE RELANCE AUTOMATIQUE (décision de Julien, 2026-09-22). Un échec laisse le numéro « à activer »,
   * visible à l'écran, et c'est le client qui décide quand réessayer. Une répétition invisible consommerait le
   * quota des dix requêtes sans que personne ne le voie.
   */
  app.post('/tenants/:tenantId/numero/activer', couteux, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const body = (req.body ?? {}) as { code?: unknown };

    const phoneNumberId = await deps.numeroDuTenant(tenant);
    if (phoneNumberId === null) return reply.code(404).send({ error: 'aucun numéro rattaché à cet espace' });

    let etat: { status: string | null; codeVerificationStatus: string | null };
    try {
      etat = await deps.etatNumero(tenant, phoneNumberId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`numero/activer: état illisible chez Meta (tenant ${tenant}, numéro ${phoneNumberId}) : ${msg}`);
      return reply.code(422).send({ error: `état du numéro illisible chez Meta : ${msg}` });
    }
    // Déjà activé : on ne fait RIEN et on le dit. Un register de plus serait un essai brûlé pour confirmer ce
    // que Meta vient de nous dire.
    if (etat.status === 'CONNECTED') return reply.code(200).send({ actif: true, deja: true });

    // Vérification, seulement si Meta dit que le numéro ne l'est pas. Sur un numéro déjà vérifié, elle
    // échouerait, et l'échec coûterait un essai.
    if (etat.codeVerificationStatus !== 'VERIFIED') {
      if (!nonEmpty(body.code)) {
        return reply.code(400).send({ error: 'code requis : ce numéro n’est pas encore vérifié chez Meta. Demande un code, puis saisis-le.' });
      }
      try {
        await deps.verifierCode(tenant, phoneNumberId, body.code.trim());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // ⚠️ LE CODE REÇU N'EST JAMAIS JOURNALISÉ, ni le PIN : seuls l'identifiant du numéro et le refus de Meta.
        // eslint-disable-next-line no-console
        console.error(`numero/activer: code refusé par Meta (tenant ${tenant}, numéro ${phoneNumberId}) : ${msg}`);
        return reply.code(422).send({ error: `Meta a refusé ce code : ${msg}` });
      }
    }

    // Enregistrement sur la Cloud API. Le PIN est le PIN 2FA du numéro : tiré au CSPRNG, et conservé SEULEMENT
    // si Meta l'accepte. En conserver un que Meta n'a pas posé donnerait un secret faux en base, qui ferait
    // échouer la prochaine re-régistration sans cause visible.
    const pin = String(randomInt(100000, 1000000));
    try {
      await deps.enregistrerNumero(tenant, phoneNumberId, pin);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`numero/activer: register refusé par Meta (tenant ${tenant}, numéro ${phoneNumberId}) : ${msg}`);
      return reply.code(422).send({ error: `Meta a refusé l’activation : ${msg}` });
    }
    // 🔴 BEST-EFFORT, ET APRÈS L'EFFET : à cet instant, Meta a ACTIVÉ le numéro. Faire échouer la route parce
    //    qu'on n'a pas su ranger le PIN annoncerait une panne au client alors que son numéro marche, et
    //    l'inviterait à recommencer, donc à brûler un essai. Le cas réel n'est pas théorique : un numéro
    //    branché à la main n'a aucune ligne de credentials où écrire. L'échec est journalisé, jamais tu.
    try {
      await deps.sauverPin(tenant, pin);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`numero/activer: numéro activé mais PIN non conservé (tenant ${tenant}, numéro ${phoneNumberId}) : ${err instanceof Error ? err.message : String(err)}`);
    }
    await journal(tenant, req, 'numero.active', { kind: 'phone_number', id: phoneNumberId }, {
      verificationFaite: etat.codeVerificationStatus !== 'VERIFIED',
    });
    return reply.code(200).send({ actif: true });
  });

  /**
   * DÉLIE le numéro de l'espace : l'interrupteur « Numéro WhatsApp » de l'Accueil, éteint (migration 0180).
   *
   * Ce que ça arrête, et c'est ce que dit la confirmation de l'écran : aucun envoi ne part (le point de passage
   * des envois le refuse, `NumeroDelieError`), les campagnes WhatsApp en cours ou programmées passent en pause
   * `numero_delie`, et les messages reçus sur ce numéro ne sont plus enregistrés (le webhook les écarte).
   *
   * 🔴 RIEN N'EST TOUCHÉ CHEZ META, ni supprimé chez nous : le numéro, son compte, son jeton chiffré et
   * l'historique restent. C'est ce qui rend « Relier » possible d'un clic, sans refaire la fenêtre Meta.
   *
   * ⚠️ ADMIN SEULEMENT : le module est monté derrière `g.admin` (`src/server.ts`), comme `/numero/activer`.
   */
  app.post('/tenants/:tenantId/numero/delier', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const r = await deps.delierNumero(tenant);
    if (r === null) return reply.code(404).send({ error: 'aucun numéro rattaché à cet espace' });
    // L'identifiant de l'ESPACE en cible : délier porte sur tous ses numéros, et le numéro affiché est une donnée
    // personnelle que ce journal, jamais purgé, n'a pas à porter.
    await journal(tenant, req, 'numero.delie', { kind: 'tenant', id: tenant }, { campagnesEnPause: r.campagnesEnPause });
    return reply.code(200).send({ delie: true, delieLe: r.delieLe, campagnesEnPause: r.campagnesEnPause });
  });

  /**
   * RELIE le numéro : l'interrupteur rallumé, SANS confirmation (plan du 2026-09-25 : éteindre se confirme,
   * rallumer non). Les campagnes mises en pause par « Délier » repartent : `running` pour celles qui tournaient,
   * reprises dans la minute par le balayage des campagnes gelées, `scheduled` pour celles qui étaient programmées.
   */
  app.post('/tenants/:tenantId/numero/relier', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const r = await deps.relierNumero(tenant);
    if (r === null) return reply.code(404).send({ error: 'aucun numéro rattaché à cet espace' });
    await journal(tenant, req, 'numero.relie', { kind: 'tenant', id: tenant }, { ...r });
    return reply.code(200).send({ relie: true, ...r });
  });
}
