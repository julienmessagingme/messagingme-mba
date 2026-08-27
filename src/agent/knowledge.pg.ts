import type { Pool } from 'pg';
import { PROXIMITE_TITRE_MIN, termesDeRecherche, type FicheTrouvee, type KnowledgeStore } from './knowledge';

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
         select distinct plainto_tsquery('french'::regconfig, t) as tq
           from unnest($3::text[]) as t
          where numnode(plainto_tsquery('french'::regconfig, t)) > 0
       )
       select k.id, k.titre, k.corps, k.source_url,
              (select count(*) from utiles u where k.corps_tsv @@ u.tq)::int as termes_trouves,
              (select count(*) from utiles)::int as termes_utiles,
              similarity(k.titre, $4) as proximite_titre
         from agent_knowledge k
        where k.tenant_id = $1 and k.agent_id = $2
          and (k.corps_tsv @@ to_tsquery('french'::regconfig, $5)
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
}
