import type { Pool } from 'pg';
import type { AgentComplet, AgentResume, AgentStore, FicheAgent, PatchAgent, SortieAgent, StatutAgent } from './agent-store';
import { estFrequenceMention } from './agent-store';
import { FicheAgentPerimee, LabelAgentDejaPris } from './agent-store';
import { asArray, asRecord } from '../webhooks/json';
import { CODE_SORTIE_RE, ficheAgentSchema, ficheVide } from './fiche';
import { consommateurAgent } from './consommateur';

interface Ligne {
  id: string;
  tenant_id: string;
  mention_ia: string;
  mention_ia_frequence?: string | null;
  modele: string;
  max_tours: number;
  max_appels_outils: number;
  budget_micro_eur: string;
  inactivite_minutes: number;
  contact_inconnu: AgentComplet['contactInconnu'];
  status: 'draft' | 'active' | 'disabled';
}

/** Lecture des fiches d'agent (migration 0086). `tenant_id = $1` sur chaque requête : c'est le seul contrôle
 *  d'isolation, et `node.data.agentId` vient du client, donc il peut pointer l'agent d'un autre tenant. */
export class PgAgentStore implements AgentStore {
  constructor(private readonly pool: Pool) {}

  async byId(tenantId: string, id: string): Promise<FicheAgent | null> {
    const res = await this.pool.query<Ligne>(
      `select id, tenant_id, mention_ia, mention_ia_frequence, modele, max_tours, max_appels_outils,
              budget_micro_eur, inactivite_minutes, contact_inconnu, status
         from agents where tenant_id = $1 and id = $2`,
      [tenantId, id],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      mentionIa: r.mention_ia,
      // ⚠️ Repli sur `session` si la colonne manque : c'est EXACTEMENT le comportement d'avant la migration
      // 0126 (la consigne visait deja le premier message), donc une base en retard ne change rien.
      mentionIaFrequence: estFrequenceMention(r.mention_ia_frequence) ? r.mention_ia_frequence : 'session',
      modele: r.modele,
      plafonds: {
        maxTours: r.max_tours,
        maxAppelsOutils: r.max_appels_outils,
        // `bigint` rendu en `string` par node-pg, converti ici comme partout ailleurs dans le repo.
        budgetMicroEur: Number(r.budget_micro_eur ?? 0),
      },
      inactiviteMinutes: r.inactivite_minutes,
      contactInconnu: r.contact_inconnu,
      status: r.status,
    };
  }

  async listActifs(tenantId: string): Promise<AgentResume[]> {
    return this.resumes(tenantId, `and status = 'active'`);
  }

  async listToutes(tenantId: string): Promise<AgentResume[]> {
    return this.resumes(tenantId, '');
  }

  /** Corps commun des deux listes : une seule projection, pour que le builder et l'écran de réglage ne
   *  finissent pas par voir deux agents différents sous le même nom. Le filtre est un fragment LITTÉRAL de
   *  ce fichier, jamais une valeur d'appelant : il n'y a rien à interpoler depuis l'extérieur. */
  private async resumes(tenantId: string, filtreStatut: string): Promise<AgentResume[]> {
    const res = await this.pool.query<{ id: string; label: string; status: StatutAgent; fiche: unknown }>(
      `select id, label, status, fiche from agents
        where tenant_id = $1 ${filtreStatut}
        order by lower(label)`,
      [tenantId],
    );
    return res.rows.map((r) => ({ id: r.id, label: r.label, status: r.status, sorties: sortiesDeLaFiche(r.fiche) }));
  }

  async complet(tenantId: string, id: string): Promise<AgentComplet | null> {
    const res = await this.pool.query<LigneComplete>(
      `select ${COLONNES_COMPLETES} from agents where tenant_id = $1 and id = $2`,
      [tenantId, id],
    );
    const r = res.rows[0];
    return r ? versComplet(r) : null;
  }

  async create(tenantId: string, label: string, mentionIa: string, modele: string): Promise<AgentComplet> {
    // `status` n'est PAS passé : la valeur par défaut de la colonne est `draft`, et c'est délibéré. Un agent
    // créé actif serait proposable dans un scénario avant que quiconque ait relu ce qu'il dira.
    const res = await this.pool.query<LigneComplete>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, $2, $3, $4)
       returning ${COLONNES_COMPLETES}`,
      [tenantId, label, mentionIa, modele],
    ).catch(surLabelDejaPris);
    return versComplet(res.rows[0]!);
  }

  /**
   * Supprime un agent, et le CONSENTEMENT qu'il portait sur les outils de l'espace.
   *
   * Ses sessions, appels et fiches de connaissance partent avec lui (`on delete cascade`, migration 0086).
   * Un bloc de scénario qui le désignait encore devient un passe-plat, et le moteur ne suit alors qu'une
   * arête LIBRE : il ne vole aucune branche typée.
   *
   * 🔴 LES OUTILS, EUX, NE PARTENT PLUS AVEC LUI, ET C'EST TOUT L'OBJET DE CETTE MÉTHODE DEPUIS 0127. Une
   * DÉFINITION appartient à l'ESPACE : la supprimer avec l'agent casserait les autres agents qui s'en
   * servent. Ce qui doit partir, c'est sa ligne de `agent_tool_consommateurs`.
   *
   * ⚠️ ET AUCUNE CASCADE NE LE FAIT, parce que `consommateur` est un TEXTE (`agent:<uuid>`), choisi pour que
   * le Meta Business Agent puisse être un consommateur sans avoir de fiche d'agent. C'est le prix de ce
   * choix, il se paie ICI, en code, et un test d'intégration le tient. Sans lui, la ligne resterait en base,
   * invisible, et fausserait les compteurs « utilisé par N consommateurs » de la bibliothèque.
   *
   * ⚠️ UNE TRANSACTION, parce que l'ATOMICITÉ compte même si l'ordre est indifférent (rien ne lit entre les
   * deux) : la première écriture seule laisserait un orphelin que plus rien ne rattrapera jamais.
   */
  async remove(tenantId: string, id: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const res = await client.query('delete from agents where tenant_id = $1 and id = $2', [tenantId, id]);
      await client.query(
        'delete from agent_tool_consommateurs where tenant_id = $1 and consommateur = $2',
        [tenantId, consommateurAgent(id)],
      );
      await client.query('commit');
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async patch(tenantId: string, id: string, patch: PatchAgent): Promise<AgentComplet | null> {
    // `coalesce($n, colonne)` sur chaque COLONNE, et `||` sur le jsonb : dans les deux cas, un patch partiel
    // n'écrit que ce qu'il mentionne. Le `||` de Postgres FUSIONNE deux objets jsonb au premier niveau, donc
    // enregistrer l'objectif depuis un onglet ne touche pas aux règles d'arrêt qu'un autre vient d'ajouter.
    const res = await this.pool.query<LigneComplete>(
      `update agents set
         label = coalesce($3, label),
         status = coalesce($4, status),
         mention_ia = coalesce($5, mention_ia),
         -- ⚠️ Le parametre 14 et non un numero intercale : renumeroter les treize existants pour inserer
         -- celui-ci aurait ete treize occasions de decaler une valeur d un cran, en silence.
         -- (Aucun backtick dans ce commentaire : il fermerait le gabarit JS, cf. invariant 23.)
         mention_ia_frequence = coalesce($14, mention_ia_frequence),
         modele = coalesce($6, modele),
         max_tours = coalesce($7, max_tours),
         max_appels_outils = coalesce($8, max_appels_outils),
         budget_micro_eur = coalesce($9, budget_micro_eur),
         inactivite_minutes = coalesce($10, inactivite_minutes),
         contact_inconnu = coalesce($11, contact_inconnu),
         fiche = case when $12::jsonb is null then fiche else fiche || $12::jsonb end,
         fiche_version = fiche_version + (case when $12::jsonb is null then 0 else 1 end),
         updated_at = now()
       where tenant_id = $1 and id = $2
         -- Verrou optimiste, seulement quand l'appelant en fournit un. Zéro ligne touchée = la fiche a bougé
         -- sous ses pieds, et on préfère un refus lisible à un écrasement silencieux.
         and ($13::int is null or fiche_version = $13)
       returning ${COLONNES_COMPLETES}`,
      [
        tenantId, id,
        patch.label ?? null, patch.status ?? null, patch.mentionIa ?? null, patch.modele ?? null,
        patch.maxTours ?? null, patch.maxAppelsOutils ?? null, patch.budgetMicroEur ?? null,
        patch.inactiviteMinutes ?? null, patch.contactInconnu ?? null,
        patch.contenu ? JSON.stringify(patch.contenu) : null,
        patch.ficheVersionAttendue ?? null,
        patch.mentionIaFrequence ?? null,
      ],
    ).catch(surLabelDejaPris);
    const r = res.rows[0];
    if (r) return versComplet(r);
    // Zéro ligne : soit l'agent n'existe pas (ou est à un autre tenant), soit le verrou a mordu. On distingue
    // les deux, sinon « la fiche a changé » et « cet agent n'existe pas » se ressembleraient à l'écran.
    if (patch.ficheVersionAttendue !== undefined && (await this.complet(tenantId, id)) !== null) {
      throw new FicheAgentPerimee();
    }
    return null;
  }
}

/** L'index unique `(tenant_id, lower(label))` de la migration 0086, traduit en erreur métier. Sans ça, créer
 *  deux agents du même nom remontait en 500, dont Cloudflare remplace le corps : le client ne voyait rien. */
function surLabelDejaPris(err: unknown): never {
  if ((err as { code?: string } | null)?.code === '23505') throw new LabelAgentDejaPris();
  throw err;
}

const COLONNES_COMPLETES = `id, label, status, mention_ia, mention_ia_frequence, modele, max_tours, max_appels_outils,
                            budget_micro_eur, inactivite_minutes, contact_inconnu, fiche, fiche_version`;

interface LigneComplete {
  id: string;
  label: string;
  status: StatutAgent;
  mention_ia: string;
  mention_ia_frequence?: string | null;
  modele: string;
  max_tours: number;
  max_appels_outils: number;
  budget_micro_eur: string;
  inactivite_minutes: number;
  contact_inconnu: AgentComplet['contactInconnu'];
  fiche: unknown;
  fiche_version: number;
}

function versComplet(r: LigneComplete): AgentComplet {
  // La fiche est du jsonb : une ligne écrite par une version antérieure, ou par une IA de construction dont
  // le schéma a bougé, ne doit pas rendre l'écran inéditable. `safeParse` avec repli sur une fiche vide.
  const parse = ficheAgentSchema.safeParse(r.fiche ?? {});
  return {
    id: r.id,
    label: r.label,
    status: r.status,
    mentionIa: r.mention_ia,
      mentionIaFrequence: estFrequenceMention(r.mention_ia_frequence) ? r.mention_ia_frequence : 'session',
    modele: r.modele,
    maxTours: r.max_tours,
    maxAppelsOutils: r.max_appels_outils,
    // `bigint` rendu en `string` par node-pg, converti ici comme partout ailleurs dans le repo.
    budgetMicroEur: Number(r.budget_micro_eur ?? 0),
    inactiviteMinutes: r.inactivite_minutes,
    contactInconnu: r.contact_inconnu,
    contenu: parse.success ? parse.data : ficheVide(),
    ficheVersion: r.fiche_version,
  };
}

/**
 * Les règles d'arrêt d'une fiche, lues DÉFENSIVEMENT : `fiche` est du jsonb écrit par l'IA de construction,
 * donc opaque. Une entrée inutilisable est écartée plutôt que de faire tomber le builder, qui serait alors
 * inutilisable pour tout le scénario à cause d'une seule ligne mal formée.
 *
 * Le code est contraint par `CODE_SORTIE_RE`, la MÊME règle que celle qui valide une fiche à l'écriture
 * (`src/agent/fiche.ts`) : deux définitions finiraient par accepter des choses différentes, et la lecture
 * écarterait alors des sorties que l'écriture a laissé passer.
 */
export function sortiesDeLaFiche(fiche: unknown): SortieAgent[] {
  const out: SortieAgent[] = [];
  const vus = new Set<string>();
  for (const brut of asArray(asRecord(fiche).sorties)) {
    const o = asRecord(brut);
    const code = typeof o.code === 'string' ? o.code.trim().toLowerCase() : '';
    if (!CODE_SORTIE_RE.test(code) || vus.has(code)) continue;
    vus.add(code);
    out.push({ code, label: typeof o.label === 'string' && o.label.trim() !== '' ? o.label.trim() : code });
  }
  return out;
}
