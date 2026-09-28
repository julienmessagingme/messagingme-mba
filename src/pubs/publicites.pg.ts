import type { Pool } from 'pg';
import type { DestinationPub, PubDuLead } from './routage';

/** L'état local d'une publicité, le nôtre, à ne pas confondre avec celui de Meta (`statut_meta`). */
export type EtatPublicite = 'creation' | 'echec_creation' | 'prete' | 'publiee';

/** Une publicité, telle que l'écran la liste. */
export interface Publicite {
  id: string;
  campagneId: string;
  ensembleId: string | null;
  creaId: string | null;
  pubId: string | null;
  nom: string;
  etat: EtatPublicite;
  statutMeta: string | null;
  motifRefus: string | null;
  budgetTotal: number | null;
  debut: Date | null;
  fin: Date | null;
  destination: DestinationPub;
  workflowId: string | null;
  tagQualification: string | null;
  automationId: string | null;
  depense: number | null;
  clics: number | null;
  luLe: Date | null;
  creeLe: Date;
  /** Rangée hors de la liste par le client (0189). Un rangement d'écran : rien d'autre ne la lit. */
  archiveeLe: Date | null;
}

const COLS = `id, campagne_id, ensemble_id, crea_id, pub_id, nom, etat, statut_meta, motif_refus,
              budget_total, debut, fin, destination, workflow_id, tag_qualification, automation_id,
              depense, clics, lu_le, cree_le, archivee_le`;

interface Brut {
  id: string; campagne_id: string; ensemble_id: string | null; crea_id: string | null; pub_id: string | null;
  nom: string; etat: string; statut_meta: string | null; motif_refus: string | null;
  budget_total: string | null; debut: Date | null; fin: Date | null; destination: string;
  workflow_id: string | null; tag_qualification: string | null; automation_id: string | null;
  depense: string | null; clics: number | null; lu_le: Date | null; cree_le: Date; archivee_le: Date | null;
}

/**
 * `numeric` arrive en chaîne depuis `pg` (un `numeric(12,2)` ne tient pas toujours dans un `number`). Nos
 * montants sont des euros à deux décimales, la conversion est sûre ; faite ici une fois, elle évite qu'un
 * écran additionne des chaînes (« 12.5012.50 »).
 */
function nombre(v: string | null): number | null {
  return v === null ? null : Number(v);
}

function versPublicite(r: Brut): Publicite {
  return {
    id: r.id,
    campagneId: r.campagne_id,
    ensembleId: r.ensemble_id,
    creaId: r.crea_id,
    pubId: r.pub_id,
    nom: r.nom,
    // Le CHECK de la base borne les deux colonnes ; revérifié pour qu'une valeur écrite à la main ne devienne
    // pas un état inventé à l'écran.
    etat: estEtat(r.etat) ? r.etat : 'creation',
    statutMeta: r.statut_meta,
    motifRefus: r.motif_refus,
    budgetTotal: nombre(r.budget_total),
    debut: r.debut,
    fin: r.fin,
    destination: r.destination === 'agent_meta' ? 'agent_meta' : 'scenario',
    workflowId: r.workflow_id,
    tagQualification: r.tag_qualification,
    automationId: r.automation_id,
    depense: nombre(r.depense),
    clics: r.clics,
    luLe: r.lu_le,
    creeLe: r.cree_le,
    archiveeLe: r.archivee_le,
  };
}

function estEtat(v: string): v is EtatPublicite {
  return v === 'creation' || v === 'echec_creation' || v === 'prete' || v === 'publiee';
}

/**
 * Les publicités d'un espace (`publicites`) et la correspondance pub vers campagne (`pubs_connues`).
 *
 * 🔴 `tenant_id = $1` sur chaque requête : le pooler est superuser, la RLS est contournée, ce filtrage est
 * le contrôle d'isolation.
 *
 * `possede_par = 'publicite'` est écrit en dur dans le SQL : interpolé, il aurait à la relecture la forme
 * d'une injection. `tests/automation-chaine-reprend-la-main.test.ts` le tient aligné avec la constante. Cette
 * garde miroir limite ce store à ses propres automations.
 *
 * Sur le chemin chaud des messages entrants (`pubDeLaCampagne`, `campagneConnue`) : deux requêtes sur clé,
 * aucun appel à Meta.
 */
export class PgPublicitesStore {
  constructor(private readonly pool: Pool) {}

  /**
   * La publicité que nous pilotons pour cette campagne Meta, ou `null`. Aucun filtre sur l'état : la ligne dit
   * l'intention du client, juste quelle que soit l'étape de la pub. Filtrer sur `publiee` enverrait n'importe
   * où les leads d'une pub créée en pause puis activée depuis le Gestionnaire.
   */
  async pubDeLaCampagne(tenantId: string, campagneId: string): Promise<PubDuLead | null> {
    const { rows } = await this.pool.query<{ campagne_id: string; destination: string; automation_id: string | null }>(
      /**
       * L'automation n'est rendue que si elle est allumée : une publicité pas encore publiée (automation éteinte)
       * ferait sinon prendre le fil à l'agent de Meta pour que personne ne parle. `possede_par = 'publicite'` en
       * garde miroir : on ne lit que l'automation de la publicité.
       */
      `select p.campagne_id, p.destination,
              (select a.id from automations a
                where a.id = p.automation_id and a.tenant_id = p.tenant_id
                  and a.possede_par = 'publicite' and a.enabled) as automation_id
         from publicites p where p.tenant_id = $1 and p.campagne_id = $2`,
      [tenantId, campagneId],
    );
    const r = rows[0];
    if (r === undefined) return null;
    // Revérifiée malgré le CHECK : une valeur écrite à la main doit rendre « campagne inconnue », pas une
    // destination inventée sur le chemin chaud.
    if (r.destination !== 'scenario' && r.destination !== 'agent_meta') return null;
    return { campagneId: r.campagne_id, destination: r.destination, automationId: r.automation_id };
  }

  /** La campagne de cette publicité, d'après ce qu'on a déjà mémorisé. `null` = jamais vue. */
  async campagneConnue(tenantId: string, adId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ campagne_id: string }>(
      'select campagne_id from pubs_connues where tenant_id = $1 and ad_id = $2',
      [tenantId, adId],
    );
    return rows[0]?.campagne_id ?? null;
  }

  /**
   * Mémorise « cette publicité appartient à cette campagne ». `do nothing` plutôt que `do update` : chez Meta,
   * une pub ne change jamais de campagne.
   */
  async memoriserPub(tenantId: string, adId: string, campagneId: string): Promise<void> {
    await this.pool.query(
      `insert into pubs_connues (tenant_id, ad_id, campagne_id) values ($1, $2, $3)
       on conflict (tenant_id, ad_id) do nothing`,
      [tenantId, adId, campagneId],
    );
  }

  /** Les publicités de cet espace, la plus récente d'abord. C'est ce que l'écran liste. */
  async lister(tenantId: string): Promise<Publicite[]> {
    const { rows } = await this.pool.query<Brut>(
      `select ${COLS} from publicites where tenant_id = $1 order by cree_le desc`,
      [tenantId],
    );
    return rows.map(versPublicite);
  }

  /**
   * Archive (ou désarchive) une publicité de CET espace. 🔴 Jamais une publicité qui peut diffuser : publiée et
   * `ACTIVE` chez Meta, ou publiée sans statut encore lu (`null` n'est pas « en pause »). Sinon le client rangerait
   * une campagne qui dépense. Le refus se lit dans le même `update`, sans lecture préalable qui pourrait vieillir.
   */
  async archiver(tenantId: string, id: string, archiver: boolean): Promise<'ok' | 'introuvable' | 'diffuse'> {
    const res = await this.pool.query(
      `update publicites set archivee_le = case when $3::boolean then now() else null end
        where tenant_id = $1 and id = $2
          and (not $3::boolean or not (etat = 'publiee' and (statut_meta is null or statut_meta = 'ACTIVE')))`,
      [tenantId, id, archiver],
    );
    if ((res.rowCount ?? 0) > 0) return 'ok';
    const existe = await this.pool.query(`select 1 from publicites where tenant_id = $1 and id = $2`, [tenantId, id]);
    return existe.rowCount ? 'diffuse' : 'introuvable';
  }

  async lire(tenantId: string, id: string): Promise<Publicite | null> {
    const { rows } = await this.pool.query<Brut>(
      `select ${COLS} from publicites where tenant_id = $1 and id = $2`,
      [tenantId, id],
    );
    const r = rows[0];
    return r === undefined ? null : versPublicite(r);
  }

  /** Ouvre la ligne, en état `creation`, juste après que Meta a rendu l'identifiant de la campagne. */
  async ouvrir(tenantId: string, v: {
    campagneId: string; nom: string; destination: DestinationPub;
    workflowId: string | null; tagQualification: string | null;
    budgetTotal: number; debut: string; fin: string; creePar: string | null;
  }): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `insert into publicites (tenant_id, campagne_id, nom, destination, workflow_id, tag_qualification,
                               budget_total, debut, fin, cree_par, etat)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'creation')
       returning id`,
      [tenantId, v.campagneId, v.nom, v.destination, v.workflowId, v.tagQualification,
       v.budgetTotal, v.debut, v.fin, v.creePar],
    );
    const r = rows[0];
    if (r === undefined) throw new Error('publicité non enregistrée');
    return r.id;
  }

  /**
   * Range les identifiants Meta au fur et à mesure. `coalesce($n, colonne)` : un appel qui ne porte qu'un
   * identifiant n'efface pas les autres, que le rattrapage doit pouvoir supprimer.
   */
  async noterIds(tenantId: string, id: string, v: { ensembleId?: string; creaId?: string; pubId?: string }): Promise<void> {
    await this.pool.query(
      `update publicites set ensemble_id = coalesce($3, ensemble_id),
                             crea_id     = coalesce($4, crea_id),
                             pub_id      = coalesce($5, pub_id)
         where tenant_id = $1 and id = $2`,
      [tenantId, id, v.ensembleId ?? null, v.creaId ?? null, v.pubId ?? null],
    );
  }

  /**
   * Écrit tout de suite le statut Meta après une pause ou une reprise, sans attendre le balayage : un statut
   * optimiste (Meta vient d'accepter le geste), sans lequel l'écran afficherait « Diffuse » un quart d'heure.
   * Le balayage suivant le remplace, et c'est lui qui fait foi.
   */
  async noterStatutMeta(tenantId: string, id: string, statut: string): Promise<void> {
    await this.pool.query(
      'update publicites set statut_meta = $3 where tenant_id = $1 and id = $2',
      [tenantId, id, statut],
    );
  }

  async marquerEtat(tenantId: string, id: string, etat: EtatPublicite): Promise<void> {
    await this.pool.query(
      'update publicites set etat = $3 where tenant_id = $1 and id = $2',
      [tenantId, id, etat],
    );
  }

  /**
   * Crée l'automation possédée d'une publicité, éteinte, et la rattache ; rend son identifiant. Requête propre
   * sur `automations` : `PgAutomationStore` exclut les lignes possédées.
   *
   * `max_fires_per_hour` à zéro, c'est-à-dire aucun plafond : chaque déclenchement est un prospect qui a coûté
   * un clic, et le plafond global ferait ignorer en silence les leads au-delà du deux-centième. L'anti-rebond
   * reste au défaut (une heure par contact) : il protège d'un contact qui reclique.
   */
  async creerAutomation(tenantId: string, publiciteId: string, v: {
    nom: string; campagneId: string; workflowId: string;
  }): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `insert into automations (tenant_id, name, enabled, trigger_kind, trigger_config, condition_group,
                                workflow_id, start_node_id, cooldown_seconds, possede_par, max_fires_per_hour)
       values ($1, $2, false, 'ctwa_ad', $3::jsonb, null, $4, null, null, 'publicite', 0)
       returning id`,
      [tenantId, `Publicité : ${v.nom}`, JSON.stringify({ campaignId: v.campagneId }), v.workflowId],
    );
    const r = rows[0];
    if (r === undefined) throw new Error('automation de publicité non créée');
    await this.pool.query(
      'update publicites set automation_id = $3 where tenant_id = $1 and id = $2',
      [tenantId, publiciteId, r.id],
    );
    return r.id;
  }

  /**
   * Allume l'automation possédée de cette publicité ; `false` = il n'y en a pas (destination agent de Meta, ou
   * scénario supprimé depuis). `possede_par` est une garde miroir (voir l'en-tête de la classe).
   */
  async allumerAutomation(tenantId: string, publiciteId: string): Promise<boolean> {
    return this.basculerAutomation(tenantId, publiciteId, true);
  }

  private async basculerAutomation(tenantId: string, publiciteId: string, allumee: boolean): Promise<boolean> {
    const res = await this.pool.query(
      `update automations set enabled = $3
         where tenant_id = $1
           and possede_par = 'publicite'
           and id = (select automation_id from publicites where tenant_id = $1 and id = $2)`,
      [tenantId, publiciteId, allumee],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Défait l'automation qu'on vient de créer quand la création échoue juste après : possédée, elle serait
   * sinon invisible et intouchable depuis l'écran Automation. Même garde miroir.
   */
  async supprimerAutomation(tenantId: string, automationId: string): Promise<void> {
    await this.pool.query(
      `delete from automations where tenant_id = $1 and id = $2 and possede_par = 'publicite'`,
      [tenantId, automationId],
    );
  }

  /**
   * Les espaces que le balayage doit relire : connectés, et portant au moins une publicité publiée. La
   * jointure sur `pub_connexion` écarte un espace déconnecté avec des publicités publiées, cas normal (la
   * déconnexion est autorisée) qui reviendrait sinon à chaque passage sans jeton.
   */
  async espacesASuivre(): Promise<string[]> {
    const { rows } = await this.pool.query<{ tenant_id: string }>(
      `select distinct p.tenant_id from publicites p
         join pub_connexion c on c.tenant_id = p.tenant_id
        where p.etat = 'publiee'`,
    );
    return rows.map((r) => r.tenant_id);
  }

  /**
   * Les campagnes à relire pour cet espace, les moins fraîches d'abord. Le `where` doit rester dans le contrat
   * de l'index partiel `publicites_a_suivre_idx` (`etat = 'publiee'`) : l'élargir ne produirait aucune
   * erreur, juste un balayage complet toutes les quinze minutes. `nulls first` n'a pas d'effet tant que la
   * requête n'a pas de plafond ; il servira le jour où la lecture se fera par paquets.
   */
  async campagnesASuivre(tenantId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ campagne_id: string }>(
      `select campagne_id from publicites
        where tenant_id = $1 and etat = 'publiee'
        order by lu_le asc nulls first`,
      [tenantId],
    );
    return rows.map((r) => r.campagne_id);
  }

  /**
   * Écrit ce que Meta a rendu. `coalesce($n, colonne)` partout sauf `lu_le` : une lecture vide (statistiques
   * pas prêtes) n'efface pas la dépense d'hier ; `lu_le` avance toujours, il dit « on a demandé ».
   */
  async noterSuivi(tenantId: string, campagneId: string, v: {
    statutMeta: string | null; motifRefus: string | null; debut: string | null; fin: string | null;
    /**
     * Le budget total, tel que Meta le renvoie : un budget modifié dans le Gestionnaire doit être rattrapé,
     * sinon « dépense sur budget » deviendrait faux sans bruit.
     */
    budgetTotal: number | null;
    depense: number | null; clics: number | null;
  }): Promise<void> {
    await this.pool.query(
      `update publicites
          set statut_meta = coalesce($3, statut_meta),
              motif_refus = coalesce($4, motif_refus),
              debut        = coalesce($5::timestamptz, debut),
              fin          = coalesce($6::timestamptz, fin),
              budget_total = coalesce($7, budget_total),
              depense      = coalesce($8, depense),
              clics        = coalesce($9, clics),
              lu_le        = now()
        where tenant_id = $1 and campagne_id = $2`,
      [tenantId, campagneId, v.statutMeta, v.motifRefus, v.debut, v.fin, v.budgetTotal, v.depense, v.clics],
    );
  }

  /**
   * Ce que nos tables comptent pour une campagne : prospects, qualifiés, non pris en charge. Des contacts
   * distincts, pas des arrivées : un prospect qui reclique reste une personne, et compter les lignes ferait
   * baisser le coût par prospect affiché. Les issues « non prises en charge » voyagent en paramètre, leur
   * liste vit dans `src/pubs/entonnoir.ts`. `campagne_id = $2` garde la requête dans l'index partiel
   * `arrivees_pub_campagne_idx` (`campagne_id is not null`).
   */
  async comptesDeLaCampagne(tenantId: string, campagneId: string, issuesNonPrises: readonly string[]): Promise<{
    leads: number; qualifies: number; nonPrisEnCharge: number;
  }> {
    const { rows } = await this.pool.query<{ leads: number; qualifies: number; non_pris: number }>(
      `select count(distinct contact_id)::int as leads,
              count(distinct contact_id) filter (where qualifie_le is not null)::int as qualifies,
              count(distinct contact_id) filter (where issue = any($3::text[]))::int as non_pris
         from arrivees_pub
        where tenant_id = $1 and campagne_id = $2`,
      [tenantId, campagneId, [...issuesNonPrises]],
    );
    const r = rows[0];
    return {
      leads: r?.leads ?? 0,
      qualifies: r?.qualifies ?? 0,
      nonPrisEnCharge: r?.non_pris ?? 0,
    };
  }

  /**
   * Ce scénario est-il utilisé par une publicité vivante ? Sert le refus 409 de la suppression d'un scénario.
   * « Vivante » exclut `echec_creation` seulement : une pub `prete` (en pause chez Meta) sera publiée, son
   * scénario doit exister.
   */
  async publicitesQuiUtilisent(tenantId: string, workflowId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ nom: string }>(
      `select nom from publicites
        where tenant_id = $1 and workflow_id = $2 and etat <> 'echec_creation'
        order by cree_le desc`,
      [tenantId, workflowId],
    );
    return rows.map((r) => r.nom);
  }
}
