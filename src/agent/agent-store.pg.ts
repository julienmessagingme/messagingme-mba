import type { Pool } from 'pg';
import type { AgentComplet, AgentResume, AgentStore, FicheAgent, PatchAgent, SortieAgent, StatutAgent } from './agent-store';
import { estFrequenceMention } from './agent-store';
import { FicheAgentPerimee, LabelAgentDejaPris } from './agent-store';
import { asArray, asRecord } from '../webhooks/json';
import { CODE_SORTIE_RE, ficheAgentSchema, ficheVide } from './fiche';
import { consommateurAgent } from './consommateur';
import { verrouillerDefinitions } from './catalog.pg';

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
      // 🔴 LA FRÉQUENCE VIENT DE L'ESPACE, PLUS DE L'AGENT (migration 0140). L'AI Act fait peser
      // l'obligation d'information sur la marque DÉPLOYANTE : un espace porte UNE politique, pas une par
      // robot. La jointure évite une seconde requête sur le chemin CHAUD d'un tour d'agent.
      // ⚠️ `agents.mention_ia_frequence` existe encore et n'est plus lue : elle part en 0141, APRÈS que ce
      // code ait été vu en production. La retirer avant casserait la prod pendant le déploiement.
      `select a.id, a.tenant_id, a.mention_ia, s.mention_ia_frequence, a.modele, a.max_tours, a.max_appels_outils,
              a.budget_micro_eur, a.inactivite_minutes, a.contact_inconnu, a.status
         from agents a
         left join tenant_settings s on s.tenant_id = a.tenant_id
        where a.tenant_id = $1 and a.id = $2`,
      [tenantId, id],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      mentionIa: r.mention_ia,
      // ⚠️ Repli sur `session` quand l'espace n'a rien réglé : c'est EXACTEMENT le défaut de 0126, et donc
      // le comportement d'avant pour tout espace que la reprise de 0140 n'a pas touché (un espace sans
      // agent). Une base en retard se comporte de même.
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

  /**
   * Les agents de l'espace et la PHRASE que chacun annonce : l'écran Sécurité > IA (migration 0140).
   *
   * ⚠️ HORS du contrat `AgentStore`, comme `listActifsConsommateur` sur le catalogue : c'est une projection
   * d'écran, et l'exiger du contrat obligerait chaque faux de test à écrire une méthode que le runtime
   * n'appelle jamais.
   *
   * ⚠️ TOUS les statuts, brouillons compris : un agent en brouillon ne parle à personne, mais le voir dans
   * la liste évite de croire qu'il a disparu, et c'est celui qu'on relit AVANT de l'activer.
   */
  async listerPourConformite(tenantId: string): Promise<Array<{ id: string; label: string; status: StatutAgent; mentionIa: string }>> {
    const res = await this.pool.query<{ id: string; label: string; status: StatutAgent; mention_ia: string }>(
      `select id, label, status, mention_ia from agents where tenant_id = $1 order by lower(label)`,
      [tenantId],
    );
    return res.rows.map((r) => ({ id: r.id, label: r.label, status: r.status, mentionIa: r.mention_ia }));
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
   * 🔴 CE QUI PART AVEC LUI, ET CE QUI RESTE. Ses ACTIONS (`agent_id` renseigné, 0157) partent par la cascade.
   * Un connecteur HTTP dont il était le SEUL utilisateur part aussi (décision du 2026-09-21, même règle que
   * `PgToolCatalog.detacher`). Un connecteur qu'un autre agent ou l'agent de Meta utilise encore RESTE, et
   * un outil MCP reste toujours : il doit rester branchable.
   *
   * ⚠️ SON CONSENTEMENT, AUCUNE CASCADE NE LE RETIRE, parce que `consommateur` est un TEXTE
   * (`agent:<uuid>`), choisi pour que le Meta Business Agent puisse être un consommateur sans avoir de fiche
   * d'agent. C'est le prix de ce choix, il se paie ICI, en code, et un test d'intégration le tient.
   *
   * 🔴 L'ORDRE COMPTE, ET IL A ÉTÉ FAUX UNE FOIS (revue finale du 2026-09-21). Le verrou des définitions
   * (`verrouillerDefinitions`) se pose APRÈS la cascade de l'agent et APRÈS le retrait de ses consentements,
   * juste avant l'effacement des orphelins. Posé en tête, il (1) couvrait une liste lue avant lui, donc
   * ratait un consentement posé entre les deux, (2) tenait les connecteurs PARTAGÉS pendant toute la cascade,
   * bloquant chaque appel d'outil que d'autres agents journalisaient, et (3) pouvait interbloquer avec un
   * appel de CET agent en cours de journalisation (qui tient sa session et attend l'outil, quand la cascade
   * attend la session). La seule exigence de correction est que le verrou précède le `not exists`.
   */
  async remove(tenantId: string, id: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const res = await client.query('delete from agents where tenant_id = $1 and id = $2', [tenantId, id]);
      const detaches = await client.query<{ tool_id: string }>(
        'delete from agent_tool_consommateurs where tenant_id = $1 and consommateur = $2 returning tool_id',
        [tenantId, consommateurAgent(id)],
      );
      // 🔴 UN CONNECTEUR HTTP QUE PLUS PERSONNE N'UTILISE PART AVEC SON DERNIER AGENT (décision du 2026-09-21),
      // même règle que `PgToolCatalog.detacher` : sinon il gardait son nom pris et bloquait la suppression de
      // sa requête, sans aucun écran pour s'en défaire. Le verrou se pose ICI, voir le JSDoc.
      if (detaches.rows.length > 0) {
        await verrouillerDefinitions(client, tenantId, detaches.rows.map((r) => r.tool_id));
        await client.query(
          `delete from agent_tools t
            where t.tenant_id = $1 and t.id = any($2::uuid[]) and t.agent_id is null and t.origin = 'http'
              and not exists (select 1 from agent_tool_consommateurs c where c.tool_id = t.id and c.tenant_id = t.tenant_id)`,
          [tenantId, detaches.rows.map((r) => r.tool_id)],
        );
      }
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
         -- ⚠️ PLUS DE mention_ia_frequence ICI (migration 0140) : le regime d annonce est un reglage de
         -- l ESPACE. La colonne existe encore et n est plus ni lue ni ecrite ; elle part en 0141, APRES que
         -- ce code ait ete vu en production. Le parametre 14 disparait donc avec elle, sans renumeroter les
         -- treize autres : renumeroter aurait ete treize occasions de decaler une valeur d un cran.
         -- (Aucun backtick dans ce commentaire : il fermerait le gabarit JS, cf. invariant 23. Le retirer a
         -- casse le fichier a la premiere ecriture de ce lot, ce qui est la meilleure preuve qu il sert.)
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

const COLONNES_COMPLETES = `id, label, status, mention_ia, modele, max_tours, max_appels_outils,
                            budget_micro_eur, inactivite_minutes, contact_inconnu, fiche, fiche_version`;

interface LigneComplete {
  id: string;
  label: string;
  status: StatutAgent;
  mention_ia: string;
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
