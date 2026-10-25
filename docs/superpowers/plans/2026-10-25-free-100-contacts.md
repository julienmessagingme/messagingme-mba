# La Free ne gère jamais plus de 100 contacts, quelle que soit leur origine : plan

> **Pour un agent** : un implémenteur, puis UNE relecture indépendante du diff. Les étapes se cochent (`- [ ]`).

**La décision de Julien (2026-10-25)** : « 100 contacts max gérés, quelle que soit l'origine de la conversation : l'import
et les conversations entrantes, pas plus de 100, sinon on ne gagnera jamais d'argent avec le Pro ; on simplifie, jamais
plus de 100 clients différents. Si quelqu'un essaie de parler alors que le client en a déjà 100, tant pis, il faut juste
l'alerter qu'il est plein. » Portée : **la Free seulement** (sa réponse du même jour) ; le Pro et l'Entreprise ne
changent pas (les fiches nées d'un message entrant n'y comptent pas, l'entrant n'y est jamais refusé).

**Aujourd'hui** : une fiche née d'un message entrant (`contacts.ne_entrant`, migration 0218) ne compte pas
(`FICHE_COMPTEE`, `src/crm/contact-store.pg.ts`) et l'entrant n'est jamais refusé (`upsertFromInbound`, puis
`recordInbound`, l'avance des scénarios, l'agent IA). Aucun espace n'a plus de 60 fiches vivantes (lu en base le
2026-10-25) : la règle ne coupe personne au déploiement.

## Méthode de livraison

**Implémenteur, une relecture indépendante du diff, puis déploiement**, parce que la règle touche la réception des
messages, le chemin le plus chaud du produit : un filtre mal posé ferait perdre les messages de clients existants, ce
qu'aucun écran ne montrerait. Pas de migration (`ne_entrant` existe). **Essai réel qui clôt** : un espace Free de test
amené à 100 contacts ; un message d'un téléphone inconnu n'entre pas (ni fiche, ni conversation, ni réponse de l'agent) et
l'administrateur reçoit l'alerte ; un contact déjà présent écrit et tout marche comme avant ; un STOP d'un inconnu est
quand même retenu.

## Ce qui change

1. **Le compte, en Free** : toute fiche vivante compte, née d'un entrant ou non. Le prédicat de `verifierPlaceContacts`,
   `placesContacts` et `PgOffreStore.usage` (ce que voient la console et `get_plan`) dépend donc de l'offre : en Free,
   `FICHE_ACTIVE` ; ailleurs, `FICHE_COMPTEE` comme aujourd'hui. Un seul point décide (`toutesOrigines(offre)` ou la
   limite rendue avec ce drapeau), jamais deux listes à tenir alignées. Les courriels de franchissement à 80 % et 100 %
   (`src/emails-produit/alertes.ts`) comptent de la même façon.
2. **L'entrant d'un inconnu, en Free pleine** : écarté AVANT `processInbound`, comme le filtre des numéros déliés
   (`src/webhooks/numeros-delies.ts`) : ni fiche, ni conversation, ni message, ni avance de scénario, ni agent IA, ni
   automation. Un inconnu = aucune fiche vivante pour ce `wa_id` (numéro ou BSUID, `MATCH_BY_WAID_SQL`). Le message
   est journalisé sans le numéro en clair. Mêmes règles sur les trois portes d'entrée : la réception de Meta, celle de
   360dialog si elle a son chemin, et la filière application (`traiterEntrantApplication`).
3. **Un STOP passe toujours** (choix de Claude, à confirmer par la relecture) : un inconnu qui écrit STOP à une Free
   pleine naît `opted_out`, même au-delà de 100 ; sinon, importé plus tard par Claude (consentant par principe), il
   recevrait des messages après avoir dit STOP. Une fiche `opted_out` ne reçoit rien et ne débloque rien.
4. **L'alerte** : un courriel aux administrateurs, `espace_plein_entrant`, au plus un par jour et par espace (occasion
   `plein:<jour>`) : « Un nouveau client vous a écrit sur WhatsApp, mais votre espace Free a déjà ses 100 contacts : son
   message n'est pas entré dans Messaging Me. Passez au Pro pour recevoir tous vos clients, ou supprimez des contacts
   dont vous n'avez plus besoin. » Le texte exact suit le catalogue (`src/emails-produit/catalogue.ts`).
5. **Les autres créations, en Free pleine, refusent déjà** (import, API, console, Shopify, envoi par Claude) : elles
   comptent désormais aussi les fiches nées d'un entrant. L'écho de l'application (coexistence, lot 2, tâche 5) suit
   la même règle : à la limite, rien n'est enregistré et l'administrateur est alerté.
6. **Les textes** : `features.md` (les limites de la Free), `documentation.md`, la réponse de `get_plan` et
   `get_setup_state` si elles parlent des contacts ; la FAQ, la page Tarifs et la fiche « Choisir mon offre » sont à la
   session Vitrine (annoncé).

## Tests attendus

- Free à 100 fiches dont 40 nées d'un entrant : `verifierPlaceContacts` refuse une 101e création ; Pro dans le même
  état : accepte (les 40 ne comptent pas).
- Free pleine : un entrant d'un inconnu est écarté, aucun appel à `upsertFromInbound`, `recordInbound`, l'avance ni la
  remise ; l'alerte part une fois, pas deux le même jour ; un entrant d'un contact connu passe intact.
- Free pleine : un STOP d'un inconnu crée la fiche `opted_out` et rien d'autre ; Pro plein (5 000) : l'entrant d'un
  inconnu passe comme aujourd'hui.
- `usage` rend le vrai compte en Free (entrants compris), l'ancien ailleurs.
- La filière application suit la même règle (un test sur `traiterEntrantApplication`).
- Chaque garde vérifiée dans les deux sens.

## Déploiement

Serveur seul (pas de migration, pas de console) : CI lue job par job, `up` de l'API et des workers, puis du service de la
filière application si son entrée change, garde de révision dans chaque commande. Puis l'essai réel.
