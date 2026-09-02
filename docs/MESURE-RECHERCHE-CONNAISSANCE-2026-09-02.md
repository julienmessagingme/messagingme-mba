# Comment chercher dans la base de connaissance : ce que la mesure a tranché, 2026-09-02

> Julien : « en bornant à 3 fiches sur 500, tu renvoies potentiellement 1 % du contenu... faut vectoriser ! »
> Il avait raison, et mon objection (« le coût est déjà borné ») était l'argument inverse du bon : **plafonner
> à 3 fiches rend la qualité du tri PLUS critique, pas moins.**
>
> Ce document rend compte de quatre mesures faites contre le vrai Gateway. Deux d'entre elles ont **écarté** la
> solution que j'allais écrire.

## Le défaut, tel que le code le documentait déjà

La règle de pertinence actuelle (`ficheEstPertinente`) accepte une fiche sur trois motifs, tous **lexicaux** :
deux mots communs, ou la moitié d'une question courte, ou un titre proche au trigramme. Son commentaire dit :

> « une question sans le moindre mot commun ne fait remonter AUCUNE fiche, donc la sortie tombe de toute façon »

C'est présenté comme une garantie de sûreté, et c'en est une : l'agent ne peut pas halluciner. Mais c'est
**exactement** le défaut de Julien : « c'est combien pour résilier » et « Conditions de sortie de contrat »
n'ont **aucun mot en commun**. L'agent dit « je ne sais pas » alors que la réponse est dans la base.

## Mesure 1 : quel modèle d'embedding, en français

Six questions posées avec les mots d'un **client**, six fiches écrites avec les mots d'une **entreprise**,
aucun mot commun entre une question et sa fiche.

| Modèle | Dimension | Bonne fiche en 1er |
|---|---|---|
| **cohere/embed-v4.0** | 1536 | **6/6** |
| openai/text-embedding-3-small | 1536 | 5/6 |
| google/text-multilingual-embedding-002 | 768 | 4/6 |
| mistral/mistral-embed | 1024 | 4/6 |

Cohere gagne, et surtout **avec de la marge** : 0,225 d'écart au deuxième là où Google et Mistral placent la
bonne fiche deuxième à 0,02 et 0,009 près. Un premier rang à 0,009 près est un hasard, pas un choix.

## 🔴 Mesure 2 : aucun seuil de similarité n'est posable

J'allais écrire une quatrième règle de pertinence, « similarité ≥ X ». La mesure l'a interdite.

| | Vraies questions | Questions HORS SUJET |
|---|---|---|
| Score du meilleur candidat | 0,299 à 0,536 | jusqu'à **0,361** |
| Écart au deuxième | 0,036 à 0,230 | jusqu'à **0,105** |

**Une question hors sujet (« vous vendez des vélos électriques ? ») remonte une fiche à 0,361, soit PLUS HAUT
qu'une vraie question dont la bonne réponse est à 0,299.** Ni le score ni l'écart ne séparent les deux
populations.

Si j'avais écrit « similarité ≥ 0,30 = pertinent », l'agent aurait répondu sur les vélos avec une fiche
d'assurance. **La garde anti-hallucination, qui est la propriété la plus importante du produit, aurait sauté.**

**La raison est structurelle, pas un défaut du modèle.** Un embedding est un **bi-encodeur** : il encode la
question et la fiche séparément, puis compare. Son cosinus répond à « ces deux textes se ressemblent-ils »,
qui n'est pas la question posée, « cette fiche RÉPOND-elle à cette question ». Et le vectoriel rend **toujours**
un classement : il y a toujours une fiche « la moins loin ».

## 🔴 Mesure 3 : un reranker, lui, sépare

Un **reranker** est un cross-encodeur : il lit la question ET la fiche ensemble et rend un score de pertinence
calibré. Le Gateway en expose cinq.

| Modèle | Rang 1 | Vraies questions (min) | Hors sujet (max) | Seuil posable |
|---|---|---|---|---|
| **cohere/rerank-v3.5** | 6/6 | **0,0817** | **0,0409** | **OUI, entre 0,041 et 0,082** |
| cohere/rerank-v4-fast | 5/6 | 0,2733 | 0,3644 | non, ça se chevauche |

⚠️ **Le modèle le plus RÉCENT est le moins bon pour notre usage.** `rerank-v4-fast` laisse le hors-sujet
monter au-dessus des vraies questions. Prendre la dernière version par réflexe aurait reproduit exactement le
défaut qu'on cherchait à corriger.

## L'architecture qui en découle

Trois étages, et chacun fait ce qu'il sait faire :

1. **RAPPEL, large et pas cher.** L'union de ce qui existe (plein texte + trigramme, imbattable sur une
   référence produit ou un numéro de contrat) et de la recherche vectorielle (imbattable sur l'intention).
   On ne cherche pas la précision ici, on cherche à ne rien manquer.
2. **VERDICT, calibré.** Le reranker note les candidats et le seuil décide. C'est lui qui remplace la règle
   lexicale comme juge, et c'est lui qui garde la propriété anti-hallucination.
3. **BORNE, inchangée.** Les 3 meilleures fiches, tronquées à 2 000 caractères. Le contexte envoyé au modèle
   ne bouge pas d'un octet : ce qui change, c'est **quelles** fiches.

**Ce que ça coûte** : deux appels réseau de plus par recherche (vectoriser la question, puis reranker les
candidats), soit ~150 à 250 ms sur un tour mesuré à 3 secondes. Du bruit.

## Ce que ces mesures ne disent PAS

- **Le seuil de 0,041 à 0,082 vient d'UN corpus de six fiches et dix questions.** C'est un point de départ
  mesuré, pas une loi. Il doit être en configuration et re-mesurable, et l'écart, bien que d'un facteur deux,
  est mince en valeur absolue.
- **Les fiches d'épreuve sont propres et distinctes.** Une vraie base contient des fiches qui se ressemblent,
  des doublons, des textes tronqués au milieu d'une phrase.
- **Rien n'est mesuré sur un gros corpus.** Six fiches ne testent ni l'index vectoriel, ni le temps de
  recherche à 10 000 fiches.
- **La dimension 1536 fige la colonne.** Changer de modèle d'embedding oblige à recalculer les vecteurs de
  tous les clients. C'est un balayage, pas un drame, mais ça se décide une fois.
