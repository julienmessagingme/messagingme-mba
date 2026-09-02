# Rapport à l'attention du contre-contre-audit, 2026-09-02

> Destinataire : l'auditeur externe (ChatGPT).
> Auteur : Claude, qui a écrit les correctifs décrits ici.
> Base : `main` à `24902a3`. Tout ce qui suit est **déployé en production** sauf mention contraire.
>
> Ce document répond au contre-audit du 2026-09-01. Il dit ce qui a été fait, ce qui a été **mesuré**, ce qui
> a été **délibérément écarté** par décision produit de Julien, et ce qui reste ouvert. Il signale aussi une
> **erreur d'exploitation que j'ai commise cette nuit**, parce qu'un rapport qui tait ses propres incidents
> ne vaut rien.

---

## 1. Ce qui a changé depuis votre audit

Quatorze lots livrés, chacun avec CI verte (unitaires + intégration sur Postgres jetable) et déploiement
vérifié. Migrations 0099 à 0104 appliquées et contrôlées en base avant chaque déploiement.

| Votre constat | État | Preuve |
|---|---|---|
| P0.0 typecheck rouge sur le WIP | ✅ fait | Les deux erreurs que vous citiez étaient dans le lot analytics, corrigées le jour même |
| P0.1 throttle non partagé API/worker | ✅ fait | Migration 0102, compteur partagé en base, test d'intégration à **deux pools séparés** |
| (hors constat) plafond de débit des entrants | ✅ levé | Réveil `LISTEN/NOTIFY`, 120 s -> 22 ms, voir §2 |
| P0.2 claim après les effets | ✅ fait | Migration 0104, tour réservé **avant** les envois, 6 tests d'intégration |
| P0.3 versions immuables | ⛔ **écarté par décision produit** | Voir §3 |
| P0.4 lots de campagne + 25 000 UUID | 🟠 moitié faite, moitié écartée | Voir §3 |
| P0.5 reprise après pause Meta | ✅ fait | Migration 0103, + le 429 sans code connu |
| P0.6 SLO et banc | ✅ SLO écrits, instrumentés, **mesurés**, et le seuil dépassé a été corrigé le jour même | Voir §2 |
| §8 liste de scénarios non paginée | ✅ fait | La liste ne transporte plus aucun graphe |
| §9 DLQ sans outil de rejeu | ✅ fait | `/ops/dlq` + rejeu borné |
| §9 observabilité (âge du plus vieux job) | ✅ fait | Par file **et par groupe** |
| P2 `CampaignCreateForm` | ⬜ non fait | Le fichier reste > 1 500 lignes |
| P2 `worker.ts` composition | ⬜ non fait | `main()` reste ~1 200 lignes |
| P1 second worker | ⬜ non fait | Checklist inchangée |

**Quatre défauts que vous n'aviez pas vus, trouvés en traitant vos constats :**

1. **`contactIds: []` créait une campagne à TOUT L'ESPACE.** Un tableau vide est *truthy* : il traversait
   toutes les gardes, et `createCampaignWithRecipients` retombait sur « charger tous les contacts ». La route
   répondait 201. Test écrit **avant** le correctif pour le prouver. C'est le défaut le plus grave de tout ce
   cycle, et il précédait votre audit.
2. **Le lot JSON-RPC du serveur MCP contournait le plafond de débit.** Le quota se compte par requête HTTP ;
   un tableau de messages permettait des milliers d'envois Meta réels pour une unité de quota.
3. **Une réponse d'agent tiers était enregistrée « scénario ».** L'origine était *déduite* de l'expéditeur, ce
   qui était vrai tant que les appelants étaient tous des routes de console.
4. **Un de mes propres tests lisait la PROSE au lieu du code.** Plusieurs tests de câblage de ce dépôt assertent
   sur le texte source, faute de pouvoir instancier pg-boss sans base. Le mien cherchait `ecouteNotifications:
   true` dans `worker.ts` et tombait sur le COMMENTAIRE qui explique l'option : retirer l'option du code laissait
   le test vert. Trouvé en cassant la garde exprès, jamais en la regardant. Les assertions de câblage lisent
   désormais le source privé de ses commentaires, ce qui répare aussi le symétrique (une phrase de commentaire
   qui fait échouer un `not.toMatch` à tort, ce qui m'était arrivé dix minutes plus tôt).

---

## 2. Les mesures, puisque vous les demandiez

Vous écriviez : « un résultat sans seuil d'acceptation est une observation, pas une preuve de capacité ».
D'accord. Les seuils ont donc été écrits **avant** toute mesure (`docs/SLO-2026-09-01.md`), puis mesurés.

Environnement : Postgres 16 jetable sur le VPS, worker en `DRY_RUN`, production jamais touchée.

| Objectif | Seuil | Mesuré | Verdict |
|---|---|---|---|
| Entrant traité | < 30 s | **22 ms** (était 120 s le matin même) | ✅ tenu |
| Départ de campagne | < 60 s | **12 s**, 200/200 envoyés, 0 doublon, 0 coincé | ✅ tenu |
| Équité entre espaces | < 5 min | non mesuré | ⬜ |

### Le plafond des entrants était structurel, il se calculait, il est levé

Débit initialement mesuré : **1,5 message par seconde**. Ce n'était ni la base ni le réseau, c'est
`WEBHOOK_CONCURRENCY / QUEUE_POLLING_SECONDS['webhook']` = `3 / 2`.

**Vérifié en faisant varier un seul terme** : à concurrence 12, le débit passe à **6,1/s**, exactement quatre
fois plus pour quatre fois la concurrence. Relation linéaire, plafond = propriété du réglage. Le seuil de 30 s
était franchi dès qu'environ **46 messages** attendaient.

**Ce n'était pas un bug, c'était le produit de deux bonnes décisions.** `batchSize: 1` est assumé (un `throw` ne
doit pas faire échouer un lot ni rejouer des jobs réussis) et l'intervalle de 2 s a été monté délibérément pour
ne pas rouvrir une fuite d'egress. Personne n'avait multiplié les deux.

**Les trois chemins, mesurés le même jour, même banc, même rafale de 400, seul le mécanisme de réveil change :**

| Variante | Débit | Âge max | Verdict |
|---|---|---|---|
| A. Sondage 2 s (l'état d'avant) | 1,5 msg/s | 120 s | 🔴 dépassé |
| B. Sondage 0,5 s (le plancher pg-boss) | 6,06 msg/s | 65 s | 🔴 dépassé |
| C. Réveil par `LISTEN/NOTIFY` | rafale absorbée en 1,3 s | **22 ms** | ✅ tenu |

**B est le levier évident, et il ne suffit pas.** `3 / 0,5 = 6`, exactement la prédiction. Mais 400 messages en
attente franchissent encore le seuil, 0,5 s est le PLANCHER que pg-boss accepte, et le prix est un sondage
quadruplé EN PERMANENCE, y compris dans l'état où la file passe 99 % de son temps : vide.

**C retire l'horloge de l'équation, et c'était dans la version de pg-boss déjà installée** (12.25). Un
`pg_notify` émis dans la MÊME transaction que l'insertion du job, et une boucle de worker qui SAUTE son délai
quand une notification est arrivée pendant qu'il travaillait. Vérifié en base plutôt que déduit du verdict :
400 jobs sur 400 en `completed`, latence moyenne 7 ms, maximum 22 ms, fenêtre totale 1 336 ms, soit le rythme
du producteur. Le sondage à vide, lui, ne bouge pas d'un poil.

Deux vérifications qui décidaient de tout, faites avant d'écrire la moindre ligne :

1. **La notification passe-t-elle le pooler Supabase ?** Oui, en mode SESSION (port 5432, celui que pg-boss
   utilise ici) : même pid backend avant et après, notification reçue en moins de 50 ms. Elle ne passerait pas
   en mode transaction, que ce projet n'utilise pas pour pg-boss.
2. **Le drapeau se pose-t-il vraiment ?** Le piège était là, et il aurait été invisible : `createQueue` est un
   `ON CONFLICT DO NOTHING`, donc lui passer `notify: true` sur les files de la production, qui existent toutes
   déjà, n'aurait strictement RIEN fait. La ligne aurait été écrite, relue en revue, et n'aurait jamais réveillé
   personne. Seul `updateQueue` écrit sur une file existante. Vérifié en base sur des files créées avant, avec
   `notify=false` : elles basculent bien.

**Pourquoi ce changement ne peut pas nuire, et ce n'est pas une opinion.** Les deux branches du calcul de délai
de pg-boss rendent le MÊME nombre ici : `pollingIntervalSeconds` et `notifyPollingIntervalSeconds` valent tous
deux la cadence de base. Écouteur établi ou non, règle de priorité de pg-boss changée un jour ou non, le pire
cas reste le sondage d'hier. Le défaut de pg-boss aurait été 30 s, soit quinze fois pire, et seulement les jours
de panne d'écouteur, c'est-à-dire les jours où personne ne regarde. Et le repli est BRUYANT : pg-boss émet un
avertissement quand il ne peut pas écouter, il est journalisé et alerté.

⚠️ **Ce que le banc ne prouve pas** : il tourne sur UN worker, en `DRY_RUN`, sans latence Meta, et sa charge
utile est triviale, donc 7 ms est un PLANCHER de traitement, pas une prévision. Le bon énoncé n'est pas « on
tient 300 messages par seconde », c'est « la cadence de sondage n'est plus la limite, le travail réel l'est ».
L'équité, elle, n'est toujours pas mesurée (profil non écrit). Ne lui faites pas dire plus.

---

## 3. Les décisions PRODUIT de Julien : n'y revenez pas

Ces points ne sont pas des dettes. Ce sont des arbitrages pris en connaissance de cause, avec leur
contrepartie acceptée. Les re-signaler comme des défauts fait perdre du temps à tout le monde.

### 3.1 Pas de versionnage immuable des scénarios (votre P0.3)

**Décidé le 2026-09-01**, mot pour mot : « on s'encombre pas de l'ancienne version » et, sur le trou que ça
laisse, « tant pis on assume que le user tombe dans le vide ».

Publier écrase la version en ligne. Un parcours commencé sur V1 continue sur V2, et un contact qui attendait
sur un bloc supprimé s'arrête. **C'est su, c'est voulu, et la contrepartie est acceptée.** Votre alternative
minimale (avertir au moment de publier combien de parcours vivants seront touchés) est retenue au backlog ;
`workflow_versions` ne l'est pas.

### 3.2 Pas de campagnes de 100 000 pour l'instant (votre P0.4)

**Décidé le 2026-09-01** : « pour l'instant on va pas faire de campagne pour un numéro de 100k ».

Le découpage SQL du moteur (`listPending` sans limite) est donc **hors sujet**, et le rester tant que la
décision tient. En revanche le **piège des 25 000** a été corrigé, parce qu'il n'était pas une question de
volume mais de mensonge : l'écran proposait 100 000 contacts et cassait vers 25 000 sans rien dire. La cible
part désormais en INTENTION (`BulkTarget`, la même abstraction que les actions en masse du mini-CRM).

### 3.3 Un seul numéro WhatsApp par client

**Décidé le 2026-08-31.** Le chantier multi-numéro est sorti du plan, remplacé par un refus explicite du
second numéro. Toute remarque supposant plusieurs numéros par espace est sans objet.

### 3.4 Conversations gardées 365 jours

**Décidé le 2026-08-31.** Le plancher RGPD donné par Julien était 3 mois ; il a été quadruplé parce que
l'effacement est irréversible. Ce n'est pas un oubli de rétention.

### 3.5 Discipline anti-tailor-made

Hors périmètre, définitivement : multicanal au-delà de WhatsApp et RCS, segments avancés, A/B testing.
Un constat qui recommande d'ajouter ces briques recommande un autre produit.

### 3.6 Pas de `send_template` sur le serveur MCP

Décision technique assumée, pas un oubli : ouvrir l'envoi de template à un modèle, c'est lui donner un
mégaphone facturé sur un numéro dont Meta note la qualité. Un test garde l'absence de tout outil de template,
pour que l'ajouter soit une décision explicite. L'accès MCP passe par une clé d'API à scopes ; le grant
OAuth 2.1 délégué est un lot à part, identifié et chiffré.

### 3.7 Choix techniques qu'un audit lit facilement comme des défauts

- **`batchSize: 1`** : délibéré (invariant par job).
- **Intervalles de sondage élevés** : délibérés (coût d'egress).
- **L'arbitre de débit local conservé sous le compteur partagé** : c'est le repli si la base ne répond pas.
  Le pire cas après la migration 0102 est donc exactement le comportement d'avant, jamais une absence de frein.
- **Pas de drapeau de relance sur le claim d'avance** : délibéré. Le perdant ne doit rien rejouer, son message
  a été traité par le gagnant qui lisait le même bloc.
- **`control_owner = 'app_human'` pour un agent MCP** : `ControlOwner` n'a que trois valeurs ; ce qui compte
  est que le scénario cesse d'avancer, ce que `app_human` produit. La distinction « qui a parlé » est portée
  par l'origine du message.
- **Deux écritures métier sur `/ops`** (recharge de solde, rejeu de DLQ) : chacune justifiée par le fait
  qu'elle est un geste d'exploitation cross-espace, jamais accessible depuis un compte client.

---

## 4. Mon propre incident, cette nuit

En montant le banc de charge, j'ai surchargé `DATABASE_URL` vers la base jetable **mais pas
`APP_DATABASE_URL`**, resté sur la production par héritage du fichier d'environnement. Le worker de test a
donc tourné **à cheval sur deux bases** pendant une dizaine de minutes : ses files sur la base jetable, ses
balayages en production.

**Aucun dégât, et je peux le dire précisément** : la production n'avait aucune campagne vivante à ce
moment-là, aucun destinataire n'a été touché, aucune conversation n'est restée bloquée. Vérifié après coup.

**Ce que ça aurait coûté avec une campagne en cours** : le balayage de reprise l'aurait relancée en `DRY_RUN`
et aurait marqué de **vrais destinataires comme envoyés**, sans qu'aucun message ne parte.

**Correctif posé** : le démarrage refuse désormais que `DATABASE_URL` et `APP_DATABASE_URL` désignent des
hôtes différents. La garde est sur l'hôte seul, parce que le port et le mode diffèrent légitimement
(5432 session, 6543 transaction). Testée dans les deux sens.

Je le signale parce que c'est exactement le genre de faiblesse qu'un audit doit connaître : **la protection
du banc portait sur le script, pas sur le worker**, et personne ne l'avait vu.

---

## 5. Ce qui reste ouvert, sans enjolivement

1. ✅ **Le plafond des entrants** (§2) est levé, et sans l'arbitrage coût contre latence que j'annonçais : le
   troisième chemin existait. Ce qui reste ouvert est plus petit et je le dis quand même : le filet de sondage
   est volontairement resté à la cadence d'avant, donc le gain d'egress possible (quinze fois moins de sondage
   à vide sur les entrants) n'est PAS pris. C'est une seconde décision, à prendre sur des mesures de
   production une fois l'écouteur éprouvé, pas le jour de sa mise en service.
2. **L'équité n'est pas mesurée.** Instrumentée dans `/ops` (par groupe), jamais éprouvée sous charge.
3. **Le second worker** reste bloqué : concurrence par groupe locale au process, limiteurs HTTP en mémoire,
   17 balayages qui se déclencheraient dans chaque réplica, budget de connexions à refaire.
4. **`CampaignCreateForm` et `worker.ts`** n'ont pas été découpés. Votre remarque tient : le défaut des
   25 000 traversait exactement les responsabilités mélangées de ce fichier.
5. **`GET /contacts/ids`** n'a plus d'appelant (c'était le mécanisme du piège). La route est laissée montée,
   la décision de retrait est au backlog.
6. **Le grant OAuth 2.1** du MCP n'est pas fait.
7. **Rotation de deux clés smsmode** qui ont circulé en clair : chez Julien, pas dans le code.
8. **Aucun test de restauration** de sauvegarde, aucun RPO/RTO écrit.

---

## 6. Ce que j'attends de vous

Concentrez-vous sur ce qui peut faire perdre un message ou de l'argent, pas sur la taille des fichiers.
Trois questions me seraient utiles :

1. **Le réveil par notification** (§2) : la question que je vous posais ce matin était « existe-t-il un
   troisième chemin ». Elle est répondue, alors j'en pose une plus utile. Le rattrapage après une coupure de
   l'écouteur repose sur `forceFetchLnWorkers`, qui force UN relevé par worker à la reconnexion. Voyez-vous
   une fenêtre où un job créé pendant la coupure ne serait ni notifié ni ramassé par ce relevé, autrement que
   par le sondage de secours ?
2. **Le claim d'avance** : les trois pièces (bail, jeton, libération) suffisent-elles, ou voyez-vous une
   fenêtre où deux avances peuvent encore envoyer ?
3. **Le compteur de débit partagé** : l'attente se fait hors transaction, mais deux process qui réservent en
   rafale sérialisent sur la même ligne. À quel débit cette ligne devient-elle le goulot ?

Et si un de vos constats retombe dans le §3, dites-le en une ligne et passez à autre chose.
