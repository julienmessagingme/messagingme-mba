import type { Pool } from 'pg';
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
 * Recherche dans `agent_knowledge` (migration 0086). Plein texte natif plus trigramme, PAS de pgvector : la
 * base n'a pas l'extension, et l'ajouter pour ce lot serait une décision d'infrastructure, pas de feature.
 *
 * 🔴 CE QUE CETTE REQUÊTE MESURE, ET POURQUOI CE N'EST PAS UN RANG. La première version classait par
 * `ts_rank_cd`, et la revue a montré que le seuil posé au-dessus était INERTE : `ts_rank_cd` a un plancher
 * arithmétique (poids D = 0,1, soit 0,0909 après normalisation) et l'opérateur `%` un autre (0,3), si bien
 * qu'aucune ligne rendue ne pouvait tomber sous un seuil de 0,05. Le filtre réel était le `where`, un OR sur
 * les termes : UN SEUL mot commun suffisait à livrer une fiche au modèle.
 *
 * On mesure donc autre chose, de directement interprétable : **combien de termes signifiants de la question
 * se retrouvent dans la fiche**, et sur combien. Un rang dit « à quel point ça ressort » ; ce compte dit
 * « ai-je une source pour CETTE question », qui est la seule chose qu'on veut savoir ici. Le verdict, lui,
 * est rendu en code (`resolvers/mba.ts`).
 *
 * Un terme qui ne produit aucun lexème (un mot vide comme « de », « le ») est retiré du compte ET du
 * dénominateur par `numnode(...) > 0` : sans ça une question polie diluait sa propre couverture.
 *
 * Deux paramètres portent la même liste de termes, et c'est délibéré : le `@@` du `where` prend la requête
 * OU-ée d'un bloc, parce que c'est cette forme-là que l'index GIN sait servir ; la couverture prend le
 * tableau, parce qu'elle a besoin des termes un par un. Le sous-select ne s'exécute que sur les candidats
 * déjà filtrés.
 */
export class PgKnowledgeStore implements KnowledgeStore {
  constructor(private readonly pool: Pool) {}

  async chercher(tenantId: string, agentId: string, requete: string, limite: number): Promise<FicheTrouvee[]> {
    const termes = termesDeRecherche(requete);
    // Aucun terme exploitable (requête vide, ponctuation seule) : on ne lance AUCUNE requête. `to_tsquery`
    // sur une chaîne vide lèverait, et il n'y a de toute façon rien à chercher.
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
      // Aucun terme signifiant (la question n'était faite que de mots vides) : la couverture n'a pas de sens,
      // et zéro est le repli sûr, celui qui ne laisse pas passer une fiche.
      couverture: r.termes_utiles > 0 ? r.termes_trouves / r.termes_utiles : 0,
      proximiteTitre: Number(r.proximite_titre ?? 0),
    }));
  }

  /**
   * LE RAPPEL VECTORIEL (migration 0110). Les fiches les plus proches du vecteur de la question.
   *
   * 🔴 Ce que cette requête ne fait PAS, et c'est le plus important : elle ne juge rien. Elle rend un
   * classement, et il y a TOUJOURS une fiche « la moins loin », y compris pour une question qui n'a aucune
   * réponse dans la base. Le verdict est rendu après, par le reranker, sur un score qui, lui, sépare
   * (mesuré le 2026-09-02). Servir ces lignes directement au modèle serait exactement l'hallucination que
   * tout ce mécanisme empêche.
   *
   * `embedding is not null` n'est pas une précaution : une fiche pas encore vectorisée (créée il y a dix
   * secondes, en attente du balayage) reste trouvable par le plein texte, elle n'a simplement pas encore sa
   * seconde porte d'entrée.
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
      // Aucune mesure LEXICALE ici, et zéro est la valeur juste : cette fiche n'a pas été trouvée par les
      // mots. Lui prêter une couverture inventée ferait passer la règle lexicale pour un verdict qu'elle
      // n'a pas rendu.
      termesTrouves: 0,
      couverture: 0,
      proximiteTitre: 0,
      similarite: Number(r.similarite),
    }));
  }

  /**
   * Les fiches qui n'ont pas encore de vecteur, ou dont le vecteur vient d'un AUTRE modèle.
   *
   * 🔴 Le second cas est ce qui rend un changement de modèle progressif au lieu d'aveuglant : on ne vide pas
   * la colonne d'un coup (toutes les bases deviendraient sourdes le temps du rattrapage), on laisse le
   * balayage remplacer les vecteurs périmés au fil de l'eau, pendant que les anciens continuent de servir.
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

  // ---------- Écriture : l'écran de réglage (tranche 19b) ----------
  // Hors de `KnowledgeStore` à dessein : le tour d'agent ne lit que `chercher`, et ses doubles de test n'ont
  // pas à porter l'écriture.

  async lister(tenantId: string, agentId: string): Promise<FicheConnaissance[]> {
    const res = await this.pool.query<LigneFiche>(
      `select ${COLONNES_FICHE} from agent_knowledge
        where tenant_id = $1 and agent_id = $2
        order by lower(titre)`,
      [tenantId, agentId],
    );
    return res.rows.map(versFiche);
  }

  /** Écrit une fiche. Rend `null` si l'agent n'existe pas OU appartient à un autre tenant. */
  async creer(tenantId: string, agentId: string, fiche: FicheAEcrire): Promise<FicheConnaissance | null> {
    // Le `where exists` est le contrôle d'appartenance, et il est DANS l'écriture : une fiche portant le
    // tenant de l'un et l'agent de l'autre ne serait jamais lue par personne. Zéro ligne = agent introuvable.
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
   * Corrige une fiche. Rend `null` si elle n'existe pas, ou si elle n'est pas celle de CE couple
   * (tenant, agent).
   *
   * L'agent fait partie du périmètre, comme à l'écriture : sans lui, l'adresse promet un agent que la requête
   * ne contrôle pas, et un identifiant de fiche mal aiguillé par l'écran corrigerait en silence la fiche d'un
   * AUTRE agent du même client.
   */
  async modifier(
    tenantId: string, agentId: string, ficheId: string, patch: { titre?: string; corps?: string },
  ): Promise<FicheConnaissance | null> {
    // `agent_id` fait partie du `where`, pas seulement `tenant_id` : le couple (tenant, agent) est le
    // périmètre partout ailleurs, et l'adresse le promet. `updated_at` marque le passage d'un humain, ce qui
    // désarme l'alerte de fraîcheur : quelqu'un vient de relire cette fiche.
    // 🔴 LE VECTEUR EST EFFACÉ quand le texte change, et c'est le point de passage obligé de tout le
    // mécanisme : un vecteur qui décrit l'ANCIEN texte est pire qu'une absence de vecteur, parce qu'il fait
    // remonter la fiche sur des questions qu'elle ne traite plus. Le balayage le recalculera ; entre-temps la
    // fiche reste trouvable par le plein texte, donc rien n'est perdu.
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
   * Relit une source : retire les fiches de CETTE adresse pour CET agent, puis écrit les nouvelles, en une
   * seule transaction.
   *
   * 🔴 REMPLACER ET NON AJOUTER. Une relecture qui ajouterait doublerait la base à chaque passage, et la
   * recherche compte les mots partagés : deux copies d'une même fiche ne rendent pas la réponse plus sûre,
   * elles la rendent deux fois plus probable qu'une autre. Le prix est dit au client dans l'écran : ses
   * corrections sur les fiches de cette adresse partent avec.
   */
  /**
   * Retrait puis écriture EN UNE SEULE INSTRUCTION. Les CTE modifiantes de Postgres voient toutes le même
   * instantané et s'exécutent une fois : la base ne passe jamais par un état où l'ancienne version est partie
   * sans que la nouvelle soit là. Un client qui relit son site pendant qu'un contact discute ne le laisse
   * donc pas sans source, même une fraction de seconde.
   */
  /**
   * ⚠️ LA CLE DE REMPLACEMENT EST LA SOURCE ENTIERE, pas une URL. Un document se reimporte comme une page se
   * relit (decision de Julien, 2026-09-08) : ses fiches d'avant partent, les nouvelles arrivent. Sur une URL
   * seule, deux documents de meme contenu se seraient ecrases l'un l'autre, ou n'auraient jamais pu etre
   * remplaces du tout.
   */
  async remplacerSource(
    tenantId: string, agentId: string, source: SourceFiche, fiches: FicheAEcrire[],
  ): Promise<{ retirees: number; ecrites: number } | null> {
    // 'manuel' n'a pas de cle : rien a remplacer, et un `where` sur deux null retirerait TOUTES les fiches
    // ecrites a la main. Le refuser ici plutot que de s'en remettre a la vigilance des appelants.
    if (source.type === 'manuel') return { retirees: 0, ecrites: 0 };
    const url = source.type === 'page' ? source.url : null;
    const nom = source.type === 'document' ? source.nom : null;
    /**
     * 🔴 L'AGENT EST VERROUILLÉ D'ABORD, dans une instruction À PART (relecture du 2026-09-22). Sans ce verrou,
     * l'instruction retirait des fiches, puis prenait l'agent par la clé étrangère de ses insertions, en fin
     * d'instruction : pendant ce temps, `PgAgentStore.remove` tenait l'agent et sa cascade attendait ces mêmes
     * fiches (40P01, donc un 500). Avec lui, l'ordre est celui de `remove` : l'agent, puis ce qui en dépend.
     */
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const agent = await client.query('select 1 from agents where tenant_id = $1 and id = $2 for key share', [tenantId, agentId]);
      if ((agent.rowCount ?? 0) === 0) { await client.query('rollback'); return null; }
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
      await client.query('commit');
      const r = res.rows[0]!;
      return { retirees: r.retirees, ecrites: r.ecrites };
    } catch (e) {
      await client.query('rollback').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}

const COLONNES_FICHE = 'id, titre, corps, source_url, source_type, source_nom, derniere_lecture_at, updated_at';

/**
 * La provenance, telle que l'ecran doit la lire.
 *
 * ⚠️ Defensive sur `source_type` : la colonne est arrivee avec un defaut, mais une ligne ecrite par un
 * chemin qu'on aurait oublie de mettre a jour ne doit pas faire lever la lecture de tout l'ecran.
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
