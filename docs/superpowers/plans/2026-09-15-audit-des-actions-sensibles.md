# Le journal d'audit couvre ce qui donne du pouvoir et ce qui fait sortir des données

**Objectif :** tracer les actions du **groupe 1** (identités, accès, sorties vers des tiers) plus
`contact.exporte`, choisies par Julien le 2026-09-15 dans l'inventaire des 28 modules d'écriture.

**Pourquoi maintenant :** le journal ne connaît que **sept** actions (`contact.created`, `.imported`,
`.purged`, `.optin`, `.optout`, `workflow.published`, `conversation.effacee`). Il trace ce qui touche aux
PERSONNES et rien de ce qui touche aux ACCÈS. C'est le trou qu'un questionnaire sécurité ouvre en premier :
personne ne peut dire qui a donné les droits admin, créé une clé d'API, ou branché un webhook sortant.

---

## Deux contraintes découvertes à l'inventaire, et elles décident du contenu

### 🔴 Aucune migration : `audit_log.action` est un `text` LIBRE

Vérifié dans la migration 0061 : pas de CHECK, pas d'énumération en base. Ajouter une action est un
changement de TypeScript, rien d'autre. ⚠️ Le revers est qu'aucune garde de base ne rattrapera une faute de
frappe dans un nom d'action : c'est au type `AuditAction` de le faire, et à lui seul.

### 🔴 Une connexion échouée n'a pas toujours d'espace, et `tenant_id` est NOT NULL

`audit_log.tenant_id` référence `tenants(id)` et n'est pas nullable. Une tentative sur une adresse INCONNUE
n'appartient donc à aucun espace et **ne peut pas être journalisée**. C'est une limite de conception, pas un
oubli, et elle est défendable : une adresse qui n'existe pas n'est l'événement de personne.

**Ce qu'on trace donc : les échecs sur un compte QUI EXISTE**, c'est-à-dire exactement le cas qui intéresse
(quelqu'un s'acharne sur un vrai compte). ⚠️ À ÉCRIRE À L'ÉCRAN quand cette section existera, sinon un lecteur
conclura que personne n'a jamais tenté d'entrer.

⚠️ **ET LE VOLUME EST DÉJÀ BORNÉ**, vérifié : le login porte un frein de 10 tentatives par minute et par IP,
qui rend 429 AVANT la vérification du mot de passe. Un attaquant freiné n'atteint donc jamais l'écriture. Sans
ce frein, ajouter un journal sur un chemin NON AUTHENTIFIÉ aurait été une amplification offerte.

---

## Ce qu'on trace, et où ça s'accroche

| Action | Route | Fichier |
|---|---|---|
| `utilisateur.invite` | `POST /tenants/:t/invitations` | `src/http/users.ts:74` |
| `utilisateur.role_change` | `PATCH /tenants/:t/users/:u/role` | `src/http/users.ts:154` |
| `utilisateur.desactive` | `PATCH /tenants/:t/users/:u/disabled` | `src/http/users.ts:178` |
| `utilisateur.retire` | `DELETE /tenants/:t/users/:u` | `src/http/users.ts:193` |
| `connexion.echouee` | `POST /auth/login` (compte existant) | `src/auth/routes.ts` |
| `cle_api.creee` | `POST /tenants/:t/api-keys` | `src/http/api-keys.ts:31` |
| `cle_api.revoquee` | `DELETE /tenants/:t/api-keys/:id` | `src/http/api-keys.ts:52` |
| `numero.connecte` | `POST /tenants/:t/embedded-signup/complete` | `src/http/embedded-signup.ts:49` |
| `webhook.cree` / `.modifie` / `.supprime` | `POST`/`PATCH`/`DELETE /tenants/:t/webhooks` | `src/http/webhooks-admin.ts` |
| `webhook.secret_change` | `POST`/`DELETE /tenants/:t/webhooks/:id/secret` | `src/http/webhooks-admin.ts:235` |
| `connecteur.cree` / `.modifie` / `.supprime` | `POST`/`PATCH`/`DELETE` des sources | `src/http/agent-sources.ts` |
| `contact.exporte` | `GET /tenants/:t/contacts/:c/history/export` | `src/http/contacts.ts:393` |

⚠️ **`numero.deconnecte` N'EST PAS DANS LA LISTE, et c'est un constat, pas un oubli** : aucune route ne
détache un numéro aujourd'hui. Tracer un geste qui n'existe pas produirait une action morte, c'est-à-dire
exactement le motif « offert-et-inerte » que ce produit s'interdit. À ajouter le jour où la route existera.

## 🔴 Ce que le `detail` a le droit de porter

La migration 0061 l'écrit noir sur blanc : « Détail NON identifiant : compteurs, ancienne et nouvelle valeur
d'un drapeau, motif. **Jamais de numéro.** » Cette table n'est jamais purgée par le balayage de rétention des
contacts : **y écrire une donnée personnelle la rendrait ineffaçable**, et annulerait l'effacement qu'une
autre ligne du même journal certifie.

Concrètement : on écrit le RÔLE avant et après, pas l'email ; l'identifiant interne d'un webhook, pas son URL
complète ; le NOMBRE de messages exportés, pas leur contenu. ⚠️ `actor_email` est l'exception, elle est
DÉNORMALISÉE exprès pour rester lisible après le départ du collaborateur (décision antérieure, migration 0061).

---

## Méthode de livraison

**Implémenteur par lot + revue humaine sur le DIFF**, et les quatre questions répondent dans ce sens :
**(1) la production emprunte ces chemins**, ce sont les routes d'administration ; **(2) c'est réversible**, un
journal en plus ne change aucun comportement, ce qui est le seul point qui allège ; **(3) les critères sont
mécaniquement testables** (une action produit une ligne) ; **(4) le code touché porte un invariant invisible**,
celui du `detail` non identifiant, qu'aucun compilateur ne voit et qu'un test doit tenir.

⚠️ **Pas de feature-loop** : le critère qui compte (« aucune donnée personnelle dans `detail` ») ne se vérifie
pas en regardant passer des tests verts, il se vérifie en relisant ce qu'on écrit.

**Trois lots, un commit chacun**, chacun testé par MUTATION dans les deux sens :

1. **Les identités** : utilisateurs (4 actions), clés d'API (2), connexion échouée (1).
2. **Les sorties vers des tiers** : webhooks sortants (4), connecteurs (3).
3. **Le reste** : numéro connecté (1), export d'un contact (1), et la garde du `detail`.

### 🔴 L'essai réel qui clôt cette feature

Aucun test ne remplace le fait de LIRE l'écran. Julien invite quelqu'un, change son rôle, crée puis révoque
une clé d'API, et ouvre Sécurité > Audit : les quatre lignes doivent y être, avec le bon auteur et le bon
horodatage. ⚠️ Et il vérifie **qu'aucune ne porte d'email ni de numéro** ailleurs que dans `actor_email`.
