# Bot d'aide dans la console : conception

**Date** : 2026-09-11 · **Demandé par** : Julien · **Statut** : conception validée en discussion, plan à écrire

## Le problème

Un client ouvre la console Engage Me, regarde un écran qu'il ne comprend pas, et n'ose pas cliquer. Il n'a
aujourd'hui qu'une seule issue : le formulaire de `/support`, qui envoie un e-mail à l'équipe et attend une
réponse humaine. Entre sa question et cette réponse, il ne fait rien.

On veut un bouton de discussion dans la console, qui réponde tout de suite aux questions de MODE D'EMPLOI
(« comment je lance une campagne ? », « c'est quoi la différence entre un template et un scénario ? ») et qui
emmène la personne sur le bon écran.

## Hors périmètre, explicitement

**Le résumé des données du client** (« fais-moi un bilan des dernières discussions ») N'EST PAS dans cette
spec. C'est un autre produit : autre source de connaissance, autres droits, autre profil de coût, et surtout
il lit du texte écrit par des inconnus, donc il affronte un problème de sécurité que celui-ci n'a pas. Il
aura sa propre spec. La § « Ce que ça prépare pour la suite » dit ce qu'on lui laisse de prêt.

## Les trois décisions déjà prises

Prises par Julien le 2026-09-11, elles ne se rediscutent pas dans le plan :

1. **Il explique et il emmène, il n'écrit jamais.** Il répond, il cite sa source, il pose un lien qui ouvre
   le bon écran. Il ne crée pas de campagne, ne pose pas de tag, n'envoie rien. C'est le seul périmètre où
   une réponse fausse ne coûte qu'un aller-retour.
2. **L'aide produit d'abord**, le résumé des données plus tard.
3. **Les tokens sont à notre charge**, pas sur le crédit prépayé du client. Facturer quelqu'un pour
   apprendre à se servir du produit se retourne contre nous : celui qui hésite à poser une question est
   celui qui abandonne.

## Ce qui existe déjà, et qui porte les cinq sixièmes du travail

Vérifié dans le code le 2026-09-11 :

| Pièce | Où | Ce que ça nous donne |
|---|---|---|
| Un moteur d'agent qui tourne HORS WhatsApp | `src/http/agent-test.ts:75` fait tourner un vrai tour avec `waId: 'bac-a-sable'` | Le moteur n'a pas besoin d'un contact WhatsApp |
| Un chat persistant DANS la console, en production | `web/components/AgentConstruction.tsx` + `src/http/agent-setup.ts` + `src/agent/setup/` | Le motif du widget, la persistance, la conduite côté serveur |
| Une recherche hybride | `src/agent/recherche.ts`, migrations 0086 (tsvector français) et 0110 (pgvector HNSW cosinus) | Rappel lexical + sémantique + reclassement, une seule fabrique |
| Un modèle DÉDIÉ par usage | `AGENT_MODEL` et `AGENT_SETUP_MODEL` (`src/config.ts`) | Le motif à suivre pour `AGENT_AIDE_MODEL` |
| Notre clé maison | `AI_GATEWAY_API_KEY`, bornée par le plafond d'équipe Vercel (100 $/mois, posé le 2026-09-09) | De quoi payer sans toucher au crédit du client |
| La carte de l'application | l'arbre de nav de `web/components/AppShell.tsx`, son modèle `web/lib/nav.ts`, et `type Tab` | Clé stable, adresse, libellé bilingue, rôle requis |
| Une sortie humaine | `src/http/support.ts` (formulaire vers l'équipe par Resend) | Le recours quand le bot ne sait pas |

Ce qui manque vraiment : **une base de connaissance du PRODUIT**, partagée par tous les espaces.

## L'architecture : deux connaissances, et c'est tout le design

Le bot répond à partir de deux sources de nature différente, et les mélanger serait la faute de conception
de ce programme. L'une est mécanique et ne peut pas être fausse ; l'autre est de la prose et demande une
relecture humaine.

### 1. La carte de la console, DÉRIVÉE du code

**Elle répond à « où ça se passe » et alimente les liens.** Elle n'est jamais écrite à la main.

L'arbre de navigation porte déjà, par entrée : une `key` stable, un `href`, un `label` bilingue (via `t()`),
et le rôle requis (seule l'Inbox est ouverte à un agent, tout le reste exige admin,
`web/components/AppShell.tsx`). `type Tab` est l'union exhaustive de ces clés, donc **le compilateur casse si
un écran disparaît**.

Ce qu'il faut faire :

- **Sortir l'arbre dans `web/lib/nav.ts`, sous la forme `arbresNav(t)`** : une fonction qui PREND le
  traducteur et rend les trois arbres. Structure et libellés restent donc ENSEMBLE, ce qui compte : une
  constante de structure plus une table de libellés seraient deux listes à tenir alignées à la main, et le
  CLAUDE.md du dépôt documente ce que ça coûte. C'est le seul changement de code existant que cette spec
  demande, et `nav.ts` existe déjà comme modèle de la nav, avec son test.
- **Générer `carte-console.json`** depuis cette constante, à la construction, et le servir au moteur.
- **Un test qui casse la CI** si une entrée de la carte pointe vers un `href` sans page correspondante dans
  `web/app/**/page.tsx`, ou vers une clé absente de `type Tab`.

🔴 **C'est la garde anti-hallucination, et elle est structurelle.** Le pire échec de ce produit n'est pas une
réponse imprécise, c'est un bot qui annonce un bouton qui n'existe pas : le client perd confiance dans le
PRODUIT, pas dans le bot. Une consigne de prompt (« ne cite que des écrans réels ») n'est pas une garantie,
c'est un souhait. Le dépôt a déjà tranché ce débat en migration 0126, en retirant au modèle une décision
qu'il ne pouvait pas tenir. Ici, le modèle ne choisit pas une adresse : il choisit une CLÉ dans une liste
fermée, et le serveur résout la clé en adresse. Une clé inventée ne produit aucun lien.

⚠️ **Le rôle voyage avec l'entrée**, et c'est obligatoire : emmener un agent vers un écran admin le ferait
tomber sur un refus, ce qui est pire que ne pas répondre. Le moteur filtre la carte sur le rôle de la
personne AVANT de la donner au modèle.

### 2. Les fiches du mode d'emploi, DÉRIVÉES de notre doc puis relues

**Elles répondent à « pourquoi, quand, dans quel ordre ».**

La tentation évidente est d'indexer `features.md` tel quel : il décrit exactement ce que fait le produit, une
règle du dépôt le tient à jour, et la CI pourrait le réindexer à chaque poussée. **C'est un piège** : il est
écrit pour l'équipe. Il contient des numéros de migration, des dates de livraison, des noms de fichiers et
des récits d'incident (« vécu le 2026-08-25 »). Un bot client qui cite ça est au mieux confus, au pire il
expose notre cuisine.

Donc : une passe de génération transforme les entrées de `features.md` en fiches CLIENT (titre, corps, écran
concerné), **écrites comme des fichiers markdown dans `docs/aide/fiches/`**, une fiche par fichier. La
relecture est alors un **diff git** : on garde, on réécrit, on jette, et l'historique est gratuit.

🔴 **LE DÉPÔT EST LA SOURCE, LA BASE N'EST QUE L'INDEX.** C'était d'abord conçu avec une colonne `statut` et
un écran de relecture à construire. Le diff git fait déjà tout ce que cet écran aurait fait, mieux et sans
code : versionné, attribuable, réversible, et relu là où on relit déjà tout le reste. Conséquence à ne pas
perdre de vue : une ligne supprimée à la main en base revient au chargement suivant, et c'est le
comportement voulu.

⚠️ **La relecture est faite par NOUS, une fois, pas par le client.** Ces fiches décrivent notre produit ; un
client n'a rien à y valider.

**Ce qui garde les fiches à jour** : un contrôle de CI compare l'empreinte des sections de `features.md` à
celle enregistrée sur chaque fiche, et signale les fiches dont la section a bougé. Il ne régénère pas tout
seul (une régénération silencieuse remplacerait un texte relu par un texte non relu), il dit lesquelles sont
à revoir. Le dépôt a un historique documenté de documentation qui dérive dès qu'elle est tenue à la main,
c'est pour ça que la dérive doit être DÉTECTÉE mécaniquement même si la correction reste humaine.

## Le stockage : une table à part, migration 0131

```
aide_fiches (
  id,
  cle,                -- le NOM DU FICHIER sans extension : c'est elle qui rend le chargement idempotent
  titre, corps,
  ecran,              -- la clé de nav (`campagnes`, `workflows`...), pas une URL
  source_section,     -- la section de features.md dont elle vient
  source_empreinte,   -- pour détecter que la section a bougé
  corps_tsv,          -- généré, to_tsvector('french', titre || corps), comme 0086
  embedding vector(1536), embedding_modele,   -- mêmes colonnes qu'en 0110
  created_at, updated_at
)
```

⚠️ **Pas de colonne `statut`** : une fiche présente dans le dépôt est publiée, une fiche absente n'existe
pas. Le chargeur (`npm run aide:charger`) met à jour par `cle` et SUPPRIME les lignes dont le fichier a
disparu, sans quoi le bot continuerait de répondre avec une page effacée.

🔴 **UNE TABLE À PART, et surtout PAS `agent_knowledge` avec `tenant_id` nullable.** `tenant_id = $1` sur
chaque requête est LE contrôle d'isolation entre clients de ce produit, la RLS étant contournée (le pooler
est superuser). Rendre cette colonne nullable sur la table qui porte la connaissance MÉTIER des clients
affaiblirait le contrôle le plus important du dépôt, pour loger une donnée qui n'a aucune raison d'y être.
Le coût d'une table de plus est nul ; le coût d'une garde d'isolation devenue conditionnelle ne l'est pas.

⚠️ **`ecran` porte une CLÉ de nav, jamais une URL.** Une URL enregistrée en base vieillit en silence le jour
où une page déménage ; une clé est résolue à l'affichage par la carte, donc elle suit. Et une clé inconnue
est détectable, une URL morte non.

⚠️ **La vectorisation passe par le balayage existant**, pas par l'écriture (`balayerVectorisation`,
`src/agent/recherche.ts`). Conséquence acceptée et documentée là-bas : une fiche tout juste publiée est
trouvable par les MOTS à la seconde, par le SENS au passage suivant.

## Le widget

Un bouton flottant, posé **une seule fois dans `AppShell`**, donc aucun des 36 écrans authentifiés à
modifier (les 8 autres sont les pages de connexion, où il n'a rien à faire). Il transmet la clé de l'écran
courant, ce qui rend l'aide contextuelle sans rien demander à la personne.

🔴 **LE FIL EST GARDÉ TANT QUE LA PERSONNE EST CONNECTÉE, dans le NAVIGATEUR** (`sessionStorage`), et non
côté serveur comme cette spec l'annonçait d'abord. Ce que le serveur persiste pour la Construction, il le
fait parce que cette conversation-là CONDUIT un entretien, décide du point suivant et produit un réglage
durable ; une question d'aide ne produit rien et ne se reprend pas d'un autre poste. Une table de plus, avec
sa purge, coûterait plus cher que le service rendu.

⚠️ **Et il doit survivre à la NAVIGATION**, ce qui a été le vrai enseignement de l'essai : la coquille est
remontée à chaque changement d'écran, donc suivre le lien que le bot vient de donner effacerait la
conversation au moment précis où l'on veut poser la question suivante. `sessionStorage` survit à la
navigation et au rechargement, meurt avec l'onglet, et est effacé à la déconnexion : le fil dit ce que la
personne cherchait à faire, le laisser derrière elle le mettrait à la disposition du suivant sur le poste.

⚠️ **Le fil part au modèle, borné à quatre échanges**, sans quoi il serait décoratif : un écran qui affiche
un historique auquel le bot répond comme si rien ne précédait est pire que pas d'historique. Corollaire à ne
pas perdre : « et ensuite ? » ne ramène aucune fiche au rappel, qui est donc rattrapé par la question
précédente, mais SEULEMENT quand la question seule a échoué.

## La route et le moteur

Une route **synchrone** (`POST /tenants/:tenantId/aide`), pas un travail de file : la personne attend devant
son écran. Elle réutilise `creerCerveauGateway` et la recherche hybride, avec :

- la garde d'authentification et le `scopeTenant` des 36 modules existants, sans exception ;
- le plafond de débit COÛTEUX (`RATE_LIMIT_COUTEUX_PAR_MINUTE`, clé = espace), pas le plafond ordinaire :
  chaque question coûte un appel de modèle ;
- `AGENT_AIDE_MODEL`, déclaré comme `AGENT_SETUP_MODEL` l'est déjà, et exigé dès que `AI_GATEWAY_API_KEY`
  est renseignée.

## Quand il ne sait pas

**Il le dit, et il ouvre `/support`.** Aucune fiche au-dessus du seuil de reclassement veut dire « je ne
sais pas », et c'est une réponse acceptable. Inventer une réponse plausible est la seule chose qu'on ne
tolère pas. L'écran de recours existe déjà et part par e-mail vers l'équipe (`src/http/support.ts`), il n'y
a donc aucune voie de sortie à construire.

## Le coût, et ce qui le borne

Notre clé (`AI_GATEWAY_API_KEY`), donc la dépense tombe sous le **plafond d'équipe Vercel** déjà posé.

⚠️ **Ce plafond coupe TOUS les projets du Gateway d'un coup**, y compris les bots clients en production. Il
ne suffit donc pas comme seule borne : la route porte aussi le plafond de débit par espace, qui empêche un
seul client de consommer pour tout le monde. Le plafond d'équipe est le filet, pas la borne.

## La langue

Les fiches sont écrites en **français** (notre documentation l'est), et le modèle répond dans la langue de la
console. Le rappel LEXICAL est un `tsvector` français : une question posée en anglais ne le déclenchera pas,
et ne sera servie que par le rappel sémantique.

🔴 **À MESURER avant d'écrire quoi que ce soit en anglais** : si le rappel sémantique seul suffit sur des
questions anglaises contre des fiches françaises, on n'écrit rien de plus. Sinon, on double les fiches. On ne
décide pas ça d'avance : le modèle d'embedding en place est `cohere/embed-v4.0`, sa portée multilingue est
une propriété à vérifier, pas à supposer.

## Ce qu'on ne construit pas

- Pas de streaming de réponse au premier tour. La Construction n'en a pas et personne ne s'en est plaint.
- Pas de retour d'appréciation (pouce haut ou bas) au premier tour.
- Pas d'écriture, sous aucune forme, ni brouillon ni suggestion appliquée.
- Pas de base par client : le mode d'emploi est le même pour tout le monde.

## Les tests qui tiennent la conception

1. **Carte contre routes** : chaque `href` de la carte correspond à une page réelle, chaque `key` est dans
   `type Tab`. Casse la CI quand un écran déménage.
2. **Le rôle est respecté** : la carte donnée à un agent ne contient aucune entrée admin.
3. **Une clé inventée ne produit aucun lien** : le moteur résout les clés contre la carte, une clé inconnue
   est ignorée, pas devinée.
4. **Aucune fiche publiée ne contient de marqueur interne** : pas de `db/migrations/`, pas de `src/`, pas de
   « vécu le », pas de numéro de migration. Un test qui lit les fiches.
5. **Dérive de la doc** : une section de `features.md` dont l'empreinte a changé signale ses fiches.
6. **Isolation** : la table `aide_fiches` n'a pas de `tenant_id`, et aucune requête de ce module ne lit
   `agent_knowledge`.

Chacun se vérifie par MUTATION avant d'être considéré comme acquis, conformément à la règle du dépôt.

## Ce que ça prépare pour la suite (le résumé des données)

- Le widget, la route, le fil de conversation et le plafond de débit sont réutilisés tels quels.
- Les outils de lecture des données existent déjà (`src/mcp/outils.ts` : `list_conversations`,
  `get_conversation`, `get_messages`, `search_contacts`, `get_contact`, `list_members`).
- 🔴 **Ce qui restera entièrement à faire, et qui n'est pas un détail** : les messages des contacts sont du
  contenu NON FIABLE. Un résumé qui les avale réunit les trois pattes du *lethal trifecta* (données privées,
  contenu hostile, canal de sortie). La règle existe déjà dans le CLAUDE.md global (bloc de données délimité,
  jamais concaténé au prompt système) et l'analyse de conversation l'affronte déjà, mais ça se conçoit au
  départ de cette spec-là, pas en la greffant sur celle-ci.
- ⚠️ Rien dans cette spec ne doit rendre la suivante plus difficile : c'est pourquoi la carte, les fiches et
  la conversation sont trois modules séparés, et pourquoi la route ne suppose pas que la connaissance est
  partagée.
