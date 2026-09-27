import { z } from 'zod';
import { resolutionPublique, type VerdictResolution } from '../lib/adresse-privee';
import { SalesforceApiError, VERSION_API_SALESFORCE, type ClientSalesforce } from './client';
import { lireMyDomain } from './my-domain';
import type { DebutConnexion, IssueDebutConnexion, VueOrgSalesforce } from './store.pg';

/**
 * RELIER UN ESPACE À UNE ORG SALESFORCE, et l'en délier (plan 2026-09-26, lot L1 ; spec, § « La connexion »).
 *
 * L'admin a installé le package, créé l'utilisateur d'intégration, lui a donné notre jeu de permissions et l'a
 * désigné « Run As » ; il colle l'adresse de son org et clique « Connecter ». Dans cet ordre :
 * garde textuelle de l'adresse, résolution publique, jeton, identité de l'org, état du package (présence,
 * version, droits), PUIS le secret : écrit chez nous en état `connexion`, posé dans l'org, et seulement alors
 * `connectee`. Chaque manque est rendu avec l'ÉTAPE du guide qui le règle (`ETAPES_GUIDE`, ancres de la page
 * tuto), jamais comme une panne.
 *
 * 🔴 LE CONTRAT AVEC LE PACKAGE (les deux ressources Apex REST, sous le namespace) est figé ICI, avant que le
 * package n'existe : la liaison du namespace au Dev Hub est bloquée par Salesforce (docs/salesforce-mesures-
 * 2026-09.md). L'Apex l'implémentera tel quel.
 * - `GET  /services/apexrest/engagemeapp/v1/etat`   : `{ version, manques }`, où `manques` liste ce que
 *   l'utilisateur d'intégration ne peut pas lire ou écrire (c'est l'Apex, exécuté par lui, qui le sait le mieux).
 * - `PUT  /services/apexrest/engagemeapp/v1/secret` : `{ secret }`, rangé dans le paramètre protégé du package.
 * - `DELETE` sur la même ressource : efface le secret.
 */

export const NAMESPACE_PACKAGE = 'engagemeapp';
/** La plus ancienne version du package que ce serveur sait servir. */
export const VERSION_PACKAGE_MIN = '0.1';

/**
 * Les étapes du guide, dans l'ordre où l'admin les fait. Chacune est une ANCRE de la page tuto
 * (`web/app/tuto-salesforce`) : la parité est tenue par un test, sinon les liens des manques mourraient en silence.
 */
export const ETAPES_GUIDE = ['adresse', 'package', 'utilisateur', 'run-as', 'droits', 'org'] as const;
export type EtapeGuide = (typeof ETAPES_GUIDE)[number];

export interface Manque {
  etape: EtapeGuide;
  message: string;
}

export type IssueConnexion =
  | { ok: true; orgId: string; sandbox: boolean }
  | { ok: false; manques: Manque[] }
  /** Salesforce ou le chemin vers lui est en panne : rien n'est cassé, il faut réessayer. */
  | { ok: false; passager: true; message: string };

export interface DepsConnexion {
  client: ClientSalesforce;
  /**
   * La seconde vérification d'une adresse saisie par un client (ce vers quoi le nom RÉSOUT). `resolutionPublique`
   * par défaut, pour qu'un câblage ne puisse pas l'oublier ; injectable pour éprouver la connexion sans DNS.
   * Inventaire : `tests/lib-adresse-privee.test.ts`.
   */
  verifierResolution?(url: string): Promise<VerdictResolution>;
  store: {
    commencerConnexion(tenantId: string, d: DebutConnexion): Promise<IssueDebutConnexion>;
    confirmerConnexion(tenantId: string): Promise<boolean>;
    supprimer(tenantId: string): Promise<boolean>;
    lire(tenantId: string): Promise<VueOrgSalesforce | null>;
  };
  genererSecret(): string;
}

const schemaOrganisation = z.object({
  records: z.array(z.object({ Id: z.string(), IsSandbox: z.boolean(), OrganizationType: z.string().nullable().optional() })).min(1),
});
const schemaEtatPackage = z.object({ version: z.string().min(1), manques: z.array(z.string()) });

const CHEMIN_ETAT = `/services/apexrest/${NAMESPACE_PACKAGE}/v1/etat`;
const CHEMIN_SECRET = `/services/apexrest/${NAMESPACE_PACKAGE}/v1/secret`;

/** « 0.10 » est plus récent que « 0.9 » : on compare les nombres, pas le texte. */
export function versionAuMoins(version: string, minimum: string): boolean {
  const a = version.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const b = minimum.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
}

const manque = (etape: EtapeGuide, message: string): IssueConnexion => ({ ok: false, manques: [{ etape, message }] });

/** Une erreur du client, traduite pour l'admin : un manque quand il peut agir, un passager sinon. */
function traduire(err: unknown, etapeDuRefus: EtapeGuide): IssueConnexion {
  if (!(err instanceof SalesforceApiError)) throw err;
  switch (err.code) {
    case 'adresse_interne':
    case 'adresse_changee':
      return manque('adresse', err.message);
    case 'jeton_refuse':
      return manque(etapeDuRefus, etapeDuRefus === 'run-as'
        ? "L'org refuse de délivrer un jeton à Engage Me : vérifiez que le package est installé et que l'utilisateur d'intégration est désigné « Run As » de l'app Engage Me."
        : "Salesforce a refusé l'accès de l'utilisateur d'intégration.");
    case 'refus':
      return manque(etapeDuRefus, `Salesforce a refusé l'appel (${err.errorCode ?? err.status ?? 'refus'}).`);
    case 'quota_epuise':
      return { ok: false, passager: true, message: "Le quota d'appels à l'API de votre org est épuisé pour aujourd'hui : réessayez demain." };
    case 'injoignable':
    case 'passager':
    case 'reponse_illisible':
    case 'reponse_trop_grosse':
      return { ok: false, passager: true, message: "L'org Salesforce n'a pas répondu comme prévu : réessayez dans quelques minutes." };
    default: {
      const inconnu: never = err.code;
      throw new Error(`code inconnu ${String(inconnu)}`);
    }
  }
}

export async function connecter(deps: DepsConnexion, tenantId: string, adresseBrute: string, auteurId: string | null): Promise<IssueConnexion> {
  const adresse = lireMyDomain(adresseBrute);
  if (!adresse.ok) return manque('adresse', adresse.raison);
  const resolution = await (deps.verifierResolution ?? resolutionPublique)(adresse.origine);
  if (!resolution.ok) return manque('adresse', `Adresse refusée : ${resolution.raison ?? 'introuvable'}.`);

  let orgId: string;
  let sandbox: boolean;
  let utilisateur: string | null;
  try {
    const jeton = await deps.client.jeton(adresse.origine);
    utilisateur = jeton.userId;
    const org = await deps.client.requete(adresse.origine, 'GET',
      `/services/data/${VERSION_API_SALESFORCE}/query?q=${encodeURIComponent('SELECT Id, IsSandbox, OrganizationType FROM Organization')}`,
      schemaOrganisation);
    const ligne = org.donnees?.records[0];
    if (!ligne) return { ok: false, passager: true, message: "L'org Salesforce n'a pas dit qui elle est : réessayez." };
    // L'API REST rend les identifiants sur 18 caractères, la forme que la table exige.
    orgId = ligne.Id;
    sandbox = ligne.IsSandbox;
  } catch (err) {
    return traduire(err, 'run-as');
  }
  if (!/^00D[0-9A-Za-z]{15}$/.test(orgId)) return { ok: false, passager: true, message: "L'identifiant de l'org rendu par Salesforce est illisible." };

  let version: string;
  try {
    const etat = await deps.client.requete(adresse.origine, 'GET', CHEMIN_ETAT, schemaEtatPackage);
    if (!etat.donnees) return manque('package', "Le package Engage Me n'a pas répondu : vérifiez qu'il est installé.");
    version = etat.donnees.version;
    if (!versionAuMoins(version, VERSION_PACKAGE_MIN)) {
      return manque('package', `Le package Engage Me installé (${version}) est trop ancien : installez la dernière version.`);
    }
    if (etat.donnees.manques.length > 0) {
      return { ok: false, manques: [{ etape: 'droits', message: `L'utilisateur d'intégration n'a pas tous les droits : ${etat.donnees.manques.join(', ')}.` }] };
    }
  } catch (err) {
    if (err instanceof SalesforceApiError && err.code === 'refus' && err.status === 404) {
      return manque('package', "Le package Engage Me n'est pas installé dans cette org.");
    }
    if (err instanceof SalesforceApiError && err.code === 'refus' && err.status === 403) {
      return manque('droits', "L'utilisateur d'intégration n'a pas le jeu de permissions Engage Me.");
    }
    return traduire(err, 'package');
  }

  const secret = deps.genererSecret();
  const debut = await deps.store.commencerConnexion(tenantId, {
    orgId, myDomain: adresse.origine, sandbox, utilisateurIntegration: utilisateur, versionPackage: version, connecteePar: auteurId, secretClair: secret,
  });
  if (debut === 'org_ailleurs') return manque('org', 'Cette org Salesforce est déjà reliée à un autre espace Engage Me.');
  if (debut === 'autre_org') return manque('org', 'Votre espace est relié à une autre org Salesforce : déconnectez-la d’abord.');

  try {
    await deps.client.requete(adresse.origine, 'PUT', CHEMIN_SECRET, z.unknown(), { secret });
  } catch (err) {
    // La ligne reste en `connexion` : rien ne part, et le prochain clic « Connecter » reprend au début.
    return traduire(err, 'droits');
  }
  if (!(await deps.store.confirmerConnexion(tenantId))) {
    return { ok: false, passager: true, message: 'La connexion a été modifiée pendant qu’on la faisait : réessayez.' };
  }
  return { ok: true, orgId, sandbox };
}

export type IssueDeconnexion =
  | { ok: true; effaceDansOrg: boolean }
  | { ok: false; raison: 'aucune_org' };

/**
 * Délie l'espace : efface le secret dans l'org, PUIS supprime la ligne chez nous. Une org injoignable (package
 * désinstallé, jeton refusé) n'empêche pas d'oublier chez nous : elle ne peut plus rien signer d'utile, et refuser
 * bloquerait l'espace. L'écran dit alors que l'effacement dans l'org n'a pas pu se faire.
 */
export async function deconnecter(deps: DepsConnexion, tenantId: string): Promise<IssueDeconnexion> {
  const org = await deps.store.lire(tenantId);
  if (!org) return { ok: false, raison: 'aucune_org' };
  let effaceDansOrg = false;
  try {
    await deps.client.requete(org.myDomain, 'DELETE', CHEMIN_SECRET, z.unknown());
    effaceDansOrg = true;
  } catch {
    effaceDansOrg = false;
  }
  deps.client.oublierJeton(org.myDomain);
  await deps.store.supprimer(tenantId);
  return { ok: true, effaceDansOrg };
}
