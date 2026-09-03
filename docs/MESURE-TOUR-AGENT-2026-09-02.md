# Mesure d'un tour d'agent réel, 2026-09-02

> Geste 4 du chantier IA. Trois passages du banc `scripts/mesure-tour-agent.mts` contre le **vrai** Gateway
> Vercel, modèle de production `zai/glm-4.7-flash`, avec le corpus Hyundai (17 modèles) comme base de
> connaissance. Aucune session d'agent ouverte, aucun crédit débité, rien écrit en base.
>
> Ces chiffres remplacent un raisonnement par une mesure. Ils en contredisent une partie.

## Les trois passages

| Passage | Prompt système | Ce qu'il éprouve |
|---|---|---|
| 1 | 1 398 car. | Corpus jamais injecté (défaut du banc, voir plus bas) |
| 2 | 1 398 car. | Corpus injecté comme **résultat d'outil**, comme en production |
| 3 | 3 986 car. | Corpus versé **dans le prompt système**, pour tester le seuil de cache |

## Ce que ça donne

| Mesure | Passage 2 (réaliste) | Passage 3 (préfixe long) |
|---|---|---|
| Allers-retours par tour | **2,0** | 1,75 |
| Durée moyenne d'un tour | **3,0 s** | 2,6 s |
| Durée maximale observée | **4,2 s** | 3,7 s |
| Tokens d'entrée par tour | ~3 000 | ~3 800 |
| Tokens de sortie par tour | ~130 | ~140 |
| Coût par tour | **~0,00026 $** | ~0,00032 $ |
| **Tokens servis depuis un cache** | **0** | **0** |

## 🔴 Ce qui est CONFIRMÉ, et ce qui est INFIRMÉ

**Confirmé : un tour n'est pas un appel.** Deux allers-retours en moyenne, et le second porte le résultat de
la recherche de connaissance, donc un contexte plus gros que le premier. La borne de six existe pour de bonnes
raisons, mais elle n'est pas atteinte sur des questions ordinaires.

**Confirmé : la durée d'un tour est de l'ordre de 3 secondes**, pas des 120 secondes du plafond. Le plafond
protège d'un incident, il ne décrit pas le cas normal, et c'est la durée normale qui décide de la concurrence.

🔴 **INFIRMÉ : le cache de prompt n'est pas le levier qu'on croyait.** Deux raisons, et la seconde est la plus
utile :

1. **`cached_tokens` vaut zéro dans les trois passages**, y compris sur des tours successifs portant un préfixe
   RIGOUREUSEMENT identique, et y compris avec un préfixe de 1 800 tokens, au-dessus du seuil habituel de
   1 024 des fournisseurs qui cachent implicitement. On n'a donc **aucune preuve d'un cache**, et aucun moyen
   de le voir depuis notre côté.
2. **Et surtout : notre préfixe constant est PETIT.** ~1 100 tokens sur ~3 000 par tour. Même un cache parfait
   n'économiserait qu'environ un tiers des tokens d'entrée, et seulement sur le premier aller-retour. Ce qui
   fait le volume, c'est le **résultat de la recherche de connaissance**, qui varie d'une question à l'autre
   et n'est donc pas cachable par nature.

**Conséquence pour le geste 5** (demander le cache explicitement) : il reste à faire, il est peu coûteux, mais
il **passe en basse priorité**. Il ne changera pas d'ordre de grandeur. Le raisonnement qui en faisait un
enjeu majeur supposait un prompt système lourd, ce que la mesure contredit.

## Ce que ces chiffres disent de la concurrence choisie (12 en vol, 4 par client)

Loi de Little, avec la durée MESURÉE de 3 secondes :

| Hypothèse de trafic | Tours en vol | 12 suffit ? |
|---|---|---|
| 200 conversations, un message toutes les 90 s | 6,7 | oui, largement |
| 200 conversations, un message toutes les 60 s | 10 | oui, de justesse |
| 200 conversations, un message toutes les 30 s | 20 | **non** |

**12 est donc le bon ordre de grandeur pour 200 conversations à cadence humaine**, et devient court si les
échanges s'accélèrent. C'est exactement pourquoi ce nombre est une variable d'environnement : le relever ne
demande pas de redéployer du code.

**Faut-il le monter à 20 tout de suite ?** Non, et c'est un choix, pas une hésitation. La mesure montre que 20
passe sans dégradation, donc la marge existe le jour où elle servira. Mais cette file **n'a jamais traité un
seul job en production** : monter un nombre pour un embouteillage qui n'existe pas ajoute du risque sans rien
résoudre. Ce qui justifierait de le relever est un signal, pas une intuition : des tours qui attendent leur
tour dans `/ops`. Le chiffre est en configuration précisément pour que ce jour-là ce soit une variable
d'environnement à changer, pas un déploiement.

## 🔴 LA LIMITE DU GATEWAY : cherchée dans la doc, introuvable, donc MESURÉE

**Ce que Vercel publie.** Rien sur un débit. La documentation de l'AI Gateway ne parle que de **budgets de
dépense**, et l'API de quotas interrogée avec notre vraie clé rend une liste **vide** : aucun budget n'est
configuré. Et une vraie réponse du Gateway ne porte **aucun en-tête de débit** (ni `x-ratelimit-*`, ni
`retry-after`), vérifié le 2026-09-02.

La spécification étant muette, on mesure. Quatre passages, en faisant tourner N tours EN MÊME TEMPS :

| Tours en parallèle | Tokens/minute obtenus | Tour moyen | Tour au PIRE | Échecs (429) |
|---|---|---|---|---|
| 1 (séquentiel) | ~60 000 | 3,0 s | 4,2 s | 0 |
| 12 (notre réglage) | **553 000** | 3,1 s | 5,9 s | **0** |
| 20 | **1 199 000** | 2,3 s | 4,5 s | **0** |
| 40, 1er passage | 188 000 | 3,9 s | **59,3 s** | 0 |
| 40, 2e passage | **1 090 000** | 3,3 s | 6,9 s | **0** |

**Ce que ça établit.**

1. 🔴 **Aucun 429, à aucun niveau, jusqu'à 40 tours simultanés et ~1,2 million de tokens par minute.** La
   limite du Gateway, s'il y en a une, est **au-dessus** de tout ce qu'on peut produire à 25 clients. Elle
   n'est donc pas le prochain plafond, contrairement à ce que ce document annonçait avant de mesurer.
2. **La latence ne se dégrade pas** en montant de 12 à 40. À 20, elle est même meilleure qu'à 12, ce qui dit
   surtout que le bruit entre deux passages dépasse l'effet de la concurrence dans cette plage.
3. **Notre réglage de 12 est très conservateur.** 20 est mesuré propre, et 40 aussi.

⚠️ **UN PASSAGE SUR DEUX À 40 A MONTRÉ UNE QUEUE SÉVÈRE** : un tour à 59 secondes, et un débit divisé par six
sur ce passage. Il ne s'est **pas reproduit** au second passage. J'ai failli en conclure « à 40, le débit
s'effondre » sur un seul échantillon, ce qui aurait été faux. **La conclusion honnête est qu'une queue rare et
sévère existe, pas qu'elle est systématique**, et c'est elle qu'il faut craindre : elle immobiliserait une
place de la file sans jamais lever d'erreur.

🔴 **La production est protégée là où ce banc ne l'était pas.** Chaque appel de production porte une échéance
de tour de **30 secondes** (`DEADLINE_MS`, passée en `AbortSignal`), que le banc ne passe pas : c'est pour ça
que le tour à 59 s a pu aller au bout ici. En production, il aurait été coupé à 30 s. Une place de file est
donc immobilisée **au plus 30 secondes**, jamais les 120 s du plafond HTTP.

## Ce que ces mesures ne disent PAS

- **Elles portent sur des questions courtes.** Un échange plus long fait grossir l'historique, borné à
  30 messages, ce que le banc ne joue pas.

🔴 **CORRECTION d'une affirmation de la première version de ce document.** J'y écrivais qu'« un client avec
500 fiches verrait des résultats d'outils bien plus gros, donc des tours plus chers ». **C'est faux, et le code
le disait déjà** : la recherche de connaissance rend au plus **3 fiches** (`FICHES_RENDUES`), chacune tronquée
à **2 000 caractères** (`CORPS_MAX`), et la requête est bornée à 512 caractères. Ce qui atteint le modèle est
donc plafonné à ~6 Ko **quelle que soit la taille de la base**. Un client avec 500 fiches paie exactement le
même contexte qu'un client avec 17. Le coût d'un tour ne grandit pas avec le corpus : c'est une propriété
délibérée du produit, et je l'ai contredite sans la vérifier.
- **Le banc ne passe pas l'échéance de tour de la production** (30 s en `AbortSignal`). C'est ce qui a laissé
  le tour à 59 s aller au bout. En production il aurait été coupé, donc le banc est ici PLUS pessimiste que
  la réalité, ce qui est le bon sens de l'écart.
- **Aucune mesure ne dure plus de dix secondes.** Une limite exprimée par minute ou par heure ne se verrait
  pas sur des rafales aussi courtes : ce qu'on a établi, c'est qu'il n'y a pas de plafond INSTANTANÉ sous
  1,2 million de tokens/minute, pas qu'aucun quota n'existe sur une fenêtre longue.
- **Zéro pour `cached_tokens` peut vouloir dire « pas de cache » ou « champ non rendu ».** On ne peut pas
  distinguer les deux depuis notre côté, et la conséquence pratique est la même aujourd'hui.

## ⚠️ Deux défauts du banc, trouvés en le faisant tourner

Ils valent d'être écrits parce que les deux produisaient un **chiffre faux plutôt qu'une erreur**.

1. **Le premier passage comparait le nom du HANDLER (`chercher_connaissance`) alors que l'outil est exposé au
   modèle sous son nom par défaut (`mba_chercher_connaissance`).** La recherche de connaissance n'était donc
   jamais reconnue, le corpus n'entrait jamais dans le contexte, et le banc annonçait ~1 100 tokens par
   aller-retour en croyant mesurer un prompt chargé. Le nom est désormais **dérivé du catalogue**.
2. **La première version fabriquait un objet d'outil à trois champs et le castait.** Le cast masquait
   exactement ce que le type disait : le banc plantait sur un champ absent. Les outils exposés portent
   maintenant leurs vrais libellés de catalogue, ce qui compte, leur schéma pesant dans chaque appel.

**La règle qui en sort** : un banc qui se trompe de mesure est pire qu'une absence de banc, parce qu'il produit
un chiffre, et qu'un chiffre a l'air d'une preuve.

## Comment rejouer

```bash
sudo docker compose run --rm --no-deps \
  -v /home/ubuntu/mba/scripts:/app/scripts:ro -v /home/ubuntu/hyundai/data:/corpus:ro \
  mba-api npx tsx scripts/mesure-tour-agent.mts /corpus/vehicules.json 5
```

Troisième argument `long` pour verser le corpus dans le prompt système. ⚠️ Le banc appelle le vrai Gateway :
il coûte quelques centimes.

## MESURE du 2026-09-03 : SIX MINUTES de charge soutenue, et pas dix secondes

Constat A4 de l'audit externe : les mesures du 2026-09-02 étaient des rafales de quelques dizaines de
secondes. **Une rafale plus courte que la fenêtre d'un plafond tient toujours**, quelle que soit la limite :
elle mesure la capacité d'un seau plein, pas le débit auquel il se remplit. Un plafond « par minute » ne peut
donc pas se voir en dix secondes.

Rejoué avec le mode DURÉE (`DUREE_S`), sur le VPS, dans le conteneur `mba-api` (la clé du Gateway n'existe
que là), douze tours en parallèle, modèle `zai/glm-4.7-flash`.

| | |
|---|---|
| Durée tenue | **361 s** (6 min) |
| Tours joués | **1 406** |
| Allers-retours | 2 827, soit **2,01 par tour** |
| Débit | **737 942 tokens / minute** |
| **Refus (429 ou autre)** | **0** |
| Coût total | 0,376 $ |

**Durée d'un tour** : p50 **2,4 s**, p95 **6,9 s**, p99 **11,7 s**.

### Ce que les six minutes montrent, et qu'une rafale ne montrait pas

| Minute | Allers-retours | Durée moyenne | Tokens | Refus |
|---|---|---|---|---|
| 0 | 425 | 1 445 ms | 661 418 | 0 |
| 1 | 338 | 2 422 ms | 541 493 | 0 |
| 2 | 358 | 1 831 ms | 564 114 | 0 |
| 3 | 563 | 1 389 ms | 882 418 | 0 |
| 4 | 534 | 1 340 ms | 836 972 | 0 |
| 5 | 596 | 1 217 ms | 937 069 | 0 |

**Aucune dérive.** La durée moyenne ne monte pas, elle DESCEND (1 445 ms à la première minute, 1 217 ms à la
sixième), et le débit monte au lieu de tomber. C'est le contraire exact de la signature d'un seau qui se vide :
un plafond par fenêtre se serait vu à la deuxième ou troisième minute, en refus ou en ralentissement. Il n'y
en a pas. **La conclusion du 2026-09-02 tient donc pour de bon** : à cette échelle, le Gateway n'est pas le
prochain plafond, et ce n'est plus une extrapolation depuis une rafale.

### Ce que la mesure longue a révélé en plus : la QUEUE

Le tour le plus long a duré **113 secondes**, contre 2,4 s de médiane. C'est un facteur 47, et il n'apparaît
pas dans une rafale courte. **0,14 % des tours** (2 sur 1 406) dépassent 30 secondes.

🔴 **C'est exactement ce que l'échéance de production protège.** `DEADLINE_MS = 30 000` dans `run-turn.ts`
n'est pas une précaution théorique : sans elle, deux conversations sur mille auraient pendu près de deux
minutes, en tenant leur place dans la file pendant tout ce temps. Le banc, lui, appelle le transport SANS
échéance, ce qui est précisément pourquoi il peut la mesurer. La queue existe, elle est rare, elle est bornée
par une garde qui était déjà là.

⚠️ **Le cache reste à zéro** (`part_cachee_pourcent: 0`) sur 2 827 allers-retours, ce qui confirme la mesure
du 2026-09-02 sur un échantillon cinquante fois plus grand. Le prompt système fait 1 398 caractères, soit un
préfixe trop court pour tout seuil de cache plausible.

