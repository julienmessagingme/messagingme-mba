import type { Pool } from 'pg';
import type { DestinationPub, PubDuLead } from './routage';

/**
 * L'ÉTAT LOCAL d'une publicité, le NÔTRE, à ne pas confondre avec celui de Meta (`statut_meta`).
 * Le détail de chaque valeur vit dans la migration 0170, qui est la source.
 */
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
}

const COLS = `id, campagne_id, ensemble_id, crea_id, pub_id, nom, etat, statut_meta, motif_refus,
              budget_total, debut, fin, destination, workflow_id, tag_qualification, automation_id,
              depense, clics, lu_le, cree_le`;

interface Brut {
  id: string; campagne_id: string; ensemble_id: string | null; crea_id: string | null; pub_id: string | null;
  nom: string; etat: string; statut_meta: string | null; motif_refus: string | null;
  budget_total: string | null; debut: Date | null; fin: Date | null; destination: string;
  workflow_id: string | null; tag_qualification: string | null; automation_id: string | null;
  depense: string | null; clics: number | null; lu_le: Date | null; cree_le: Date;
}

/**
 * ⚠️ `numeric` ARRIVE EN CHAÎNE depuis `pg`, et c'est délibéré de sa part : un `numeric(12,2)` ne tient pas
 * toujours dans un `number` JavaScript sans perte. Nos montants, eux, sont des euros à deux décimales, donc
 * la conversion est sûre. La faire ICI, une fois, évite qu'un écran additionne des chaînes et affiche
 * « 12.5012.50 » au lieu de 25.
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
    // Le CHECK de 0170 borne les deux colonnes. On les revérifie quand même : une valeur écrite à la main en
    // base ne doit pas devenir un état inventé dans un écran.
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
  };
}

function estEtat(v: string): v is EtatPublicite {
  return v === 'creation' || v === 'echec_creation' || v === 'prete' || v === 'publiee';
}

/**
 * LES PUBLICITÉS D'UN ESPACE (`publicites`) ET LA CORRESPONDANCE PUB VERS CAMPAGNE (`pubs_connues`),
 * migration 0170.
 *
 * 🔴 `tenant_id = $1` SUR CHAQUE REQUÊTE, sans exception. La connexion au pooler est un rôle superuser, donc
 * la RLS est contournée : ce filtrage EST le contrôle d'isolation, pas une ceinture en plus.
 *
 * 🔴 `possede_par = 'publicite'` EST ÉCRIT EN DUR DANS LE SQL, ET C'EST DÉLIBÉRÉ. Interpoler la
 * constante supprimerait tout risque de divergence, mais donnerait à ces requêtes LA FORME EXACTE D'UNE
 * INJECTION à la relecture, dans un dépôt où l'on relit beaucoup de SQL. Le dépôt a déjà tranché ce
 * compromis pour les liens de chaîne : littéral en dur, et les deux moitiés tenues alignées par un test
 * qui LIT la source (`tests/automation-chaine-reprend-la-main.test.ts`).
 *
 * ⚠️ CE QUE CETTE GARDE MIROIR PROTÈGE : ce store ne peut toucher QUE ses propres automations, exactement
 * comme le prédicat de `PgAutomationStore` lui interdit de toucher les siennes.
 *
 * ⚠️ CE FICHIER EST SUR LE CHEMIN CHAUD DES MESSAGES ENTRANTS, par `pubDeLaCampagne` et `campagneConnue` :
 * deux requêtes sur clé, aucune jointure, aucun appel à Meta. Tout ce qui parle à Meta vit ailleurs.
 */
export class PgPublicitesStore {
  constructor(private readonly pool: Pool) {}

  /**
   * La publicité que NOUS pilotons pour cette campagne Meta, ou `null`.
   *
   * ⚠️ AUCUN FILTRE SUR L'ÉTAT, et c'est délibéré. Cette ligne dit l'INTENTION du client (« les leads de
   * cette campagne vont à ce scénario ») ; router selon l'intention est juste quelle que soit l'étape où en
   * est la pub. Filtrer sur `etat = 'publiee'` ferait exactement le contraire de ce qu'on veut dans le seul
   * cas où l'écart existe : une pub qu'on a créée en pause et que le client a activée depuis le Gestionnaire
   * enverrait alors ses leads dans « toutes les pubs », c'est-à-dire n'importe où.
   */
  async pubDeLaCampagne(tenantId: string, campagneId: string): Promise<PubDuLead | null> {
    const { rows } = await this.pool.query<{ campagne_id: string; destination: string; automation_id: string | null }>(
      /**
       * 🔴 L'AUTOMATION N'EST RENDUE QUE SI ELLE EST ALLUMÉE, et cette jointure est un CORRECTIF, pas une
       * optimisation. Sans elle, une publicité créée et pas encore publiée (son automation naît éteinte)
       * faisait PRENDRE LE FIL à l'agent de Meta pour que personne ne parle ensuite : un clic payé répondu
       * par un silence de vingt-quatre heures, là où l'agent de Meta répondait avant ce lot. Relevé par une
       * relecture à froid le 2026-09-23, avant tout déploiement.
       *
       * ⚠️ `possede_par = 'publicite'` EN GARDE MIROIR, ici aussi : cette jointure ne doit pouvoir lire que
       * l'automation de la publicité, jamais une autre qui porterait le même identifiant.
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
    // Le CHECK de 0170 borne la colonne à deux valeurs. On le revérifie quand même ici : une valeur écrite à
    // la main en base ne doit pas devenir une destination inventée sur le chemin chaud, elle doit rendre
    // « campagne inconnue », donc le comportement d'avant ce lot.
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
   * Mémorise « cette publicité appartient à cette campagne ».
   *
   * ⚠️ `do nothing` PLUTÔT QUE `do update` : chez Meta, une pub ne change jamais de campagne. Réécrire
   * laisserait croire le contraire, et ferait du dernier appel qui gagne la règle d'un fait immuable.
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
   * Range les identifiants Meta au fur et à mesure.
   *
   * ⚠️ `coalesce($n, colonne)` : un appel qui ne porte qu'un identifiant n'efface pas les autres. Sans ça,
   * ranger la créa effacerait l'ensemble qu'on venait d'écrire, et le rattrapage perdrait ce qu'il doit
   * supprimer.
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
   * Écrit tout de suite le statut Meta après une pause ou une reprise, sans attendre le balayage.
   *
   * ⚠️ UN STATUT OPTIMISTE, ET IL FAUT LE DIRE : Meta vient d'accepter le geste, donc cette valeur est
   * celle qu'il aura. Sans elle, l'écran afficherait « Diffuse » sur une campagne qu'on vient de mettre en
   * pause, jusqu'à quinze minutes, ce qui ferait recliquer. Le balayage suivant la remplace par ce que Meta
   * dit vraiment, et c'est lui qui fait foi.
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
   * CRÉE L'AUTOMATION POSSÉDÉE d'une publicité, ÉTEINTE, et la rattache. Rend son identifiant.
   *
   * 🔴 CE STORE ÉCRIT SA PROPRE REQUÊTE sur `automations`, il ne passe PAS par `PgAutomationStore`, qui
   * exclut délibérément toute ligne possédée (`HORS_WEBHOOK`). Même patron que le store des liens de chaîne.
   *
   * 🔴 `max_fires_per_hour` À ZÉRO, C'EST-À-DIRE AUCUN PLAFOND, et c'est une décision de la spec : « Plafond
   * horaire : aucun pour les pubs. » Le plafond de l'instance (200 par heure) borne des envois qu'un
   * événement de masse peut multiplier ; ici, chaque déclenchement est un PROSPECT QUI A COÛTÉ UN CLIC.
   * Laisser le plafond global l'emporter ferait ignorer en silence les leads au-delà du deux-centième, ce
   * qui est exactement le défaut n°4 relevé par la spec.
   *
   * ⚠️ L'ANTI-REBOND, LUI, RESTE AU DÉFAUT (`cooldown_seconds` à `null`, une heure par contact). Il protège
   * d'un même contact qui reclique, pas d'une population : le retirer ferait repartir le scénario à chaque
   * double clic.
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
   * Allume l'automation possédée de cette publicité. `false` = il n'y en a pas (destination agent de Meta,
   * ou scénario supprimé depuis).
   *
   * ⚠️ `possede_par` EST UNE GARDE MIROIR, pas une décoration : elle interdit à ce store de toucher une
   * automation qui ne lui appartient pas, exactement comme le prédicat de `PgAutomationStore` lui interdit
   * de toucher les siennes. Un littéral SQL ne se paramètre pas sans transformer une constante en
   * interpolation de chaîne dans une requête, ce qui a la forme exacte d'une injection à la relecture : les
   * deux moitiés sont donc tenues alignées par un test qui lit la source.
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
   * Défait l'automation qu'on vient de créer, quand la création échoue juste après.
   *
   * ⚠️ Sans ce rattrapage, l'automation reste POSSÉDÉE, donc exclue du prédicat de `PgAutomationStore`, donc
   * invisible ET intouchable depuis l'écran Automations. Même garde miroir que partout ailleurs ici.
   */
  async supprimerAutomation(tenantId: string, automationId: string): Promise<void> {
    await this.pool.query(
      `delete from automations where tenant_id = $1 and id = $2 and possede_par = 'publicite'`,
      [tenantId, automationId],
    );
  }

  /**
   * LES ESPACES QUE LE BALAYAGE DOIT RELIRE : connectés, et portant au moins une publicité publiée.
   *
   * ⚠️ LA JOINTURE SUR `pub_connexion` N'EST PAS DÉCORATIVE : sans elle, un espace déconnecté avec des
   * publicités publiées reviendrait à chaque passage pour qu'on constate, quinze minutes plus tard, qu'il
   * n'y a pas de jeton. La spec l'autorise explicitement (« Déconnexion : autorisée. Si une pub est active,
   * l'avertissement dit qu'elle continue de dépenser chez Meta »), donc ce cas est NORMAL, pas une anomalie.
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
   * LES CAMPAGNES À RELIRE pour cet espace, les moins fraîches d'abord.
   *
   * 🔴 LE `where` DOIT RESTER DANS LE CONTRAT DE `publicites_a_suivre_idx`, qui est un index PARTIEL sur
   * `etat = 'publiee'`. L'élargir (pour suivre aussi les `prete`, par exemple) ne produirait AUCUNE erreur :
   * juste un balayage complet de la table à chaque passage, toutes les quinze minutes, pour toujours. Un
   * index partiel est un contrat avec une requête précise (leçon de 0122 et 0143).
   *
   * ⚠️ `nulls first` N'A AUCUN EFFET OBSERVABLE AUJOURD'HUI, et il faut le dire : cette requête n'a pas de
   * plafond, donc le balayage traite TOUTES les campagnes du passage, et rien n'attend derrière rien. Le
   * commentaire précédent affirmait le contraire (« une campagne neuve pourrait attendre derrière toutes
   * les anciennes »), ce qui était une raison inscrite dans le code que le prochain lecteur aurait crue.
   * L'ordre reste, pour le jour où un plafond arrivera : la lecture par paquets de cinquante chez Meta y
   * invite, et c'est alors la publicité la moins fraîche qui devra passer d'abord.
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
   * Écrit ce que Meta a rendu.
   *
   * ⚠️ `coalesce($n, colonne)` PARTOUT SAUF `lu_le` : une lecture qui n'a rien rendu (statistiques pas
   * encore prêtes) ne doit pas EFFACER la dépense d'hier. `lu_le`, lui, avance toujours, parce qu'il dit
   * « on a demandé », pas « on a obtenu ».
   */
  async noterSuivi(tenantId: string, campagneId: string, v: {
    statutMeta: string | null; motifRefus: string | null; debut: string | null; fin: string | null;
    /**
     * Le budget total, TEL QUE META LE RENVOIE.
     *
     * 🔴 IL ÉTAIT DEMANDÉ À META ET JETÉ, relevé par une relecture à froid. La spec annonce « budget total,
     * début, fin, tels que Meta les renvoie au suivi », et l'écran affiche « dépense sur budget » : un
     * budget modifié dans le Gestionnaire ne serait jamais rattrapé, donc le rapport affiché deviendrait
     * faux sans que rien ne le signale.
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
   * CE QUE NOS TABLES COMPTENT POUR UNE CAMPAGNE : prospects, qualifiés, non pris en charge.
   *
   * 🔴 DES CONTACTS DISTINCTS, PAS DES ARRIVÉES. Un prospect qui reclique sur la même publicité produit
   * deux arrivées et reste UNE personne : compter les lignes gonflerait l'entonnoir et ferait baisser le
   * coût par prospect affiché, c'est-à-dire exactement le chiffre sur lequel le client décide de remettre
   * du budget.
   *
   * 🔴 LES ISSUES « NON PRISES EN CHARGE » VOYAGENT EN PARAMÈTRE, elles ne sont PAS recopiées dans le SQL.
   * La liste vit dans `src/pubs/entonnoir.ts` ; l'écrire ici en ferait une seconde vérité, et le jour où une
   * NEUVIÈME issue apparaît, l'une des deux serait fausse sans que rien ne le dise.
   *
   * ⚠️ Le `where` reste dans le contrat de l'index partiel `arrivees_pub_campagne_idx`
   * (`campagne_id is not null`) : comparer `campagne_id = $2` implique non nul, donc la requête ne sort
   * jamais du domaine de son index.
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
   * CE SCÉNARIO EST-IL UTILISÉ PAR UNE PUBLICITÉ VIVANTE ? Sert le refus 409 de la suppression d'un scénario.
   *
   * ⚠️ « VIVANTE » EXCLUT `echec_creation`, et seulement elle : une création ratée ne diffuse rien et ne
   * recevra jamais de lead, donc elle ne doit pas retenir un scénario que le client veut supprimer. Une pub
   * `prete` (créée, en pause chez Meta), elle, le retient : elle sera publiée, et son scénario doit exister.
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
