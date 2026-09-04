import type { Pool } from 'pg';

/**
 * Une ligne de `channelsme_links`, telle que les routes et la console la lisent.
 *
 * 🔴 Pas de champ `enabled`, et ce n est pas un oubli : l etat allume ou eteint du lien EST le `enabled` de
 * son automation compagnon, seule source de verite. Poser un second drapeau ici creerait deux copies du
 * meme etat, qui divergeraient au premier chemin qui n ecrirait qu une des deux.
 */
export interface LienRow {
  id: string;
  tenantId: string;
  workflowId: string;
  startNodeId: string | null;
  token: string;
  phrase: string;
  automationId: string | null;
  /** Plafond horaire PROPRE a ce lien. null veut dire « plafond global de l instance », pas « zero ». */
  maxParHeure: number | null;
  createdAt: string;
}

/** ⚠️ Liste tenue A LA MAIN : ajouter une colonne oblige a toucher aussi `LienRowBrut` et `versLien`. */
const COLS = 'id, tenant_id, workflow_id, start_node_id, token, phrase, automation_id, max_par_heure, created_at';

/** Forme brute d une ligne `channelsme_links` (colonnes de COLS) telle que Postgres la rend. */
interface LienRowBrut {
  id: string;
  tenant_id: string;
  workflow_id: string;
  start_node_id: string | null;
  token: string;
  phrase: string;
  automation_id: string | null;
  max_par_heure: number | null;
  created_at: Date;
}

function versLien(r: LienRowBrut): LienRow {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    workflowId: r.workflow_id,
    startNodeId: r.start_node_id,
    token: r.token,
    phrase: r.phrase,
    automationId: r.automation_id,
    maxParHeure: r.max_par_heure,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * Les liens de chaine d un tenant : un jeton, une phrase, un scenario, et l automation compagnon qui les
 * relie.
 *
 * Ce store ne sait ni allumer ni eteindre un lien : cet etat vit sur l automation, pas ici. Il ne sait pas
 * non plus repointer un lien vers un autre scenario, ce qui est une decision produit et pas une lacune (un
 * autre scenario veut un autre lien, donc un autre jeton, donc une autre mesure de conversion).
 */
export class PgChannelsMeLinkStore {
  constructor(private readonly pool: Pool) {}

  /**
   * ⚠️ `automationId` est fourni A LA CREATION, il ne se pose pas apres coup : l automation compagnon se cree
   * AVANT le lien (elle ne reference pas le lien, elle porte juste sa marque de possession), donc son id est
   * deja connu quand on arrive ici.
   */
  async create(
    tenantId: string,
    l: {
      workflowId: string;
      startNodeId: string | null;
      token: string;
      phrase: string;
      automationId: string | null;
      maxParHeure: number | null;
    },
  ): Promise<LienRow> {
    const { rows } = await this.pool.query<LienRowBrut>(
      `insert into channelsme_links
         (tenant_id, workflow_id, start_node_id, token, phrase, automation_id, max_par_heure)
       values ($1,$2,$3,$4,$5,$6,$7) returning ${COLS}`,
      [tenantId, l.workflowId, l.startNodeId, l.token, l.phrase, l.automationId, l.maxParHeure],
    );
    return versLien(rows[0]!);
  }

  /** 🔴 `order by created_at desc` : c est l ordre de l index channelsme_links_tenant_idx (tenant_id, created_at desc). */
  async list(tenantId: string): Promise<LienRow[]> {
    const { rows } = await this.pool.query<LienRowBrut>(
      `select ${COLS} from channelsme_links where tenant_id=$1 order by created_at desc`,
      [tenantId],
    );
    return rows.map(versLien);
  }

  async byId(tenantId: string, id: string): Promise<LienRow | null> {
    const { rows } = await this.pool.query<LienRowBrut>(
      `select ${COLS} from channelsme_links where tenant_id=$1 and id=$2`,
      [tenantId, id],
    );
    return rows[0] ? versLien(rows[0]) : null;
  }

  /**
   * Allume l automation compagnon de ce lien : chemin appele a la publication d un post (une chaine qui
   * publie doit se mettre a repondre a son jeton).
   *
   * 🔴 CE STORE ECRIT SA PROPRE REQUETE sur `automations`, il ne passe PAS par `PgAutomationStore`. Cette
   * classe exclut de `update`/`remove` toute ligne dont `possede_par` n est pas nul (meme patron que
   * `HORS_WEBHOOK` pour les webhooks entrants) : une automation possedee par un lien de chaine lui est donc
   * devenue INACCESSIBLE en ecriture depuis ce store-la, y compris pour l allumer. Le proprietaire ecrit ses
   * propres requetes, comme `PgWebhookStore.syncAutomation` le fait deja pour les siennes.
   *
   * La clause `possede_par = 'channelsme_link'` est une GARDE MIROIR : elle interdit a ce store de toucher
   * une automation qui ne lui appartient pas, exactement comme le predicat de `PgAutomationStore` interdit a
   * l ecran Automation de toucher les siennes. C est ce qui rend la frontiere etanche dans les deux sens, pas
   * seulement le fait que `PgAutomationStore` regarde ailleurs.
   */
  async allumerAutomation(tenantId: string, linkId: string): Promise<void> {
    await this.definirEtatAutomation(tenantId, linkId, true);
  }

  /** Eteint l automation compagnon. Meme garde que `allumerAutomation`, voir sa note. */
  async eteindreAutomation(tenantId: string, linkId: string): Promise<void> {
    await this.definirEtatAutomation(tenantId, linkId, false);
  }

  /**
   * Partagee par `allumerAutomation` et `eteindreAutomation` : la sous-requete resout l automation compagnon
   * du lien, scopee tenant, et la mise a jour porte ELLE-MEME `tenant_id` ET `possede_par` en garde. Si le
   * lien n existe pas pour ce tenant, ou si son automation compagnon n est pas possedee par channelsme_link
   * (jamais cense arriver, mais pas suppose), la requete touche zero ligne, silencieusement : appeler cette
   * methode n est jamais une raison d echouer la publication qui l a declenchee.
   */
  private async definirEtatAutomation(tenantId: string, linkId: string, enabled: boolean): Promise<void> {
    await this.pool.query(
      `update automations
          set enabled = $3, updated_at = now()
        where tenant_id = $1
          and possede_par = 'channelsme_link'
          and id = (select automation_id from channelsme_links where tenant_id = $1 and id = $2)`,
      [tenantId, linkId, enabled],
    );
  }
}
