# Une échéance par requête pour l'aperçu et l'import d'un site : plan

**Origine :** `todo.md`, point « Un parcours de site n'a pas de durée maximale », relevé par la relecture du lot des
pages web le 2026-10-01 ; décidé par Julien le jour même.

**Mesuré avant d'écrire :**
- NPM ne pose aucun `proxy_read_timeout` (configuration de `api.` et de `mba.` lue sur le VPS le 2026-10-01) : c'est
  le défaut de nginx, 60 s sans réponse, qui coupe en premier. Cloudflare coupe à 100 s, et la console n'a aucun délai
  de son côté. Tout aperçu ou import plus long finit déjà en erreur pour le client, pendant que le serveur continue.
- Une page peut prendre une cinquantaine de secondes : 10 s par saut, quatre sauts, plus la résolution DNS (3 s au
  plus par saut). Un parcours ne compte dans ses cinquante pages que les pages LUES : sa durée n'a aucune borne.
- La lecture des pages a déjà son propre budget : 20 s cumulées par requête, dans le worker.

## Méthode de livraison

**En direct, puis UNE relecture indépendante du diff**, parce que le lot est petit (une échéance, deux routes, un
écran) et que son critère se vérifie par un test : sur un faux site lent, la réponse arrive à l'échéance avec ce qui
a été lu. Il touche pourtant des chemins de production (l'aperçu et l'import de la connaissance d'un agent), d'où la
relecture. Aucun workflow.

**Essai réel qui clôt la feature**, en production, par une sonde dans le conteneur `mba-api` : une adresse publique
lente, dont la lecture est coupée net par l'échéance de la requête ; et le parcours de la vitrine, entier et
inchangé, bien avant l'échéance.

## Tâches

1. **L'échéance** (`src/http/agent-knowledge.ts`) : 30 s de réseau par requête d'aperçu ou d'import, portées par un
   signal d'abandon. Choisie pour que le réseau, la résolution DNS et le budget de lecture tiennent ensemble sous les
   60 s de NPM (30 + 3 + 20, plus le démarrage du worker). Injectable par les dépendances de la route, pour les tests.
2. **La lecture d'une page reçoit le signal** (`fetchUrlBorne`, `src/lib/page-distante.ts`) : chaque saut s'arrête
   à la première des deux échéances, la sienne (10 s) ou celle de la requête. Facultatif : la FAQ ne change pas.
3. **`visiter` s'arrête quand le signal tombe** (`src/agent/crawl.ts`), et le dit (`tempsAtteint`), comme il dit déjà
   son plafond de pages.
4. **L'aperçu** rend `tempsAtteint`. **L'import** lit tant qu'il a le temps, écrit ce qu'il a lu, et rend les pages
   qu'il n'a pas eu le temps de lire (`restantes`).
5. **La console** (`web/components/AgentConnaissance.tsx`, `web/lib/api-agent-knowledge.ts`) : l'aperçu dit que le
   parcours s'est arrêté faute de temps ; l'import dit combien de pages restent et propose de les importer d'un clic.
   Les deux champs sont facultatifs : une console en avance sur l'API ne casse rien.

## Tests attendus

- `visiter` : un signal tombé arrête le parcours et le dit ; sans signal, rien ne change (la preuve inverse).
- `fetchUrlBorne` : une lecture en cours s'arrête quand le signal de la requête tombe.
- Routes : sur un faux site lent, l'aperçu répond à l'échéance, et non à la fin du parcours, avec `tempsAtteint`, et
  la lecture en cours est bien interrompue ; l'import écrit les pages lues et rend les autres dans `restantes`.
- e2e (`web/e2e/agents-connaissance.spec.ts`) : le message de l'aperçu, et le bouton qui importe les pages restantes.

## Ordre de déploiement

Aucune migration, aucun ordre imposé : la console (Vercel, au push) tolère l'absence des deux champs, et l'ancienne
console ignore leur présence. CI lue job par job, `up -d --build`, fumée publique, puis l'essai réel.
