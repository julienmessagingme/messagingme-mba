import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';
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

/** Lecture des fiches d'agent. 🔴 `tenant_id = $1` sur chaque requête : c'est le seul contrôle d'isolation, et
 *  `node.data.agentId` vient du client, donc il peut pointer l'agent d'un autre tenant. */
export class PgAgentStore implements AgentStore {
  constructor(private readonly pool: Pool) {}

  async byId(tenantId: string, id: string): Promise<FicheAgent | null> {
    const res = await this.pool.query<Ligne>(
      // La fréquence d'annonce d'IA vient de l'espace, pas de l'agent (l'obligation pèse sur la marque
      // déployante) : la jointure évite une seconde requête sur le chemin chaud d'un tour.
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
      // Repli sur `session` quand l'espace n'a rien réglé (ou qu'une base est en retard).
      mentionIaFrequence: estFrequenceMention(r.mention_ia_frequence) ? r.mention_ia_frequence : 'session',
      modele: r.modele,
      plafonds: {
        maxTours: r.max_tours,
        maxAppelsOutils: r.max_appels_outils,
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

  /** Corps commun des deux listes : une seule projection pour le builder et l'écran de réglage. Le filtre est
   *  un fragment littéral de ce fichier, jamais une valeur d'appelant : rien n'est interpolé de l'extérieur. */
  private async resumes(tenantId: string, filtreStatut: string): Promise<AgentResume[]> {
    const res = await this.pool.query<{ id: string; label: string; status: StatutAgent; fiche: unknown; modele: string }>(
      `select id, label, status, fiche, modele from agents
        where tenant_id = $1 ${filtreStatut}
        order by lower(label)`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      id: r.id, label: r.label, status: r.status, sorties: sortiesDeLaFiche(r.fiche), modele: r.modele,
    }));
  }

  /**
   * Les agents de l'espace et la phrase que chacun annonce, pour l'écran Sécurité > IA. Hors du contrat
   * `AgentStore` : une projection d'écran, que les faux de test n'ont pas à écrire. Tous les statuts,
   * brouillons compris : c'est celui qu'on relit avant de l'activer.
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
    // `status` n'est pas passé : le défaut de la colonne est `draft`. Un agent créé actif serait proposable
    // dans un scénario avant que quiconque ait relu ce qu'il dira.
    const res = await this.pool.query<LigneComplete>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, $2, $3, $4)
       returning ${COLONNES_COMPLETES}`,
      [tenantId, label, mentionIa, modele],
    ).catch(surLabelDejaPris);
    return versComplet(res.rows[0]!);
  }

  /**
   * Supprime un agent, et le consentement qu'il portait sur les outils de l'espace.
   *
   * Ses sessions, appels, fiches de connaissance et actions (`agent_id` renseigné) partent par cascade. Un
   * bloc qui le désignait devient un passe-plat. Un connecteur HTTP dont il était le seul utilisateur part
   * aussi (même règle que `PgToolCatalog.detacher`) ; un connecteur encore utilisé et un outil MCP restent.
   * Son consentement, aucune cascade ne le retire (`consommateur` est un texte, `agent:<uuid>`) : c'est fait
   * ici, en code.
   *
   * L'ordre des verrous est celui de tous les chemins des consentements et du journal : l'agent, ses
   * sessions, les définitions (triées par identifiant), puis ce qui en dépend. Le journal d'un appel prend la
   * session avant l'outil (ordre des déclencheurs de ses deux clés étrangères, figé par un test
   * d'intégration). Tout autre ordre interbloque (40P01, un 500) : définitions avant sessions contre un appel
   * en cours de journalisation, retrait des consentements ou cascade avant le verrou contre un `detacher`.
   * Pendant la cascade, les appels d'autres agents et du relais Meta sur les connecteurs partagés attendent.
   * Un nouveau chemin qui écrit plusieurs définitions passe par `verrouillerDefinitions`.
   */
  async remove(tenantId: string, id: string): Promise<boolean> {
    return enTransaction(this.pool, async (client) => {
      // L'ordre de ces instructions est l'objet du JSDoc : le changer rouvre un interblocage.
      await client.query('select 1 from agents where tenant_id = $1 and id = $2 for update', [tenantId, id]);
      await client.query(
        'select 1 from agent_sessions where tenant_id = $1 and agent_id = $2 order by id for update',
        [tenantId, id],
      );
      const lies = await client.query<{ tool_id: string }>(
        'select tool_id from agent_tool_consommateurs where tenant_id = $1 and consommateur = $2',
        [tenantId, consommateurAgent(id)],
      );
      const verrouilles = new Set(lies.rows.map((r) => r.tool_id));
      await verrouillerDefinitions(client, tenantId, [...verrouilles]);
      const res = await client.query('delete from agents where tenant_id = $1 and id = $2', [tenantId, id]);
      const detaches = await client.query<{ tool_id: string }>(
        'delete from agent_tool_consommateurs where tenant_id = $1 and consommateur = $2 returning tool_id',
        [tenantId, consommateurAgent(id)],
      );
      // Un connecteur HTTP que plus personne n'utilise part avec son dernier agent : sinon il garderait son nom
      // pris et bloquerait la suppression de sa requête, sans écran pour s'en défaire.
      if (detaches.rows.length > 0) {
        await verrouillerDefinitions(client, tenantId, detaches.rows.map((r) => r.tool_id).filter((t) => !verrouilles.has(t)));
        await client.query(
          `delete from agent_tools t
            where t.tenant_id = $1 and t.id = any($2::uuid[]) and t.agent_id is null and t.origin = 'http'
              and not exists (select 1 from agent_tool_consommateurs c where c.tool_id = t.id and c.tenant_id = t.tenant_id)`,
          [tenantId, detaches.rows.map((r) => r.tool_id)],
        );
      }
      return (res.rowCount ?? 0) > 0;
    });
  }

  async patch(tenantId: string, id: string, patch: PatchAgent): Promise<AgentComplet | null> {
    // `coalesce($n, colonne)` sur chaque colonne, et `||` sur le jsonb (fusion au premier niveau) : un patch
    // partiel n'écrit que ce qu'il mentionne.
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
    // Zéro ligne : agent absent (ou d'un autre tenant), ou verrou qui a mordu. On distingue les deux pour
    // l'écran.
    if (patch.ficheVersionAttendue !== undefined && (await this.complet(tenantId, id)) !== null) {
      throw new FicheAgentPerimee();
    }
    return null;
  }
}

/** L'index unique `(tenant_id, lower(label))` traduit en erreur métier : sinon un nom en double remonterait
 *  en 500. */
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
  // Fiche jsonb : une ligne ancienne ou mal formée ne doit pas rendre l'écran inéditable. `safeParse` avec
  // repli sur une fiche vide.
  const parse = ficheAgentSchema.safeParse(r.fiche ?? {});
  return {
    id: r.id,
    label: r.label,
    status: r.status,
    mentionIa: r.mention_ia,
    modele: r.modele,
    maxTours: r.max_tours,
    maxAppelsOutils: r.max_appels_outils,
    budgetMicroEur: Number(r.budget_micro_eur ?? 0),
    inactiviteMinutes: r.inactivite_minutes,
    contactInconnu: r.contact_inconnu,
    contenu: parse.success ? parse.data : ficheVide(),
    ficheVersion: r.fiche_version,
  };
}

/**
 * Les règles d'arrêt d'une fiche, lues défensivement (jsonb écrit par l'IA de construction) : une entrée
 * inutilisable est écartée plutôt que de faire tomber le builder. Le code passe par `CODE_SORTIE_RE`, la
 * même règle qu'à l'écriture (`src/agent/fiche.ts`).
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
