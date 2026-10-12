# Campagnes Messaging Me

Ce vocabulaire décrit les campagnes créées dans un espace et les contacts qu'elles peuvent joindre.

## Langage

**Campagne** : Diffusion configurée pour un espace, qui peut être créée sans envoi puis lancée. Elle a un premier canal et peut prévoir des étages de repli.

**Audience** : Ensemble des contacts retenus pour une campagne ordinaire au moment de sa création. Il reste figé pour cette campagne, même si les contacts de l'espace changent ensuite.

**Campagne au fil de l'eau** : Campagne créée sans audience initiale, qui accueille des contacts provenant d'un webhook entrant tant qu'elle reste ouverte.

**Étage** : Tentative d'envoi sur un canal dans la chaîne d'une campagne. Un étage de repli prend la suite d'un envoi qui n'a pas abouti.
