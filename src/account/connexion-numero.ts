import { randomInt } from 'node:crypto';
import { texteDe } from '../lib/erreur';
import type { Prise, VerrousCourts } from '../db/verrous-courts';
import { CompteChez360dialog, type Fournisseur } from '../meta/credentials';
import { SecondNumeroRefuseError, TenantConflictError } from './es-store.pg';

/**
 * La fin de la fenêtre de Meta en coexistence (`WA_EMBEDDED_SIGNUP`, ouverte avec `featureType:
 * 'whatsapp_business_app_onboarding'`) : le numéro reste dans l'application WhatsApp Business et passe AUSSI sur l'API
 * Cloud (plan `docs/superpowers/plans/2026-10-24-coexistence.md`).
 */
export const EVENEMENT_COEXISTENCE = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';

/** Les appels Graph de l'inscription, faits avec le business token que le parcours vient d'obtenir. */
export interface MetaInscriptionDep {
  exchangeCode(code: string): Promise<string>;
  /** Preuve d'appartenance du WABA : lève si le jeton ne le possède pas. */
  verifyWaba(wabaId: string, businessToken: string): Promise<void>;
  /** Comptes WhatsApp auxquels le business token donne accès. */
  wabasForToken(businessToken: string): Promise<string[]>;
  listPhones(wabaId: string, businessToken: string): Promise<Array<{ id: string }>>;
  getPhone(phoneNumberId: string, businessToken: string): Promise<{
    displayPhoneNumber: string | null;
    verifiedName: string | null;
    status: string | null;
    codeVerificationStatus?: string | null;
  }>;
  /**
   * Le numéro vit-il aussi dans l'application WhatsApp Business (`is_on_biz_app`) ? Lu À PART de `getPhone`, dont la
   * chaîne `fields` ne bouge pas : un champ que Meta ne connaîtrait pas y ferait échouer toutes les connexions. `null`
   * sur toute erreur, journalisée : ne lève jamais.
   */
  surApplication(phoneNumberId: string, businessToken: string): Promise<boolean | null>;
  subscribeApp(wabaId: string, businessToken: string): Promise<void>;
  register(phoneNumberId: string, businessToken: string, pin: string): Promise<void>;
}

export interface DepsConnexionNumero {
  meta: MetaInscriptionDep;
  inscriptions: {
    linkTenant(input: {
      tenantId: string;
      wabaId: string;
      phoneNumberId: string;
      displayPhoneNumber: string | null;
      verifiedName: string | null;
      /** Le numéro est relié en coexistence (`phone_numbers.coexistence`, migration 0253). */
      coexistence: boolean;
    }): Promise<void>;
    lierCompteSansNumero(input: { tenantId: string; wabaId: string }): Promise<void>;
  };
  offrirCredit(tenantId: string, phoneNumberId: string): Promise<void>;
  saveCredentials(wabaId: string, tenantId: string, businessToken: string, pin: string | null): Promise<void>;
  fournisseurDeLEspace(tenantId: string): Promise<Fournisseur | null>;
  numeroDuTenant(tenantId: string): Promise<string | null>;
  /**
   * Retire le compte de la filière application de l'espace s'il n'est pas déjà retiré (`retirerLeCompteApplication`, le
   * service de connexions) : un espace relié par QR code qui passe en coexistence ne garde pas deux filières vivantes.
   * `aucun` : pas de compte, ou déjà retiré.
   */
  retirerCompteApplication(tenantId: string): Promise<'retire' | 'aucun' | 'echec'>;
}

export interface DepsDemandeCodeNumero {
  numeroDuTenant(tenantId: string): Promise<string | null>;
  /**
   * Le numéro de l'espace est-il relié en coexistence (`phone_numbers.coexistence`, migration 0253) ? Alors il n'y a rien
   * à activer : l'application WhatsApp Business l'a déjà enregistré, et un `/register` y est interdit.
   */
  enCoexistence(tenantId: string): Promise<boolean>;
  etatNumero(tenantId: string, phoneNumberId: string): Promise<{ status: string | null; codeVerificationStatus: string | null }>;
  demanderCode(tenantId: string, phoneNumberId: string, methode: 'VOICE' | 'SMS'): Promise<void>;
  verrous: Pick<VerrousCourts, 'prendre'>;
}

export interface DepsActivationNumero {
  numeroDuTenant(tenantId: string): Promise<string | null>;
  /** Comme pour la demande de code : un numéro en coexistence n'a rien à activer. */
  enCoexistence(tenantId: string): Promise<boolean>;
  etatNumero(tenantId: string, phoneNumberId: string): Promise<{ status: string | null; codeVerificationStatus: string | null }>;
  verifierCode(tenantId: string, phoneNumberId: string, code: string): Promise<void>;
  enregistrerNumero(tenantId: string, phoneNumberId: string, pin: string): Promise<void>;
  sauverPin(tenantId: string, pin: string): Promise<void>;
  offrirCredit(tenantId: string, phoneNumberId: string): Promise<void>;
}

export type TraceConnexionNumero =
  | { action: 'compte.relie_sans_numero'; wabaId: string; avertissements: number }
  | { action: 'numero.connecte'; wabaId: string; phoneNumberId: string; avertissements: number; coexistence: boolean }
  | { action: 'numero.active'; phoneNumberId: string; verificationFaite: boolean };

export type TracerConnexionNumero = (trace: TraceConnexionNumero) => Promise<void>;

type RefusConnexion = { ok: false; statut: 409 | 422; error: string };

export type IssueConnexionNumero = RefusConnexion | {
  ok: true;
  connected: false;
  sansNumero: true;
  wabaId: string;
  warnings: string[];
} | {
  ok: true;
  connected: true;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  aActiver: boolean;
  /** Le numéro est relié en coexistence : il reste dans l'application WhatsApp Business. */
  coexistence: boolean;
  warnings: string[];
};

export type IssueDemandeCodeNumero =
  | { ok: true; methode: 'VOICE' | 'SMS' }
  | { ok: false; statut: 404 | 409 | 422 | 429; error: string };

export type IssueActivationNumero =
  | { ok: true; actif: true; deja: boolean }
  | { ok: false; statut: 400 | 404 | 409 | 422; error: string };

/**
 * Le refus des deux gestes d'activation sur un numéro relié en coexistence (relecture du lot 1, plan 2026-10-24) : rien à
 * activer, et jamais de `/register`, même si Meta rendait pour lui un statut autre que `CONNECTED`.
 */
export const NUMERO_EN_COEXISTENCE = 'Ce numéro est déjà relié à l’API officielle, et il reste dans l’application WhatsApp '
  + 'Business : il n’y a rien à activer.';

/** Délai minimal entre deux demandes : Meta ne permet que dix essais par numéro sur 72 heures. */
export const DELAI_ENTRE_CODES_MS = 60_000;

/** Clé partagée entre les copies de l'API pour tenir ce délai. */
export function cleDemandeCode(phoneNumberId: string): string {
  return `es-code:${phoneNumberId}`;
}

/** Au plus tant de comptes interrogés pour départager : au-delà, on refuse de deviner. */
const MAX_COMPTES_A_DEPARTAGER = 10;

async function compteQuiPorte(
  meta: Pick<MetaInscriptionDep, 'listPhones'>,
  comptes: readonly string[],
  numero: string | null,
  jeton: string,
): Promise<string | null> {
  if (numero === null || comptes.length > MAX_COMPTES_A_DEPARTAGER) return null;
  const porteurs: string[] = [];
  for (const compte of comptes) {
    if ((await meta.listPhones(compte, jeton)).some((p) => p.id === numero)) porteurs.push(compte);
  }
  return porteurs.length === 1 ? porteurs[0]! : null;
}

function messageSecondNumero(err: SecondNumeroRefuseError): string {
  return `Cet espace utilise déjà le numéro ${err.dejaRattache}. Un espace ne peut piloter qu'un seul numéro WhatsApp : pour renouveler sa connexion, choisis ce même numéro dans la fenêtre de Meta ; pour en connecter un autre, retire d'abord celui-ci (« Déconnecter le numéro » sur l'Accueil), ou crée un second espace.`;
}

/**
 * Offre le crédit après le geste accepté par Meta. Une panne ne transforme jamais ce succès en erreur : le prochain
 * geste idempotent pourra servir l'offre encore due.
 */
async function offrir(deps: Pick<DepsConnexionNumero, 'offrirCredit'>, tenantId: string, phoneNumberId: string): Promise<void> {
  try {
    await deps.offrirCredit(tenantId, phoneNumberId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`credit offert: non ecrit (tenant ${tenantId}, numéro ${phoneNumberId}) : ${texteDe(err)}`);
  }
}

/** Ce que dit le rattachement en coexistence quand l'appareil lié par QR code n'a pas pu être retiré. */
const APPAREIL_NON_RETIRE = 'L’appareil lié par QR code n’a pas pu être retiré de notre côté : WhatsApp l’a déjà délié, et l’espace passe par l’API.';

/**
 * Retire l'appareil lié par QR code d'un espace qui vient de passer en coexistence. Une panne ne transforme jamais le
 * rattachement en erreur : WhatsApp a déjà délié l'appareil, l'API prime sur la filière (`filiereDe`), et la session qui
 * resterait chez nous n'agit plus.
 */
async function retirerLAppareil(deps: Pick<DepsConnexionNumero, 'retirerCompteApplication'>, tenantId: string): Promise<'retire' | 'aucun' | 'echec'> {
  try {
    return await deps.retirerCompteApplication(tenantId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`embedded-signup: appareil lié non retiré (tenant ${tenantId}) : ${texteDe(err)}`);
    return 'echec';
  }
}

/**
 * Possède le protocole de connexion Meta : échange, découverte sûre des identifiants, preuve d'appartenance,
 * rattachement, abonnement, enregistrement, conservation du jeton, trace et crédit. Le transport HTTP ne choisit
 * aucune étape et ne voit que l'issue métier.
 */
export async function connecterNumero(
  deps: DepsConnexionNumero,
  input: { tenantId: string; code: string; wabaId?: string; phoneNumberId?: string; evenement?: string },
  tracer: TracerConnexionNumero,
): Promise<IssueConnexionNumero> {
  const tenant = input.tenantId;
  if ((await deps.fournisseurDeLEspace(tenant)) === '360dialog') {
    return { ok: false, statut: 409, error: 'Le numéro de cet espace est relié par 360dialog : la connexion Meta le remplacerait. Déconnectez-le d’abord.' };
  }

  let businessToken: string;
  try {
    businessToken = await deps.meta.exchangeCode(input.code);
  } catch (err) {
    const msg = texteDe(err);
    // eslint-disable-next-line no-console
    console.error(`embedded-signup: échange du code impossible (tenant ${tenant}) : ${msg}`);
    return { ok: false, statut: 422, error: `échange du code Meta échoué : ${msg}` };
  }

  let wabaId = input.wabaId?.trim() ?? '';
  let phoneNumberId = input.phoneNumberId?.trim() ?? '';
  let sansNumero = false;
  if (wabaId === '' || phoneNumberId === '') {
    try {
      let actuel: string | null | undefined;
      const numeroActuel = async (): Promise<string | null> => (
        actuel === undefined ? (actuel = await deps.numeroDuTenant(tenant)) : actuel
      );
      if (wabaId === '') {
        const wabas = await deps.meta.wabasForToken(businessToken);
        if (wabas.length === 0) {
          // eslint-disable-next-line no-console
          console.error(`embedded-signup: le token du tenant ${tenant} n'expose aucun compte WhatsApp (granular_scopes sans cible)`);
          return { ok: false, statut: 422, error: 'le compte Meta connecté n’expose aucun compte WhatsApp. Termine le parcours Meta jusqu’au bout, en partageant bien ton compte WhatsApp avec l’application.' };
        }
        if (wabas.length > 1) {
          const porteur = await compteQuiPorte(deps.meta, wabas, await numeroActuel(), businessToken);
          if (porteur === null) {
            return { ok: false, statut: 409, error: `ce compte Meta donne accès à ${wabas.length} comptes WhatsApp : impossible de deviner lequel rattacher.` };
          }
          wabaId = porteur;
        } else {
          wabaId = wabas[0]!;
        }
      }
      if (phoneNumberId === '') {
        const phones = await deps.meta.listPhones(wabaId, businessToken);
        if (phones.length > 1) {
          const n = await numeroActuel();
          if (n === null || !phones.some((p) => p.id === n)) {
            return { ok: false, statut: 409, error: `ce compte WhatsApp contient ${phones.length} numéros : impossible de deviner lequel rattacher.` };
          }
          phoneNumberId = n;
        } else if (phones.length === 0) {
          sansNumero = true;
        } else {
          phoneNumberId = phones[0]!.id;
        }
      }
      // eslint-disable-next-line no-console
      console.info(`embedded-signup: identifiants retrouvés depuis le token (waba=${wabaId}, numéro=${sansNumero ? 'aucun' : phoneNumberId}) faute d'annonce par la popup`);
    } catch (err) {
      const msg = texteDe(err);
      // eslint-disable-next-line no-console
      console.error(`embedded-signup: repêchage des identifiants impossible (tenant ${tenant}) : ${msg}`);
      return { ok: false, statut: 422, error: `lecture du compte WhatsApp impossible : ${msg}` };
    }
  }

  if (sansNumero) {
    try {
      await deps.meta.verifyWaba(wabaId, businessToken);
    } catch (err) {
      const msg = texteDe(err);
      // eslint-disable-next-line no-console
      console.error(`embedded-signup: preuve d'appartenance refusée (tenant ${tenant}, waba ${wabaId}, sans numéro) : ${msg}`);
      return { ok: false, statut: 422, error: `le compte Meta connecté ne donne pas accès à ce compte WhatsApp : ${msg}` };
    }
    try {
      await deps.inscriptions.lierCompteSansNumero({ tenantId: tenant, wabaId });
    } catch (err) {
      if (err instanceof TenantConflictError) {
        return { ok: false, statut: 409, error: 'ce compte WhatsApp est déjà rattaché à un autre workspace' };
      }
      if (err instanceof SecondNumeroRefuseError) {
        return { ok: false, statut: 409, error: messageSecondNumero(err) };
      }
      throw err;
    }
    const avertissements: string[] = [];
    try {
      await deps.meta.subscribeApp(wabaId, businessToken);
    } catch (err) {
      avertissements.push(`abonnement webhooks : ${texteDe(err)}`);
    }
    await deps.saveCredentials(wabaId, tenant, businessToken, null);
    await tracer({ action: 'compte.relie_sans_numero', wabaId, avertissements: avertissements.length });
    const evenement = input.evenement !== undefined && /^[A-Z_]{1,40}$/.test(input.evenement) ? input.evenement : 'aucun';
    // eslint-disable-next-line no-console
    console.info(`embedded-signup: compte relié SANS numéro (tenant ${tenant}, waba ${wabaId}, événement de la fenêtre ${evenement})`);
    return {
      ok: true,
      connected: false,
      sansNumero: true,
      wabaId,
      warnings: [
        'Ton compte WhatsApp est relié, sans numéro pour l’instant. Pour connecter ton propre numéro, relance « Connecter » et saisis-le dans la fenêtre Meta.',
        ...avertissements,
      ],
    };
  }

  let phone: Awaited<ReturnType<MetaInscriptionDep['getPhone']>>;
  try {
    await deps.meta.verifyWaba(wabaId, businessToken);
    phone = await deps.meta.getPhone(phoneNumberId, businessToken);
  } catch (err) {
    const msg = texteDe(err);
    // eslint-disable-next-line no-console
    console.error(`embedded-signup: preuve d'appartenance refusée (tenant ${tenant}, waba ${wabaId}, numéro ${phoneNumberId}) : ${msg}`);
    return { ok: false, statut: 422, error: `le compte Meta connecté ne donne pas accès à ce numéro/WABA : ${msg}` };
  }

  // 🔴 La coexistence (plan 2026-10-24). Meta est TOUJOURS interrogé sur le numéro, une fois, dans un appel à part qui ne
  // lève jamais (`null` : illisible). L'événement de la fenêtre suffit à sauter `/register` et à retirer l'appareil lié
  // par QR code, des effets qui ne touchent que l'espace du demandeur ; sans lui (un parcours rejoué n'annonce rien), le
  // signal de Meta les déclenche. Le crédit, lui, n'est ouvert que par Meta (plus bas) : l'événement est une chaîne que
  // le navigateur envoie librement.
  const surApplication = await deps.meta.surApplication(phoneNumberId, businessToken);
  const coexistence = input.evenement === EVENEMENT_COEXISTENCE || surApplication === true;
  if (input.evenement === EVENEMENT_COEXISTENCE && surApplication === false) {
    // eslint-disable-next-line no-console
    console.warn(`embedded-signup: événement de coexistence reçu, mais Meta rend is_on_biz_app faux (tenant ${tenant}, waba ${wabaId}, numéro ${phoneNumberId})`);
  }

  const warnings: string[] = [];
  try {
    await deps.inscriptions.linkTenant({
      tenantId: tenant,
      wabaId,
      phoneNumberId,
      displayPhoneNumber: phone.displayPhoneNumber,
      verifiedName: phone.verifiedName,
      coexistence,
    });
  } catch (err) {
    if (err instanceof TenantConflictError) {
      return { ok: false, statut: 409, error: 'ce numéro ou ce WABA est déjà rattaché à un autre workspace' };
    }
    if (err instanceof SecondNumeroRefuseError) {
      return { ok: false, statut: 409, error: messageSecondNumero(err) };
    }
    throw err;
  }

  try {
    await deps.meta.subscribeApp(wabaId, businessToken);
  } catch (err) {
    warnings.push(`abonnement webhooks : ${texteDe(err)}`);
  }

  let pin: string | null = null;
  // 🔴 Jamais `/register` sur un numéro en coexistence : l'application l'a déjà enregistré. Ni PIN à tirer, ni
  // vérification à finir : le numéro sert déjà dans l'application.
  const aActiver = !coexistence && phone.status !== 'CONNECTED' && phone.codeVerificationStatus === 'NOT_VERIFIED';
  if (aActiver) {
    // eslint-disable-next-line no-console
    console.warn(`embedded-signup: numéro non vérifié, register non tenté (tenant ${tenant}, waba ${wabaId}, numéro ${phoneNumberId})`);
    warnings.push("ce numéro n'a pas encore été vérifié chez Meta : il est rattaché mais ne peut pas encore envoyer. Termine avec « Activer le numéro » sur l'Accueil.");
  } else if (!coexistence && phone.status !== 'CONNECTED') {
    pin = String(randomInt(100000, 1000000));
    try {
      await deps.meta.register(phoneNumberId, businessToken, pin);
    } catch (err) {
      const msg = texteDe(err);
      // eslint-disable-next-line no-console
      console.error(`embedded-signup: register refusé (tenant ${tenant}, waba ${wabaId}, numéro ${phoneNumberId}) : ${msg}`);
      warnings.push(`register du numéro : ${msg}`);
      pin = null;
    }
  }

  await deps.saveCredentials(wabaId, tenant, businessToken, pin);
  // Un espace relié par QR code passe en coexistence sur le même numéro : son appareil lié se retire, APRÈS le
  // rattachement (l'API prime alors déjà), et avant la trace, qui compte son avertissement.
  if (coexistence && (await retirerLAppareil(deps, tenant)) === 'echec') warnings.push(APPAREIL_NON_RETIRE);
  await tracer({ action: 'numero.connecte', wabaId, phoneNumberId, avertissements: warnings.length, coexistence });
  // 🔴 LE CRÉDIT EXIGE UN SIGNAL DE META, JAMAIS L'ÉVÉNEMENT DE LA FENÊTRE SEUL : le numéro dans l'application WhatsApp
  // Business (`is_on_biz_app`), `CONNECTED`, `VERIFIED`, ou un register accepté. Sinon la fenêtre ordinaire, un numéro
  // laissé `NOT_VERIFIED` et un corps qui annonce la coexistence récolteraient l'offre fermée le 2026-09-29. Elle reste
  // bornée à une par espace et par numéro affiché (`offrirAuNumeroVerifie`) : un espace déjà servi par son compte QR code
  // n'en reçoit pas une seconde.
  if (surApplication === true || phone.status === 'CONNECTED' || phone.codeVerificationStatus === 'VERIFIED' || pin !== null) {
    await offrir(deps, tenant, phoneNumberId);
  }
  return {
    ok: true,
    connected: true,
    wabaId,
    phoneNumberId,
    displayPhoneNumber: phone.displayPhoneNumber,
    aActiver,
    coexistence,
    warnings,
  };
}

/** Demande un code après avoir relu l'état Meta et acquis le délai commun à toutes les copies de l'API. */
export async function demanderCodeNumero(
  deps: DepsDemandeCodeNumero,
  input: { tenantId: string; methode: 'VOICE' | 'SMS' },
): Promise<IssueDemandeCodeNumero> {
  const { tenantId: tenant, methode } = input;
  const phoneNumberId = await deps.numeroDuTenant(tenant);
  if (phoneNumberId === null) return { ok: false, statut: 404, error: 'aucun numéro rattaché à cet espace' };
  // Avant Meta et avant le délai : un numéro en coexistence n'a pas de code à recevoir.
  if (await deps.enCoexistence(tenant)) return { ok: false, statut: 409, error: NUMERO_EN_COEXISTENCE };

  let etat: { status: string | null; codeVerificationStatus: string | null };
  try {
    etat = await deps.etatNumero(tenant, phoneNumberId);
  } catch (err) {
    if (err instanceof CompteChez360dialog) throw err;
    const msg = texteDe(err);
    // eslint-disable-next-line no-console
    console.error(`numero/code: état illisible chez Meta (tenant ${tenant}, numéro ${phoneNumberId}) : ${msg}`);
    return { ok: false, statut: 422, error: `état du numéro illisible chez Meta : ${msg}` };
  }
  if (etat.status === 'CONNECTED') {
    return { ok: false, statut: 409, error: 'ce numéro est déjà activé : il peut envoyer.' };
  }
  if (etat.codeVerificationStatus === 'VERIFIED') {
    return { ok: false, statut: 409, error: 'ce numéro est déjà vérifié : il ne reste qu’à l’activer, sans nouveau code.' };
  }

  let delai: Prise | null;
  try {
    delai = await deps.verrous.prendre([[cleDemandeCode(phoneNumberId), DELAI_ENTRE_CODES_MS]]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`numero/code: délai entre deux codes illisible (tenant ${tenant}, numéro ${phoneNumberId}) : ${texteDe(err)}`);
    return { ok: false, statut: 429, error: 'impossible de vérifier le dernier envoi de code pour l’instant : réessaie dans un instant. Meta n’en permet que dix par numéro sur 72 heures.' };
  }
  if (delai === null) {
    return { ok: false, statut: 429, error: 'un code vient d’être envoyé. Attends une minute avant d’en redemander un : Meta n’en permet que dix par numéro sur 72 heures.' };
  }
  try {
    await deps.demanderCode(tenant, phoneNumberId, methode);
  } catch (err) {
    const msg = texteDe(err);
    // eslint-disable-next-line no-console
    console.error(`numero/code: refus de Meta (tenant ${tenant}, numéro ${phoneNumberId}, ${methode}) : ${msg}`);
    return { ok: false, statut: 422, error: `Meta a refusé l’envoi du code : ${msg}` };
  }
  return { ok: true, methode };
}

/** Vérifie si nécessaire, sert l'offre au point où la vérification est acquise, puis active et conserve le PIN. */
export async function activerNumero(
  deps: DepsActivationNumero,
  input: { tenantId: string; code?: string },
  tracer: TracerConnexionNumero,
): Promise<IssueActivationNumero> {
  const tenant = input.tenantId;
  const phoneNumberId = await deps.numeroDuTenant(tenant);
  if (phoneNumberId === null) return { ok: false, statut: 404, error: 'aucun numéro rattaché à cet espace' };
  // Avant Meta : un numéro en coexistence n'a ni vérification à finir, ni `/register` à recevoir.
  if (await deps.enCoexistence(tenant)) return { ok: false, statut: 409, error: NUMERO_EN_COEXISTENCE };

  let etat: { status: string | null; codeVerificationStatus: string | null };
  try {
    etat = await deps.etatNumero(tenant, phoneNumberId);
  } catch (err) {
    if (err instanceof CompteChez360dialog) throw err;
    const msg = texteDe(err);
    // eslint-disable-next-line no-console
    console.error(`numero/activer: état illisible chez Meta (tenant ${tenant}, numéro ${phoneNumberId}) : ${msg}`);
    return { ok: false, statut: 422, error: `état du numéro illisible chez Meta : ${msg}` };
  }
  if (etat.status === 'CONNECTED') {
    await offrir(deps, tenant, phoneNumberId);
    return { ok: true, actif: true, deja: true };
  }

  const verificationFaite = etat.codeVerificationStatus !== 'VERIFIED';
  if (verificationFaite) {
    if (input.code === undefined || input.code.trim() === '') {
      return { ok: false, statut: 400, error: 'code requis : ce numéro n’est pas encore vérifié chez Meta. Demande un code, puis saisis-le.' };
    }
    try {
      await deps.verifierCode(tenant, phoneNumberId, input.code.trim());
    } catch (err) {
      const msg = texteDe(err);
      // eslint-disable-next-line no-console
      console.error(`numero/activer: code refusé par Meta (tenant ${tenant}, numéro ${phoneNumberId}) : ${msg}`);
      return { ok: false, statut: 422, error: `Meta a refusé ce code : ${msg}` };
    }
  }

  await offrir(deps, tenant, phoneNumberId);
  const pin = String(randomInt(100000, 1000000));
  try {
    await deps.enregistrerNumero(tenant, phoneNumberId, pin);
  } catch (err) {
    const msg = texteDe(err);
    // eslint-disable-next-line no-console
    console.error(`numero/activer: register refusé par Meta (tenant ${tenant}, numéro ${phoneNumberId}) : ${msg}`);
    return { ok: false, statut: 422, error: `Meta a refusé l’activation : ${msg}` };
  }
  try {
    await deps.sauverPin(tenant, pin);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`numero/activer: numéro activé mais PIN non conservé (tenant ${tenant}, numéro ${phoneNumberId}) : ${texteDe(err)}`);
  }
  await tracer({ action: 'numero.active', phoneNumberId, verificationFaite });
  return { ok: true, actif: true, deja: false };
}
