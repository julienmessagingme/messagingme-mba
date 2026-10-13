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

Écarts décidés en cours de route (2026-10-13) :
- Livraison A : la relecture a trouvé que le tableau de bord comptait deux fois une campagne à scénario (sa ligne
  `wf-...` et le modèle de son parcours) ; corrigé dans `getDashboard` et la lecture neuve, par la garde des envois
  facturables. La maille « jour » est bornée à 92 jours.
- Livraison B : les messages écrits par l'IA sont rendus sur la période entière (le tableau de bord ne les a pas par
  jour) ; une troisième lecture neuve n'en valait pas la peine, Claude appelle mois par mois pour une série. Le
  plugin ne change pas : sa skill ne cite pas ces outils, la liste vient du serveur.
- La frise (`conversation_evenements`) n'a pas d'index sur le type : `demandesEquipeParJour` la parcourt (184 lignes
  en production le 2026-10-13, moins d'une milliseconde). Un index `(tenant_id, type, at)` le jour où elle grossit.
- Livraison B, relecture : les « passages à l'équipe » ne lisaient que `escaladee` et oubliaient les passations de
  l'agent de Meta (`passee_par_mba`, 7 sur 20 dans l'espace le plus actif en production) ; ils deviennent les demandes
  ouvertes pour l'équipe (`TYPES_OUVERTURE` de l'écran Performance, sans les fils de test). Le crédit consommé ne
  comptait que les tours d'agent : la clé le dit (`credit_des_tours_d_agent`), la traduction étant débitée à part,
  comme la console l'écrit. `aLaMaille` additionne une date qui revient (deux actions le même jour s'écrasaient).
  `get_conversation_insights` suit la décision « Pro et Entreprise : tout », alors que l'écran Analyse de la console
  est réservé à l'Entreprise : à trancher avec le découpage Pro/Entreprise.

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
