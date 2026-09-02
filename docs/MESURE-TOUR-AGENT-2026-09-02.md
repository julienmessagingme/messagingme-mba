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

🔴 **Et le vrai plafond n'est pas là.** À 200 conversations avec un message toutes les 60 s, on est à
3,3 tours/s x 3 000 tokens, soit environ **600 000 tokens par minute** vers le Gateway. Les limites d'un
gateway s'expriment presque toujours en tokens par minute : **c'est ce chiffre-là qu'il faut confronter à
notre plan Vercel**, pas le nombre de requêtes simultanées. C'est la prochaine mesure à faire, et elle demande
soit la documentation du plan, soit d'aller chercher un 429.

## Ce que ces mesures ne disent PAS

- **Elles portent sur des questions courtes et un corpus de 17 fiches.** Un client avec 500 fiches de
  connaissance verrait des résultats d'outils bien plus gros, donc des tours plus chers. Le banc prend le
  corpus par chemin : le rejouer avec un gros corpus est une commande, pas un développement.
- **Elles ne mesurent aucune concurrence.** Les tours sont joués les uns après les autres. Elles donnent la
  durée d'un tour SEUL, ce qui est l'entrée de la loi de Little, pas sa vérification.
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
