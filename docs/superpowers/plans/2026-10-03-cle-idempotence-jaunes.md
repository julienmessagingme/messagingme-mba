# Clé d'idempotence : les deux jaunes de comportement (2026-10-03)

La relecture du correctif de la clé coincée (`2026-10-03-cle-idempotence-coincee.md`, déployé en `0c476865`) n'a
trouvé aucun rouge et deux jaunes qui changent un comportement. Julien : « fais les deux jaunes de la clé
maintenant ».

## Méthode de livraison

**Implémenteur par lot + revue indépendante du DIFF**, parce que les deux touchent `POST /v1/sends`, un chemin que
la production emprunte et qui porte l'invariant « une clé désigne un seul envoi ». Une relecture indépendante en fin
de lot. L'essai réel qui clôt ce plan : le banc à deux copies remonté avec ce code, les épreuves `idempotence` et
`arret` brutale rejouées (chaque envoi y passe par la création confirmée), et le test d'intégration du magasin joué
contre son Postgres jetable, vérifié dans les deux sens.

## Les deux jaunes

1. **Plus aucune campagne sans la clé qui la désigne.** La relecture proposait de supprimer l'orpheline après coup
   et de repérer celles des copies tuées par un ménage périodique. Écarté, parce que rien ne distingue de façon
   fiable un envoi d'API d'un brouillon de la console (le préfixe de nom `[API] ` se tape à la main) : un ménage
   fondé dessus pourrait effacer le brouillon de quelqu'un. À la place, la cause : la campagne et le scellement
   de sa clé naissent dans UNE transaction (`PgCampaignRepo.createWithRecipientsSiConfirme`, `complete` recevant le
   client de cette transaction). Clé reprise ou copie tuée entre les deux, tout est annulé : il n'y a plus
   d'orpheline à supprimer, ni à repérer. Aucune migration, aucun balayage, et la création de la console ne bouge pas.
2. **Le bail ne libère qu'une pose du MÊME corps** (`request_hash is null or request_hash = <empreinte>`) : « même
   clé, autre corps » reste un 422 pendant toute la vie de la clé, comme la doc publique le promet.

## Ordre de déploiement

Aucune migration. Code relu, CI lue job par job, banc rejoué, puis `up` de `mba-api` seul (le worker ne lit ni
la route ni la création confirmée), accordé avec les sessions qui déploient aujourd'hui.
