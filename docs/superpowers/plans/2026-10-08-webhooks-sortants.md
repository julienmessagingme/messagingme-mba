# Lot 12 : les webhooks sortants, plan

Spec : `docs/superpowers/specs/2026-10-08-webhooks-sortants-design.md` (décisions de Julien du 2026-10-08). Plan
court : tâches, interfaces, tests attendus, ordre de déploiement.

## Méthode de livraison

**Implémenteur par lot, puis une relecture indépendante du diff par livraison** : le lot touche des chemins que la
production emprunte (chaque accusé et chaque message entrant passent par l'émetteur, la remise d'un message entrant
change de branche en livraison B), il appelle des adresses saisies par des clients, et il porte des invariants
invisibles (purge RGPD, cascade de la suppression d'un espace, files déclarées, ordre migration puis code). Les
critères se vérifient par des tests, mais le rayon de souffle demande un œil.

Deux livraisons, chacune relue puis déployée avant la suivante. Chacune se clôt par un essai réel sur une vraie
adresse (A : l'essai puis un vrai message entrant, signature vérifiée par l'exemple de la doc ; B : une application de
test qui reçoit `needs_reply` et répond au client WhatsApp par l'API).

## Livraison A : les webhooks sortants

1. **Migration 0223** (`evenements_sortants`) : `adresses_evenements` (espace en cascade, URL, description, types
   abonnés, secret chiffré, secret précédent chiffré et sa fin de validité, active, créée le, par) et
   `envois_evenements` (espace en cascade, adresse en cascade, `id` d'événement, type, contact nullable sans clé
   étrangère bloquante, corps figé, statut à trois valeurs, tentatives, dernier code, extrait de réponse, prochain
   essai, créé le, livré le) ; index de la lecture du journal par adresse et date, et de la purge par date. Aucune
   clé en `restrict`.
   - Tests : une migration lue par un test (CHECK, cascades), purge RGPD et suppression d'espace qui nomment les deux
     tables (intégration, en CI).
2. **Le contrat** (`src/evenements/types.ts`) : les types pointés, la traduction un pour un depuis les noms `em_*`,
   l'enveloppe, le schéma Zod `.strict()` de chaque `data`, les types décochés par défaut.
   - Interfaces : `TYPES_EVENEMENTS`, `typeDuSignal(nom)`, `enveloppe(...)`, `schemaEnveloppe`.
   - Tests : parité avec la page de doc ; chaque signal a son type ; aucun type orphelin.
3. **La signature** (`src/evenements/signature.ts`) : Standard Webhooks, secret `whsec_`, deux signatures pendant une
   rotation.
   - Tests : le vecteur de test publié par Standard Webhooks, vérifié par notre fonction ; une rotation signe deux
     fois ; un secret périmé ne signe plus.
4. **La destination** : `DestinationSignaux` gagne `accepte(nom)` (défaut : tout, Batch inchangé) ; la destination
   « événements » lit les espaces qui ont une adresse active, à travers le cache court existant. `message.received`
   porte le texte : le signal `em_replied` gagne un champ facultatif que Batch ignore.
   - Tests : Batch reçoit exactement ce qu'il recevait (non-régression) ; un espace sans adresse n'enfile rien.
5. **La distribution et l'envoi** (`src/evenements/distribution.ts`, `envoi.ts`) : deux files neuves dans
   `BASE_QUEUES` et leurs tableaux ; la distribution complète, fige et écrit une ligne par (événement, adresse), gèle
   les adresses au-delà de l'offre (plus anciennes actives) ; l'envoi passe par `fetchPublic`, 10 s, corps borné,
   aucune transaction pendant l'appel, vérifie l'espace verrouillé, programme l'essai suivant (30 s, 2 min, 10 min,
   30 min, puis toutes les heures jusqu'à 24 h), arrête sur 410.
   - Tests : calendrier des réessais ; 2xx livre, 500 et panne réseau réessaient, 410 arrête ; adresse interne
     refusée (inventaire de `lib-adresse-privee`) ; un espace verrouillé n'envoie rien ; une adresse gelée par l'offre
     ne reçoit rien ; le corps d'un réessai est celui de la première tentative.
6. **La purge** : le journal par l'offre (`offre_de_l_espace`, 3 ou 30 jours), dans le balayage existant.
7. **Les routes de la console** (module `tenant`, admin en écriture) : lister, créer (secret rendu une fois), modifier
   les types, pause et réactivation, rotation, suppression, essai, journal paginé, rejeu unitaire, rejeu des échecs
   depuis une date (plafond coûteux) ; 402 `plan_limit_reached` à la création et à la réactivation ; audit
   `evenements.*` sans le secret.
   - Tests : isolation entre espaces (le test dynamique de `scope-tenant`), limite par offre, secret absent de toute
     lecture, auto-attaque verte.
8. **L'écran** `/developers/evenements` (« Webhooks sortants ») et les deux lignes de la page de l'offre.
   - Tests : e2e (créer, secret montré une fois, essai, journal, rejeu, limite en Base).
9. **Le MCP** : deux outils, créer une adresse (rend le secret une fois) et envoyer l'essai ; `OUTILS_MCP` et la
   parité.
10. **La doc** : la page publique (enveloppe, types, signature avec un exemple Node, réessais, dédoublonnage), et
    `features.md`, le journal, `wip.md`.

**Déploiement A** : la migration 0223, lue en base, puis l'API et les deux workers dans le même `up`, puis la console.
Contrôle public après le `up`. Essai réel : une adresse de test reçoit l'essai, puis un vrai message entrant, la
signature vérifiée par l'exemple de la doc.

## Livraison B : « mon application répond »

1. **Migration 0224** (`repondeur_application`) : `application` dans le CHECK des modes (reposé sous son nom),
   `tenant_settings.repondeur_adresse_id` en `on delete set null` vers `adresses_evenements`, CHECK à sens unique.
   - Tests : le test de 0217 figé sur ses quatre valeurs, un test pour la nouvelle.
2. **Le mode** : `MODES_REPONDEUR`, `modeEffectif` (adresse absente ou gelée : équipe), `sousLOffre`,
   `standbyPourNous`, la branche de la remise (`src/inbox/fil.ts`) qui enfile `conversation.needs_reply` vers
   l'adresse désignée sur une file notifiée tout de suite, le fil tenu par l'application et hors « À traiter ».
3. **La réponse** : sur un fil tenu par l'application, `POST /v1/messages/whatsapp` ne prend pas le fil ; ces envois
   ne comptent pas dans le quota quotidien.
   - Tests : la réponse de l'application laisse le fil à l'application (et le test inverse : en mode équipe, une
     réponse par l'API prend toujours le fil) ; quota non consommé ; aucun repli après un délai.
4. **La console** : le cinquième choix du répondeur et le choix de l'adresse ; `set_default_responder` prend
   l'adresse ; doc et `features.md`.

**Déploiement B** : 🔴 la migration 0224, puis l'API et les deux workers dans le même `up` (un ancien worker lirait le
mode inconnu comme « agent » ou « MBA »), puis la console, qui seule permet de choisir le mode. Essai réel : une
application de test reçoit `needs_reply`, répond par l'API, et le client WhatsApp reçoit la réponse.
