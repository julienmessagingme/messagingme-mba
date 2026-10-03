# Les outils MCP de l'agent IA et du crédit : conception (lot 8a)

2026-10-03 · décisions de Julien, prises en cadrage le même jour. Premier sous-lot du lot 8 du plan « Engage Me pour
Claude Code » (les outils MCP par domaine, l'agent IA d'abord).

Dans le parcours Claude Code, l'utilisateur décrit son activité, son site, le ton, les horaires et les transferts ;
Claude lit le site, crée l'agent et sa connaissance, le teste et l'active. Ce lot donne à Claude les outils pour le
faire, par les mêmes fonctions que la console. Il ne fait PAS répondre l'agent aux clients : aujourd'hui un agent IA
ne parle que dans le bloc Agent IA d'un scénario publié, et rien ne lui confie « tout message ». C'est le lot 5 (le
répondeur par défaut, l'outil `set_default_responder`, et la réparation du premier tour), décidé juste après celui-ci.

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff, en deux livraisons.** La production emprunte ces chemins (création
d'agent qui ouvre une clé Vercel facturable, débit du crédit du client, ouverture d'un paiement Stripe) et le lot
déplace de la logique métier hors des routes de la console, donc un écart y casserait la console sans bruit. La raison
de deux livraisons : la première ne change presque rien vu de l'extérieur et se vérifie par les tests HTTP existants,
la seconde ajoute la surface MCP sur un socle déjà relu. L'essai réel qui clôt le lot est en section 7.

## Ce que le lot engage

Rien d'irréversible côté client : aucune adresse publique nouvelle, aucun format distribué. La seule écriture hors de
chez nous est celle qui existe déjà dans la console (une clé Vercel à la création du premier agent, une session
Stripe à l'achat). ⚠️ Mais une création d'agent ouvre une clé FACTURABLE : c'est la raison pour laquelle ces outils
exigent une personne nommée (section 2).

## 1. Les outils

| Outil | Ce qu'il fait | Droit | Personne requise |
| --- | --- | --- | --- |
| `list_agents` | Les agents de l'espace : identifiant, libellé, statut, nombre de manques avant activation | `mcp:read` | non |
| `get_agent` | Un agent : sa fiche, ses réglages, ses outils, le nombre de fiches de connaissance, la liste des manques (`manquesAvantActivation`), les modèles proposés et leur prix | `mcp:read` | non |
| `create_agent` | Crée un agent en brouillon, par la fonction de la console (clé Gateway comprise) | `mcp:write` | oui |
| `update_agent` | Objectif, ton, personnalité, règles de transfert, règles d'arrêt, modèle (liste fermée) ; verrou optimiste facultatif (`fiche_version`) | `mcp:write` | oui |
| `set_agent_tools` | Ajoute et active, parmi `terminer`, `chercher_connaissance`, `lire_contact` et `escalader` seulement | `mcp:write` | oui |
| `activate_agent` | Active (contrôle de complétude, refus avec la liste des manques) ou désactive | `mcp:write` | oui |
| `test_agent` | Bac à sable : une conversation fictive (1 à 30 messages de 4000 caractères), rend la réponse et sa trace ; débite le crédit du client | `mcp:write` | oui |
| `list_knowledge` | Les fiches de connaissance d'un agent, avec leur provenance | `mcp:read` | non |
| `add_knowledge` | Ajoute des fiches (titre 200, corps 2000), 50 au plus par appel | `mcp:write` | oui |
| `delete_knowledge` | Supprime des fiches (200 identifiants au plus), journalisé | `mcp:write` | oui |
| `preview_site` | Le serveur lit un site (page, sous-arbre ou site, 50 pages au plus) et rend ce qu'il importerait, sans rien écrire | `mcp:read` | oui |
| `import_site` | Importe les pages choisies, remplacées page par page | `mcp:write` | oui |
| `import_document_text` | Claude envoie le TEXTE d'un document (extrait sur le poste) sous son nom ; traité comme un document de la console (découpage, provenance, remplacement) | `mcp:write` | oui |
| `set_transfer_mode` | Ce que l'agent peut promettre de la disponibilité de l'équipe : `always`, `business_hours`, `never` | `mcp:write` | oui |
| `get_credit` | Le solde en euros et les derniers mouvements | `mcp:read` | non |
| `buy_credit` | Rend l'adresse d'une session Stripe Checkout (`refill_50` ou `refill_100`, montant TTC annoncé) ; le paiement reste un geste humain | `mcp:write` | oui |

**Annotations** `[destructive, idempotent, monde ouvert]`, à tenir par la table du test des annotations :

| Outil | Valeurs | Raison |
| --- | --- | --- |
| `create_agent` | `[false, false, true]` | ouvre une clé chez Vercel au premier agent |
| `update_agent` | `[true, true, false]` | remplace la fiche |
| `set_agent_tools` | `[false, true, false]` | ajoute et active, ne retire rien |
| `activate_agent` | `[true, true, false]` | change ce que voient les scénarios |
| `test_agent` | `[false, false, false]` | débite le crédit, écrit l'historique des essais |
| `add_knowledge` | `[false, false, false]` | ajoute |
| `delete_knowledge` | `[true, true, false]` | supprime |
| `import_site` | `[true, true, true]` | remplace les fiches de la page, lit un site tiers |
| `import_document_text` | `[true, true, false]` | remplace les fiches du même document |
| `set_transfer_mode` | `[true, true, false]` | remplace un réglage de l'espace |
| `buy_credit` | `[false, false, true]` | crée une session chez Stripe |

Les lectures sont `readOnlyHint`, et `openWorldHint: false` sauf `preview_site` (`true` : il lit un site tiers). La
règle du test « une lecture n'est pas en monde ouvert » s'assouplit pour cet outil, nommé.

**Bornes** : chaque borne appliquée est annoncée dans le schéma de l'outil, LUE dans le Zod de la console
(`fichePatchSchema`, `BORNES_FICHE`, le corps du bac à sable, les offres), jamais recopiée. L'extracteur de bornes de
`tests/mcp-widgets.test.ts` sort en module de test partagé.

**Descriptions** : elles disent ce qu'un modèle doit savoir pour ne pas se tromper de chemin. Notamment : un agent
actif ne répond aux clients que dans un scénario qui le contient, tant que le répondeur par défaut n'existe pas ;
créer le premier agent exige environ 0,92 € de crédit (sinon `buy_credit`) ; `test_agent` débite le crédit ; un site
se lit par `preview_site` puis `import_site`, jamais en recopiant des pages dans `add_knowledge`.

## 2. Les garde-fous

- **Personne requise.** `OutilMcp` gagne un drapeau `exigePersonne`. Un outil qui le porte n'est ni listé ni
  appelable quand `ContexteMcp.personne` est nul, c'est-à-dire avec une clé d'API : le refus est celui d'un outil
  inconnu. La raison : une clé `mcp:write` peut être branchée comme connecteur d'un agent qui lit des messages de
  clients, et une injection pourrait alors modifier l'agent ou ouvrir un paiement. Avec OAuth, la personne est un
  admin relu à chaque appel, et elle signe : les outils activés le sont à son nom (l'activation l'exige déjà), la
  fiche est journalisée à son nom.
- **Le plafond des opérations coûteuses** de la console (`PlafondPartage`, par espace) est consommé par `test_agent`,
  `add_knowledge`, `preview_site`, `import_site`, `import_document_text` et `buy_credit`, en plus de l'unité de débit
  de l'appel MCP. Le serveur MCP ne contourne pas les dix opérations lourdes par minute.
- **Ce que Claude ne voit pas** : les plafonds de coût d'un agent, la phrase et la fréquence de mention d'IA,
  l'autonomie sur une action irréversible, `envoyer_bloc`, les connecteurs, l'assistant de construction de la console
  (il ferait double emploi avec Claude, sur notre clé).
- **Aucun binaire** : `import_document_text` reçoit du texte, pas de fichier, donc aucune limite de 1 Mo par appel à
  contourner et peu de jetons.

## 3. Ce qui change dans la console

- **La logique sort des routes**, comme pour les widgets (`src/widgets/gestion.ts`) : création (avec la clé Gateway),
  modification, activation, essai (débit et archivage), aperçu et import d'un site, import d'un texte de document,
  ajout et suppression de fiches, ouverture d'un paiement. Chaque fonction rend une issue (`Issue<T>`) que la route
  traduit en statut HTTP et l'outil en refus lisible. Les routes gardent exactement leurs réponses : leurs tests
  existants sont le filet.
- **Le contrôle de complétude se relance à chaque modification d'un agent ACTIF**, sur l'état effectif après
  écriture. Aujourd'hui, vider l'objectif d'un agent actif passe sans rien dire ; la console en profite aussi.
- **Chaque modification de la fiche est journalisée** dans l'historique des réglages (élément `fiche_agent`, déjà
  déclaré et jamais écrit), avec l'origine `formulaire` depuis la console et `mcp` depuis Claude.

## 4. Les données

Une migration qui ÉLARGIT `reglages_historique_origine_chk` à `mcp` (numéro pris au moment de l'écrire, 0206 au
2026-10-03). L'ancien code y survit, donc elle passe AVANT le déploiement. Aucune autre table.

## 5. Les deux livraisons

- **A, le socle** : extraction des fonctions communes, les routes qui les appellent, le contrôle de complétude sur
  modification, le journal de la fiche, la migration. Vérifiée par les tests HTTP existants, plus les tests neufs du
  contrôle et du journal.
- **B, la surface MCP** : les seize outils, le drapeau `exigePersonne`, le plafond coûteux côté MCP, la page « Serveur
  MCP » de la console (`web/lib/mcp-outils.ts`, tenue par le test de parité), et la table des annotations.

Déploiement de chacune : migration (A seulement), API, puis console. Aucun écran neuf n'appelle de route neuve.

## 6. Ce qui n'est pas dans ce lot

- Le répondeur par défaut, `set_default_responder` et la réparation du premier tour : lot 5, juste après.
- Les autres domaines du lot 8 : contacts, modèles, campagnes, suivi des conversations.
- La mention d'IA, les plafonds de coût, l'autonomie, les connecteurs et les outils irréversibles d'un agent.
- Le téléversement d'un fichier binaire, l'alerte de crédit bas, une offre de recharge plus petite que 50 € HT.

## 7. Ce qui clôt le lot

Essai réel depuis Claude Code, sur un espace qui a au moins 1 € de crédit : créer un agent, importer le site de
l'espace par `preview_site` puis `import_site`, le tester dans le bac à sable, l'activer, et le retrouver identique
dans la console (fiche, connaissance avec sa provenance, outils activés au nom de la personne, historique de la
fiche). Puis vérifier qu'une clé d'API ne voit aucun de ces outils d'écriture.

## Questions encore ouvertes

- La plus petite recharge vaut 50 € HT, lourd face aux 2 € offerts : à mesurer avant d'ajouter une offre.
- En mode test de Stripe, seuls les exploitants peuvent payer : l'essai de `buy_credit` se fait en vérifiant
  l'adresse rendue, pas en payant.
