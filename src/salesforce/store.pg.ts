import type { Pool } from 'pg';
import { encryptSecret, decryptSecret } from '../crypto/secretbox';

/**
 * LE STORE DU CONNECTEUR SALESFORCE (plan 2026-09-26, lot L1), seul à lire et écrire le schéma `salesforce`.
 *
 * 🔴 AUCUN AUTRE FICHIER NE NOMME UNE TABLE `salesforce.*`, et ce fichier ne nomme AUCUNE table de `public` :
 * c'est ce qui rend le schéma extractible vers sa propre base (spec, § « Dans Messaging Me »). Le store reçoit son
 * pool par le constructeur, c'est la couture. `tests/salesforce-isolation.test.ts` tient les deux règles.
 *
 * 🔴 `tenant_id = $1` SUR CHAQUE REQUÊTE, sauf DEUX lectures transverses nommées ici et comptées par le test :
 * `orgParIdentifiant` (c'est elle qui DONNE l'espace, à partir de l'org qui signe un appel entrant) et
 * `espacesConnectes` (le cache de l'émetteur de signaux, comme `PgIntegrationBatchStore.espacesActifs`).
 *
 * 🔴 LE SECRET NE SORT JAMAIS EN CLAIR VERS UN ÉCRAN : `lire` ne le sélectionne pas. Il est chiffré ICI
 * (`ENCRYPTION_KEY`, comme `PgMfaStore`), donc aucune route ne manipule le texte chiffré, et seule
 * `orgParIdentifiant` le rend déchiffré, à la vérification d'une signature.
 */

export type EtatOrg = 'connexion' | 'connectee' | 'en_pause' | 'coupee';

export interface VueOrgSalesforce {
  orgId: string;
  myDomain: string;
  sandbox: boolean;
  etat: EtatOrg;
  motifCoupure: string | null;
  utilisateurIntegration: string | null;
  versionPackage: string | null;
  quota: { utilise: number; max: number; releveLe: string } | null;
  consentementLead: { champ: string; valeurOui: string | null; valeurNon: string | null } | null;
  consentementContact: { champ: string; valeurOui: string | null; valeurNon: string | null } | null;
  envoyerResume: boolean;
  proprietaireRepli: string | null;
  connecteeLe: string | null;
  majLe: string;
}

export interface DebutConnexion {
  orgId: string;
  myDomain: string;
  sandbox: boolean;
  utilisateurIntegration: string | null;
  versionPackage: string | null;
  connecteePar: string | null;
  secretClair: string;
}

export interface ReglagesSalesforce {
  consentementLead: { champ: string; valeurOui: string | null; valeurNon: string | null } | null;
  consentementContact: { champ: string; valeurOui: string | null; valeurNon: string | null } | null;
  envoyerResume: boolean;
  proprietaireRepli: string | null;
}

/**
 * `ok` : la ligne est écrite en état `connexion`.
 * `org_ailleurs` : cette org sert déjà un AUTRE espace (une org, un espace, dans les deux sens).
 * `autre_org` : cet espace est relié à une AUTRE org ; il faut la déconnecter d'abord, sinon les liens de fiches
 * de l'ancienne org resteraient attachés à la nouvelle.
 */
export type IssueDebutConnexion = 'ok' | 'org_ailleurs' | 'autre_org';

interface LigneOrg {
  org_id: string; my_domain: string; sandbox: boolean; etat: EtatOrg; motif_coupure: string | null;
  utilisateur_integration: string | null; version_package: string | null;
  quota_utilise: number | null; quota_max: number | null; quota_releve_le: Date | null;
  champ_consentement_lead: string | null; valeur_oui_lead: string | null; valeur_non_lead: string | null;
  champ_consentement_contact: string | null; valeur_oui_contact: string | null; valeur_non_contact: string | null;
  envoyer_resume: boolean; proprietaire_repli: string | null; connectee_le: Date | null; maj_le: Date;
}

const consentement = (champ: string | null, oui: string | null, non: string | null) =>
  champ === null ? null : { champ, valeurOui: oui, valeurNon: non };

export class PgSalesforceStore {
  constructor(private readonly pool: Pool, private readonly cle: string) {}

  async lire(tenantId: string): Promise<VueOrgSalesforce | null> {
    const res = await this.pool.query<LigneOrg>(
      `select org_id, my_domain, sandbox, etat, motif_coupure, utilisateur_integration, version_package,
              quota_utilise, quota_max, quota_releve_le,
              champ_consentement_lead, valeur_oui_lead, valeur_non_lead,
              champ_consentement_contact, valeur_oui_contact, valeur_non_contact,
              envoyer_resume, proprietaire_repli, connectee_le, maj_le
         from salesforce.orgs where tenant_id = $1`,
      [tenantId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      orgId: r.org_id,
      myDomain: r.my_domain,
      sandbox: r.sandbox,
      etat: r.etat,
      motifCoupure: r.motif_coupure,
      utilisateurIntegration: r.utilisateur_integration,
      versionPackage: r.version_package,
      quota: r.quota_utilise !== null && r.quota_max !== null && r.quota_releve_le !== null
        ? { utilise: r.quota_utilise, max: r.quota_max, releveLe: r.quota_releve_le.toISOString() }
        : null,
      consentementLead: consentement(r.champ_consentement_lead, r.valeur_oui_lead, r.valeur_non_lead),
      consentementContact: consentement(r.champ_consentement_contact, r.valeur_oui_contact, r.valeur_non_contact),
      envoyerResume: r.envoyer_resume,
      proprietaireRepli: r.proprietaire_repli,
      connecteeLe: r.connectee_le?.toISOString() ?? null,
      majLe: r.maj_le.toISOString(),
    };
  }

  /**
   * Première écriture d'une connexion : le secret est écrit CHEZ NOUS, chiffré, en état `connexion`, AVANT d'être
   * posé dans l'org. Dans l'ordre inverse, une panne entre les deux laisserait l'org signer avec un secret que
   * nous n'avons pas (401 permanents). Reconnecter la MÊME org remplace le secret et repasse en `connexion`.
   */
  async commencerConnexion(tenantId: string, d: DebutConnexion): Promise<IssueDebutConnexion> {
    try {
      const res = await this.pool.query(
        `insert into salesforce.orgs
           (tenant_id, org_id, my_domain, sandbox, etat, motif_coupure, secret_entrant_chiffre,
            utilisateur_integration, version_package, connectee_par, maj_le)
         values ($1, $2, $3, $4, 'connexion', null, $5, $6, $7, $8, now())
         on conflict (tenant_id) do update set
           my_domain = excluded.my_domain,
           sandbox = excluded.sandbox,
           etat = 'connexion',
           motif_coupure = null,
           secret_entrant_chiffre = excluded.secret_entrant_chiffre,
           utilisateur_integration = excluded.utilisateur_integration,
           version_package = excluded.version_package,
           connectee_par = excluded.connectee_par,
           maj_le = now()
         where salesforce.orgs.org_id = excluded.org_id`,
        [tenantId, d.orgId, d.myDomain, d.sandbox, encryptSecret(d.secretClair, this.cle), d.utilisateurIntegration, d.versionPackage, d.connecteePar],
      );
      return (res.rowCount ?? 0) > 0 ? 'ok' : 'autre_org';
    } catch (err) {
      // L'unicité de `org_id` : l'org sert déjà un autre espace. Toute autre erreur remonte.
      if ((err as { code?: string }).code === '23505') return 'org_ailleurs';
      throw err;
    }
  }

  /** Le secret est posé dans l'org : la connexion est faite. `false` si la ligne n'était plus en `connexion`. */
  async confirmerConnexion(tenantId: string): Promise<boolean> {
    const res = await this.pool.query(
      `update salesforce.orgs set etat = 'connectee', connectee_le = now(), maj_le = now()
        where tenant_id = $1 and etat = 'connexion'`,
      [tenantId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Jeton refusé, package désinstallé : plus rien ne part jusqu'à reconnexion. Idempotent. */
  async couper(tenantId: string, motif: string): Promise<void> {
    await this.pool.query(
      `update salesforce.orgs set etat = 'coupee', motif_coupure = $2, maj_le = now()
        where tenant_id = $1 and etat <> 'coupee'`,
      [tenantId, motif],
    );
  }

  /** La déconnexion SUPPRIME la ligne : l'org redevient libre pour un autre espace. */
  async supprimer(tenantId: string): Promise<boolean> {
    const res = await this.pool.query(`delete from salesforce.orgs where tenant_id = $1`, [tenantId]);
    return (res.rowCount ?? 0) > 0;
  }

  async enregistrerReglages(tenantId: string, r: ReglagesSalesforce): Promise<boolean> {
    const res = await this.pool.query(
      `update salesforce.orgs set
         champ_consentement_lead = $2, valeur_oui_lead = $3, valeur_non_lead = $4,
         champ_consentement_contact = $5, valeur_oui_contact = $6, valeur_non_contact = $7,
         envoyer_resume = $8, proprietaire_repli = $9, maj_le = now()
       where tenant_id = $1`,
      [
        tenantId,
        r.consentementLead?.champ ?? null, r.consentementLead?.valeurOui ?? null, r.consentementLead?.valeurNon ?? null,
        r.consentementContact?.champ ?? null, r.consentementContact?.valeurOui ?? null, r.consentementContact?.valeurNon ?? null,
        r.envoyerResume, r.proprietaireRepli,
      ],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Le quota d'API du client, relu à chaque réponse de Salesforce. Écrit SEULEMENT quand il change : sinon chaque
   * appel sortant coûterait une écriture sur la même ligne.
   */
  async noterQuota(tenantId: string, utilise: number, max: number): Promise<void> {
    await this.pool.query(
      `update salesforce.orgs set quota_utilise = $2, quota_max = $3, quota_releve_le = now()
        where tenant_id = $1 and (quota_utilise is distinct from $2 or quota_max is distinct from $3)`,
      [tenantId, utilise, max],
    );
  }

  /**
   * EXCEPTION TRANSVERSE 1 : l'org qui signe un appel entrant DONNE l'espace ; c'est donc la seule lecture qui ne
   * peut pas porter `tenant_id`. Le secret est rendu déchiffré, pour vérifier la signature, et à personne d'autre.
   * Une org sans secret (jamais connectée) rend `secret: null`, ce qui refuse toute signature.
   */
  async orgParIdentifiant(orgId: string): Promise<{ tenantId: string; etat: EtatOrg; secret: string | null } | null> {
    const res = await this.pool.query<{ tenant_id: string; etat: EtatOrg; secret_entrant_chiffre: string | null }>(
      `select tenant_id, etat, secret_entrant_chiffre from salesforce.orgs where org_id = $1`,
      [orgId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return { tenantId: r.tenant_id, etat: r.etat, secret: r.secret_entrant_chiffre === null ? null : decryptSecret(r.secret_entrant_chiffre, this.cle) };
  }

  /** EXCEPTION TRANSVERSE 2 : les espaces dont l'org est connectée, pour le cache de l'émetteur de signaux. */
  async espacesConnectes(): Promise<Set<string>> {
    const res = await this.pool.query<{ tenant_id: string }>(
      `select tenant_id from salesforce.orgs where etat = 'connectee'`,
    );
    return new Set(res.rows.map((r) => r.tenant_id));
  }
}
