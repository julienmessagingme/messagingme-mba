# Spec : les chiffres de l'espace pour Claude Code (2026-10-13)

## Le besoin

Une personne demande à Claude « fais-moi un graphique de mes envois du mois » ou « comment évolue la satisfaction de
mes clients ». Claude lit des CHIFFRES AGRÉGÉS de l'espace par des outils MCP, puis dessine comme il l'entend. Aucun
outil ne rend un message, un contact ou une conversation un par un.

## Décisions de Julien (grill du 2026-10-13)

- Des outils par THÈME, chacun avec sa période et sa maille.
- Les mêmes fonctions et les mêmes chiffres que l'écran Statistiques de la console, sur les mêmes périodes.
- Pro et Entreprise : tout (messages et contacts, campagnes et modèles, conversations analysées, agents IA et crédit).
  Le découpage entre Pro et Entreprise se fera plus tard, à tête reposée : il doit se faire en changeant la fonction
  d'offre d'un outil, sans réécriture.
- Free : l'essentiel, les modèles envoyés, livrés, lus et en échec, par jour, sur les 30 derniers jours. Au-delà de
  cette fenêtre, ou pour le reste, l'outil REFUSE avec le lien de l'offre Pro.
- Les coûts : le crédit IA consommé, et le coût Meta estimé, toujours annoncé comme une estimation.
- Données seulement : aucune skill de rendu dans le plugin.
- Comparer deux périodes : Claude appelle deux fois, rien n'est ajouté aux outils.
- Toute clé de lecture (`mcp:read`) lit ces chiffres, sans personne requise : ce sont des agrégats.

## La conception

**Quatre outils de lecture** (`src/mcp/outils-chiffres.ts`, un module neuf), entrée commune : `du` et `au`
(`AAAA-MM-JJ`, heure de Paris comme la console, 366 jours au plus, défaut les 30 derniers jours) et `maille` (`jour`,
`semaine` du lundi, `mois` civil ; défaut `jour`).

1. **`get_message_stats`** (toutes les offres, `fonction: null`, l'offre lue à l'appel) :
   - pour toutes : par maille, les modèles **envoyés**, **livrés** (lus compris), **lus**, **en échec** (refusés à
     l'envoi ou annoncés en échec par Meta) et **sans accusé** (partis, sans accusé de Meta) ;
   - Pro et Entreprise, en plus : les modèles par catégorie (`getDashboard`), les messages échangés et de service, le
     service par origine (IA, scénario, humain), les contacts (cumulés, actifs), et le **coût Meta estimé** par maille
     (`getCostSeries`) et sur la période (`getCoutMessages`), chacun marqué `estimation: true`.
   - En Free, une période qui commence avant les 30 derniers jours est refusée (`plan_feature_unavailable`, la fenêtre
     permise dite, le lien Pro).
2. **`get_campaign_stats`** (`fonction: 'statistiques'`) : sans `campaign_id`, les campagnes de la période avec leur
   coût et leurs engagements (`getCoutParCampagne`) et les erreurs de Meta par code et par modèle
   (`getErrorBreakdown`) ; avec `campaign_id`, l'entonnoir de la campagne (`getCampaignFunnel`, clics compris).
3. **`get_conversation_insights`** (`fonction: 'statistiques'`) : la synthèse de la période (`getSummary` : sentiment,
   intentions, résolues, qui a traité, actions suggérées, sujets les plus fréquents) et, par maille, les conversations
   analysées et la satisfaction et l'urgence moyennes (`joursAnalyse`, qui comble au-delà de la rétention par les
   agrégats gardés 12 mois).
4. **`get_ai_stats`** (`fonction: 'statistiques'`) : le crédit IA consommé (`getCoutIa`), les messages écrits par l'IA
   par maille (`serviceIaDetail` du tableau de bord : agent IA, agent de Meta, MCP), les transferts à l'équipe (les
   événements `escaladee` de la frise) et les actions déclenchées par action (`agent_actions`).

**Une seule lecture neuve en SQL** : `statutsDesModelesParJour` (`PgStatsStore`), la population exacte des modèles
envoyés de `getDashboard` (campagnes, puis modèles hors campagne), avec leurs accusés (`campaign_recipients.delivery_status`,
`conversation_messages.statut`). Les deux autres comptes neufs (transferts, actions) sont des `count ... group by jour`
filtrés sur l'espace. Tout le reste appelle les fonctions de la console, telles quelles.

**La maille** se calcule en TypeScript à partir des séries par jour : des SOMMES pour les comptes ; une moyenne se
recalcule par sa somme et son nombre de mesures (`mesurees`), jamais en moyenne de moyennes.

**Ce que l'outil dit de lui-même** : chaque réponse porte `du`, `au`, `maille`, `fuseau: 'Europe/Paris'` et, quand
c'est vrai, ce que la donnée ne couvre pas (les accusés d'un message seul n'existent que depuis 0225, 2026-10-09 ; un
message effacé par la rétention ne compte plus).

## Hors champ

La différence entre Pro et Entreprise (plus tard) ; une skill de rendu ; la comparaison intégrée ; un chiffre qui
désigne une personne (liste de contacts touchés par une erreur, liste de conversations analysées) ; le Performance Lab
(temps de réponse par collaborateur).
