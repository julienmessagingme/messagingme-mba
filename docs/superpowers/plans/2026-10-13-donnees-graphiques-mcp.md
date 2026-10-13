# Plan : les chiffres de l'espace pour Claude Code (2026-10-13)

Spec : [docs/superpowers/specs/2026-10-13-donnees-graphiques-mcp-design.md](../specs/2026-10-13-donnees-graphiques-mcp-design.md).

## Méthode de livraison

**En direct, une relecture indépendante en fin de lot**, parce que ce sont des outils de LECTURE, réversibles, sans
envoi ni écriture, dont les critères se vérifient par des tests (les mêmes totaux que les routes de la console) ; la
seule lecture SQL neuve a son test d'intégration et un EXPLAIN en lecture seule sur la production avant le déploiement.
L'essai réel qui clôt le lot (plus bas) : Julien demande ses graphiques à Claude Code sur un espace Free et un espace
Pro, et compare aux chiffres de l'écran Statistiques.

## Livraison A : le moteur et `get_message_stats`

1. `src/mcp/outils-chiffres.ts` : la lecture commune de `du`, `au`, `maille` (défauts, bornes de la console,
   `parseRange`) et le regroupement par maille (sommes ; moyennes par somme et nombre de mesures).
2. `PgStatsStore.statutsDesModelesParJour` : la population des modèles envoyés de `getDashboard`, avec leurs accusés.
3. `get_message_stats` : l'essentiel pour toutes les offres ; en Free, la fenêtre des 30 derniers jours (refus avec le
   lien Pro au-delà) ; le reste en Pro et Entreprise, coût estimé marqué `estimation`.
4. Le catalogue (`web/lib/partage/catalogue-mcp.ts`, `mcp:read`), les libellés (`web/lib/mcp-outils.ts`), la doc
   régénérée, le câblage (`src/index.ts`, les dépendances du MCP : les fonctions de la route des statistiques).

## Livraison B : les trois outils du Pro

`get_campaign_stats`, `get_conversation_insights`, `get_ai_stats` (`fonction: 'statistiques'`) ; les deux comptes neufs
(transferts, actions déclenchées) ; `features.md` (la section du serveur MCP) et le plugin (0.1.6, la liste des outils
de la skill de mise en service si elle les cite).

## Tests attendus

- La maille : une semaine et un mois re-sommés ; une moyenne pondérée par `mesurees` (le cas 1 mesure de 9 et 9 de 3).
- Les offres : un Free lit les quatre séries essentielles, pas le reste ; un Free hors des 30 jours est refusé avec le
  lien ; un Free sur `get_campaign_stats` est refusé ; un Pro lit tout.
- La parité : chaque outil rend les totaux de la route de la console sur la même période (mêmes fonctions).
- L'isolation : chaque lecture neuve filtre sur l'espace (test d'intégration avec un second espace).
- `statutsDesModelesParJour` : envoyés, livrés (lus compris), lus, échecs, sans accusé, sur campagne et hors campagne,
  un modèle de test exclu (`is_test`), en intégration.
- La garde des scopes : une clé `mcp:read` les voit et les appelle ; ils n'écrivent rien.

## Ordre de déploiement

Aucune migration. A puis B, chacune poussée après sa CI lue job par job, déployée par le `up` de l'API ; le plugin
publié après B.

## L'essai réel qui clôt

Depuis Claude Code, sur un espace Free puis un espace Pro : « fais-moi un graphique de mes envois des 30 derniers
jours, avec les lus », puis en Pro « et la satisfaction des conversations sur trois mois ». Preuve : les chiffres sont
ceux de l'écran Statistiques ; le Free reçoit le refus avec le lien Pro sur trois mois.
