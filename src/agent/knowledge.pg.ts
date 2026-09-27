import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';
import {
  CONFIG_RECHERCHE, PROXIMITE_TITRE_MIN, termesDeRecherche,
  type FicheAEcrire, type FicheConnaissance, type FicheTrouvee, type KnowledgeStore,
  type SourceFiche,
} from './knowledge';

interface Ligne {
  id: string;
  titre: string;
  corps: string;
  source_url: string | null;
  termes_trouves: number;
  termes_utiles: number;
  proximite_titre: number;
}

/**
 * Recherche dans `agent_knowledge` : plein texte natif plus trigramme.
 *
 * La requête ne classe pas, elle mesure combien de termes signifiants de la question se retrouvent dans la
 * fiche, et sur combien : un rang (`ts_rank_cd`) a des planchers arithmétiques qui rendaient tout seuil
 * inerte. Le verdict est rendu en code (`ficheEstPertinente`). Un terme sans lexème (« de », « le ») sort du
 * compte et du dénominateur (`numnode(...) > 0`). Deux paramètres portent les mêmes termes : le `@@` du
 * `where` prend la requête OU-ée, la forme que l'index GIN sert ; la couverture prend le tableau.
 */
export class PgKnowledgeStore implements KnowledgeStore {
  constructor(private readonly pool: Pool) {}

  async chercher(tenantId: string, agentId: string, requete: string, limite: number): Promise<FicheTrouvee[]> {
    const termes = termesDeRecherche(requete);
    // Aucun terme exploitable : aucune requête (`to_tsquery` sur une chaîne vide lèverait).
    if (termes.length === 0) return [];
    const res = await this.pool.query<Ligne>(
      `with utiles as (
         select distinct plainto_tsquery('${CONFIG_RECHERCHE}'::regconfig, t) as tq
           from unnest($3::text[]) as t
          where numnode(plainto_tsquery('${CONFIG_RECHERCHE}'::regconfig, t)) > 0
       )
       select k.id, k.titre, k.corps, k.source_url,
              (select count(*) from utiles u where k.corps_tsv @@ u.tq)::int as termes_trouves,
              (select count(*) from utiles)::int as termes_utiles,
              similarity(k.titre, $4) as proximite_titre
         from agent_knowledge k
        where k.tenant_id = $1 and k.agent_id = $2
          and (k.corps_tsv @@ to_tsquery('${CONFIG_RECHERCHE}'::regconfig, $5)
               -- L operateur % d abord, parce que LUI seul utilise l index trigramme sur le titre
               -- (agent_knowledge_titre_trgm_idx) ; la comparaison explicite ensuite, pour que le seuil
               -- effectif vienne de NOTRE code et non du GUC pg_trgm.similarity_threshold, qui est un
               -- reglage serveur que le depot ne controle pas.
               or (k.titre % $4 and similarity(k.titre, $4) >= $6))
        order by termes_trouves desc, proximite_titre desc
        limit $7::int`,
      [tenantId, agentId, termes, requete, termes.join(' | '), PROXIMITE_TITRE_MIN, Math.max(1, Math.floor(limite))],
    );
    return res.rows.map((r) => ({
      id: r.id,
      titre: r.titre,
      corps: r.corps,
      sourceUrl: r.source_url,
      termesTrouves: r.termes_trouves,
      // Aucun terme signifiant : couverture à zéro, le repli qui ne laisse pas passer une fiche.
      couverture: r.termes_utiles > 0 ? r.termes_trouves / r.termes_utiles : 0,
      proximiteTitre: Number(r.proximite_titre ?? 0),
    }));
  }

  /**
   * Le rappel vectoriel : les fiches les plus proches du vecteur de la question. Elle ne juge rien : il y a
   * toujours une fiche « la moins loin », même sans réponse dans la base, et le verdict revient au reranker.
   * Une fiche pas encore vectorisée (`embedding is null`) reste trouvable par le plein texte.
   */
  async chercherParVecteur(tenantId: string, agentId: string, vecteur: number[], limite: number): Promise<FicheTrouvee[]> {
    if (vecteur.length === 0) return [];
    const res = await this.pool.query<{ id: string; titre: string; corps: string; source_url: string | null; similarite: string }>(
      `select id, titre, corps, source_url, (1 - (embedding <=> $3::vector))::text as similarite
         from agent_knowledge
        where tenant_id = $1 and agent_id = $2 and embedding is not null
        order by embedding <=> $3::vector
        limit $4::int`,
      [tenantId, agentId, `[${vecteur.join(',')}]`, Math.max(1, Math.floor(limite))],
    );
    return res.rows.map((r) => ({
      id: r.id,
      titre: r.titre,
      corps: r.corps,
      sourceUrl: r.source_url,
      // Aucune mesure lexicale : zéro est juste, cette fiche n'a pas été trouvée par les mots.
      termesTrouves: 0,
      couverture: 0,
      proximiteTitre: 0,
      similarite: Number(r.similarite),
    }));
  }

  /**
   * Les fiches sans vecteur, ou dont le vecteur vient d'un autre modèle : un changement de modèle se rattrape
   * au fil de l'eau, les anciens vecteurs servant jusque-là, au lieu de rendre toutes les bases sourdes.
   */
  async fichesAVectoriser(modele: string, limite: number): Promise<Array<{ id: string; titre: string; corps: string }>> {
    const res = await this.pool.query<{ id: string; titre: string; corps: string }>(
      `select id, titre, corps from agent_knowledge
        where embedding is null or embedding_modele is distinct from $1
        order by updated_at asc
        limit $2::int`,
      [modele, Math.max(1, Math.floor(limite))],
    );
    return res.rows;
  }

  /** Écrit les vecteurs calculés. Par identifiant, jamais par position : le lot a pu être réordonné. */
  async ecrireVecteurs(modele: string, vecteurs: Array<{ id: string; vecteur: number[] }>): Promise<number> {
    if (vecteurs.length === 0) return 0;
    const res = await this.pool.query(
      `update agent_knowledge k
          set embedding = v.vecteur::vector, embedding_modele = $1
         from (select unnest($2::uuid[]) as id, unnest($3::text[]) as vecteur) v
        where k.id = v.id`,
      [modele, vecteurs.map((v) => v.id), vecteurs.map((v) => `[${v.vecteur.join(',')}]`)],
    );
    return res.rowCount ?? 0;
  }

  // ---------- Écriture : l'écran de réglage ----------
  // Hors de `KnowledgeStore` : le tour d'agent ne lit que `chercher`, et ses doubles de test n'ont pas à
  // porter l'écriture.

  async lister(tenantId: string, agentId: string): Promise<FicheConnaissance[]> {
    const res = await this.pool.query<LigneFiche>(
      `select ${COLONNES_FICHE} from agent_knowledge
        where tenant_id = $1 and agent_id = $2
        order by lower(titre)`,
      [tenantId, agentId],
    );
    return res.rows.map(versFiche);
  }

  /** Écrit une fiche. Rend `null` si l'agent n'existe pas ou appartient à un autre tenant. */
  async creer(tenantId: string, agentId: string, fiche: FicheAEcrire): Promise<FicheConnaissance | null> {
    // 🔴 Le `where exists` est le contrôle d'appartenance, dans l'écriture même : zéro ligne = agent introuvable.
    const res = await this.pool.query<LigneFiche>(
      `insert into agent_knowledge (tenant_id, agent_id, titre, corps, source_url, derniere_lecture_at)
       select $1, $2, $3, $4, $5, case when $5::text is null then null else now() end
        where exists (select 1 from agents where id = $2 and tenant_id = $1)
       returning ${COLONNES_FICHE}`,
      [tenantId, agentId, fiche.titre, fiche.corps, fiche.sourceUrl ?? null],
    );
    const r = res.rows[0];
    return r ? versFiche(r) : null;
  }

  /**
   * Corrige une fiche. Rend `null` si elle n'existe pas ou n'est pas celle de ce couple (tenant, agent) :
   * sans l'agent dans le périmètre, un identifiant mal aiguillé corrigerait la fiche d'un autre agent.
   */
  async modifier(
    tenantId: string, agentId: string, ficheId: string, patch: { titre?: string; corps?: string },
  ): Promise<FicheConnaissance | null> {
    // `updated_at` marque le passage d'un humain, ce qui désarme l'alerte de fraîcheur. Le vecteur est effacé
    // quand le texte change : un vecteur de l'ancien texte ferait remonter la fiche sur des questions qu'elle
    // ne traite plus. Le balayage le recalcule, le plein texte trouve la fiche entre-temps.
    const res = await this.pool.query<LigneFiche>(
      `update agent_knowledge
          set titre = coalesce($4, titre), corps = coalesce($5, corps), updated_at = now(),
              embedding = null, embedding_modele = null
        where tenant_id = $1 and agent_id = $2 and id = $3
       returning ${COLONNES_FICHE}`,
      [tenantId, agentId, ficheId, patch.titre ?? null, patch.corps ?? null],
    );
    const r = res.rows[0];
    return r ? versFiche(r) : null;
  }

  /** Rend `false` si la fiche n'existe pas ou n'est pas celle de ce couple (tenant, agent). */
  async supprimer(tenantId: string, agentId: string, ficheId: string): Promise<boolean> {
    const res = await this.pool.query(
      'delete from agent_knowledge where tenant_id = $1 and agent_id = $2 and id = $3',
      [tenantId, agentId, ficheId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /**
   * Relit une source : retire les fiches de cette source pour cet agent, puis écrit les nouvelles.
   *
   * Remplacer et non ajouter : des doublons fausseraient une recherche qui compte les mots partagés (le client
   * est prévenu que ses corrections sur ces fiches partent). La clé est la source entière (type, URL, nom),
   * pas l'URL seule, pour qu'un document se réimporte comme une page se relit. Retrait et écriture en une
   * instruction (CTE modifiantes, même instantané) : la base ne passe jamais par un état sans source.
   */
  async remplacerSource(
    tenantId: string, agentId: string, source: SourceFiche, fiches: FicheAEcrire[],
  ): Promise<{ retirees: number; ecrites: number } | null> {
    // `manuel` n'a pas de clé : un `where` sur deux null retirerait toutes les fiches écrites à la main.
    if (source.type === 'manuel') return { retirees: 0, ecrites: 0 };
    const url = source.type === 'page' ? source.url : null;
    const nom = source.type === 'document' ? source.nom : null;
    /**
     * L'agent est verrouillé d'abord, dans une instruction à part : l'ordre de `PgAgentStore.remove` (l'agent,
     * puis ce qui en dépend). Sinon cette instruction prendrait l'agent en fin d'écriture, par la clé étrangère,
     * et interbloquerait avec une suppression d'agent (40P01).
     */
    return enTransaction(this.pool, async (client) => {
      const agent = await client.query('select 1 from agents where tenant_id = $1 and id = $2 for key share', [tenantId, agentId]);
      if ((agent.rowCount ?? 0) === 0) return null;
      const res = await client.query<{ retirees: number; ecrites: number }>(
        `with retirees as (
                delete from agent_knowledge
                 where tenant_id = $1 and agent_id = $2
                   and source_type = $3
                   and source_url is not distinct from $4
                   and source_nom is not distinct from $5
                returning 1
              ),
              ecrites as (
                insert into agent_knowledge
                       (tenant_id, agent_id, titre, corps, source_type, source_url, source_nom, derniere_lecture_at)
                select $1, $2, f.titre, f.corps, $3, $4, $5, now()
                  from jsonb_to_recordset($6::jsonb) as f(titre text, corps text)
                returning 1
              )
         select (select count(*) from retirees)::int as retirees,
                (select count(*) from ecrites)::int as ecrites`,
        [tenantId, agentId, source.type, url, nom,
          JSON.stringify(fiches.map((f) => ({ titre: f.titre, corps: f.corps })))],
      );
      const r = res.rows[0]!;
      return { retirees: r.retirees, ecrites: r.ecrites };
    });
  }
}

const COLONNES_FICHE = 'id, titre, corps, source_url, source_type, source_nom, derniere_lecture_at, updated_at';

/**
 * La provenance, telle que l'écran doit la lire. Défensive sur `source_type` : une ligne incohérente ne
 * doit pas faire lever la lecture de tout l'écran.
 */
function sourceDeLaLigne(r: { source_type: string | null; source_url: string | null; source_nom: string | null }): SourceFiche {
  if (r.source_type === 'page' && r.source_url !== null) return { type: 'page', url: r.source_url };
  if (r.source_type === 'document' && r.source_nom !== null) return { type: 'document', nom: r.source_nom };
  return { type: 'manuel' };
}

interface LigneFiche {
  id: string;
  titre: string;
  corps: string;
  source_url: string | null;
  source_type: string | null;
  source_nom: string | null;
  derniere_lecture_at: Date | null;
  updated_at: Date;
}

function versFiche(r: LigneFiche): FicheConnaissance {
  return {
    id: r.id,
    titre: r.titre,
    corps: r.corps,
    source: sourceDeLaLigne(r),
    sourceUrl: r.source_url,
    derniereLectureAt: r.derniere_lecture_at ? r.derniere_lecture_at.toISOString() : null,
    updatedAt: r.updated_at.toISOString(),
  };
}
