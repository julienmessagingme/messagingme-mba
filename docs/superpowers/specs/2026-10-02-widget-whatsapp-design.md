# Le widget WhatsApp : conception

2026-10-02 · décisions de Julien, prises en cadrage le même jour.

Une bulle WhatsApp à poser sur le site d'un client. Le visiteur clique, WhatsApp s'ouvre avec un message déjà
écrit, il l'envoie. C'est lui qui parle le premier, donc la fenêtre de service de 24 h s'ouvre et aucun modèle
approuvé n'est nécessaire. Le widget sert **tous les clients de la console**, pas seulement le plugin Claude Code.

## Méthode de livraison

**Implémenteur par lot, avec revue humaine du diff.** La production emprunte ce chemin (un message client entre
par là), le lot crée une surface publique irréversible, et il porte des invariants qu'un test ne voit pas : la
stabilité d'une URL distribuée chez des tiers, et l'arbitrage entre deux réglages de répondeur. feature-loop ne
conviendrait pas : ses critères ne sont pas mécaniquement testables ici, l'essai qui compte se fait dans un
navigateur, sur un vrai site, avec un vrai téléphone.

## Ce que le lot engage, et qui ne se reprend pas

🔴 **UNE BALISE POSÉE CHEZ UN CLIENT EST UNE PORTE À SENS UNIQUE.** Dès qu'un client colle
`<script src="https://api.messagingme.app/widget/<id>.js" async></script>` dans son site, cette adresse doit
répondre pour toujours. La retirer, renommer la route ou changer la forme de l'identifiant casse le site de
quelqu'un, sans recours et sans que nous le sachions. C'est la même règle que les liens tracés `/r/:code`, et
elle se décide maintenant, pas au premier client.

Deux conséquences tenues par la conception : l'identifiant public est **opaque et immuable**, et le script est
injecté en `async`, de sorte qu'une panne de l'API fasse disparaître la bulle sans jamais bloquer le rendu de la
page qui l'héberge.

## 1. La surface publique

Une route `GET /widget/:id.js`, de classe d'accès `code-url` (`src/server.ts`, registre `modulesDeRoutes`),
comme `/r/:code` et `/w/:code` : un code opaque dans l'adresse autorise l'appel, sans session.

Elle rend du JavaScript, **la configuration écrite dedans**. C'est le choix structurant : une balise de script ne
déclenche aucun contrôle CORS, donc le widget fonctionne sur n'importe quel site sans que `CORS_ORIGINS` soit
touché, et cette liste blanche, qui refuse `*`, reste intacte. L'alternative (un script statique qui irait
chercher sa configuration par `fetch`) obligerait à ouvrir l'API à toutes les origines : elle est écartée.

⚠️ **Rien de secret ne voyage dans ce script, et c'est vérifiable** : il porte le numéro WhatsApp (que Meta
affiche publiquement), la phrase, et l'apparence. Aucune clé, aucun identifiant d'espace, aucun jeton. Un test
garde cette propriété, parce qu'un champ ajouté par distraction y serait lisible par tout le monde.

**Cache de 60 secondes.** Assez pour absorber le trafic d'un site, assez court pour qu'un changement de couleur
se voie presque tout de suite. Un cache long ferait croire le réglage cassé. Une réponse de REPLI (lecture en
panne, budget épuisé) part en `no-store` : une bulle absente pour une raison passagère ne doit pas le rester.

**Plafond de débit** sur la route, comme les autres routes publiques, avec `0` qui le désactive (convention du
dépôt). La bulle ne poste rien : elle ne fait que se charger, puis ouvrir WhatsApp. ⚠️ **Le lot 2 n'en pose
qu'une moitié** : le frein des codes jamais vus (`CODES_INCONNUS_PAR_MINUTE`, comme `/w/:code`), qui borne
l'énumération, puisqu'un code inventé coûte une lecture en base. Il n'y a PAS de plafond par code : un vrai widget
est chargé à chaque vue d'une page de son site, et un plafond y refuserait des visiteurs réels, exactement comme
`/r/:code`. Ce que coûte un site très fréquenté (deux lectures par chargement non mis en cache) reste une question
ouverte, en bas de cette page.

**Rien ne s'affiche (code inconnu, mal formé ou vide, widget éteint, lecture en panne) : 200 et un script inerte**,
le même dans tous les cas. Jamais une 5xx, ni même un 4xx : la réponse s'exécute dans la page d'un client, où une
erreur se lirait dans SA console. L'auto-attaque déclare cette exception au 404 de la classe `code-url`.

## 2. Les données

Une table `widgets`. 🔴 **LE NUMÉRO SE LIT AU MOMENT D'ÉCRIRE LE FICHIER, JAMAIS DANS CETTE SPEC.** Au
2026-10-02, `origin/main` porte jusqu'à **0198**, donc la prochaine libre est 0199 ; mais cette spec a été
rédigée sur un arbre local en retard de 153 commits, qui s'arrêtait à 0183, et elle a d'abord annoncé 0184. Le
dossier `db/migrations/` **d'origin** tranche sur ce qui est PRIS, la base sur ce qui est APPLIQUé, et le
compteur du `CLAUDE.md` ne fait foi ni pour l'un ni pour l'autre.

| Colonne | Rôle |
| --- | --- |
| `id` | clé technique |
| `tenant_id` | l'espace, `on delete cascade` |
| `code` | l'identifiant PUBLIC, opaque, immuable, celui de l'URL |
| `nom` | pour que le client s'y retrouve quand il en a plusieurs |
| `phrase` | le texte pré-rempli, UNIQUE par espace |
| `devenir`, `agent_id`, `workflow_id` | qui prend la conversation (section 3) |
| `couleur`, `position`, `libelle`, `avatar_url` | l'apparence, bornée |
| `badge` | afficher « Propulsé par Engage Me » |
| `actif` | le client peut l'éteindre sans retirer la balise de son site |

**Plusieurs widgets par espace**, pour qu'un site vitrine, un blog et une page tarifs portent chacun leur phrase,
donc leur source.

🔴 **LA PHRASE EST UNIQUE PAR ESPACE, et ce n'est pas du confort** : c'est elle qui permet de reconnaître, à
l'arrivée d'un message, par quel widget le visiteur est passé. Deux widgets partageant une phrase rendraient la
source indécidable et feraient appliquer le mauvais devenir. L'unicité se pose en base, par un index, pas dans le
code : c'est exactement ce que `channelsme_links` fait depuis la migration 0116.

⚠️ **La phrase est PUBLIQUE**, lisible dans le script par n'importe qui. Quelqu'un peut donc l'envoyer
directement sans passer par le site. Ce risque est déjà accepté pour les liens de chaîne, dont la phrase circule
dans des posts publiés ; il n'est pas aggravé ici. Il interdit en revanche d'y mettre quoi que ce soit de
confidentiel, et il justifie le plafond horaire de la section 6.

## 3. Qui répond, et pourquoi il n'y a jamais deux règles

Le widget porte son propre réglage (décision de Julien) : **agent IA, agent de Meta, ou scénario**. Le motif est
déjà dans le dépôt, c'est `campaign_etages.devenir` (migration 0144), qui décide de la même chose quand un
contact répond à une campagne. On le recopie, avec ses garde-fous :

- `devenir` : `agent`, `mba`, `scenario`, ou **`null`** ;
- `agent_id` renseigné seulement si `devenir = 'agent'`, `workflow_id` seulement si `devenir = 'scenario'`, les
  deux par un CHECK **à sens unique** : `agent_id is null or devenir = 'agent'`. L'inverse serait faux, parce que
  `devenir = 'agent'` avec un `agent_id` à null est un état ATTEIGNABLE, celui d'un agent supprimé après coup, et
  le refuser ferait échouer la suppression d'un agent sur une contrainte de widget ;
- clés étrangères en `on delete set null` : une cascade détruirait le widget d'un client parce qu'il a supprimé
  un scénario, donc casserait la bulle sur son site.

🔴 **`null` EST LE CAS QUI ÉVITE LA SECONDE VÉRITÉ.** Le réglage « qui répond au client » existe déjà au niveau
de l'espace et gouverne tout le reste du produit. Le widget ne le remplace pas : il le **surcharge pour les
conversations qu'il amène**, et seulement à l'arrivée. `devenir = null` veut dire « ce que l'espace a décidé »,
ce qui couvre aussi le cas d'un humain qui répond, que les trois valeurs ne savent pas exprimer.

**La décision se prend UNE FOIS, à l'entrée.** Quand un message arrive et que son texte porte la phrase d'un
widget, le devenir de ce widget s'applique à cette conversation, puis les règles habituelles du fil reprennent
(`src/inbox/fil.ts`). Il n'y a donc pas deux règles en concurrence sur un même message : il y a une décision
d'entrée, puis le fonctionnement normal.

⚠️ **Le devenir `scenario` démarre DIRECTEMENT dans le chemin de réception, pas par une automation compagnon**
(décision de Julien du 2026-10-02, contre la recommandation d'une automation compagnon comme les liens de chaîne).
Le démarrage passe par le MÊME chemin que le runner d'automation, avec ses gardes (contact bloqué, anti-rebond,
plafond horaire, garde du fil), sans les recopier : une automation équivalente est construite en mémoire. D'où une
table de tirs propre au widget (`widget_tirs`, migration 0201), `automation_fires` référençant `automations(id)`.
🔴 Elle porte un `wa_id`, donc la purge RGPD la nomme : la migration est BLOQUANTE et passe AVANT le code.
Conséquence à tenir : supprimer un scénario utilisé par un widget doit être refusé ou rendre le widget inerte,
jamais détruire le widget.

🔴 **Le scénario du widget REPREND le fil à l'agent de Meta, et le laisse à un opérateur** (décision de Julien du
2026-10-02, lot 3b du plan). Sans la reprise, sur tout espace où l'agent de Meta tient le fil, le devenir
`scenario` ne démarrerait jamais. C'est le comportement de la publicité, pour la même raison : c'est le visiteur qui
déclenche, en cliquant. L'automation en mémoire porte donc le propriétaire `POSSESSEUR_WIDGET`, nommé dans
`reprendLaMain` et dans `epargneLOperateur` (`src/automation/match.ts`), et un entrant en `standby` démarre comme
les autres.

## 4. L'écran de la console, et le MCP par-dessus

L'écran est la source : apparence, phrase, devenir, **aperçu en direct** de la bulle, et le code à copier. Les
trois outils MCP (`create_widget`, `update_widget`, `list_widgets`) appellent **les mêmes routes** que l'écran.
Un seul comportement, deux portes : c'est ce qui évite qu'un widget créé par Claude Code diffère d'un widget créé
à la main.

**L'apparence est bornée** : couleur, position (quatre coins), libellé, avatar. Pas de CSS libre. Une bulle
injecte du style dans une page que nous ne connaissons pas ; ce qui s'y affiche mal nous revient en support, et
un CSS libre rendrait le badge trivial à masquer.

**Le badge « Propulsé par Engage Me »** s'affiche en offre Base et disparaît en Pro.

## 5. Le visiteur, selon son appareil

- **Mobile** : la bulle ouvre WhatsApp sur une conversation avec le numéro de l'espace, message pré-rempli. Le
  lien se fabrique avec `lienWaMe` (`src/lib/wa-me.ts`), **déjà écrit, déjà testé, module pur**, appelé par la
  route et jamais refabriqué dans le navigateur. Il porte les deux pièges qu'on ne veut pas réapprendre : le numéro
  arrive tel que Meta l'affiche et doit être réduit à ses chiffres, et le texte doit être encodé sinon il est
  tronqué au premier espace, ce qui couperait la phrase et empêcherait la reconnaissance de la source. (Cette
  ligne nommait `waMeLink`, qui n'existe pas.)
- **Ordinateur** : un clic ouvre un petit panneau avec le QR code et le lien `wa.me`, ouvert dans un nouvel onglet.
  🔴 **Le QR se génère CÔTÉ SERVEUR**, au moment de servir le script (`src/widgets/qr.ts`), et voyage dedans en
  SVG, posé par une balise `img` en `data:` URI. Trois raisons : aucune bibliothèque de QR n'est téléchargée par
  chaque site client, donc par chacun de ses visiteurs ; `qrcode` est déjà une dépendance du dépôt, côté console
  (`web/package.json`), et l'API la reprend aux mêmes versions ; et le contenu du QR, le lien `wa.me`, est connu
  au moment de servir. Cette section disait l'inverse avant le lot 2 (générer dans le navigateur pour ne pas
  ajouter de dépendance à l'API) : le prix réel en était une bibliothèque tierce chargée sur les sites de nos
  clients.

## 6. Quand le numéro ne répond plus

Un espace peut cesser de payer, son numéro être délié (`src/meta/factory.ts`, point d'envoi unique), ou le compte
WhatsApp être suspendu. La balise, elle, reste sur le site du client.

**La bulle s'affiche alors grisée et ne s'ouvre pas** (décision de Julien). Elle reste visible pour ne pas casser
la mise en page du site, mais visiblement indisponible et sans clic possible : le visiteur comprend, et surtout
il n'écrit pas dans le vide à un numéro qui ne répondra jamais, ce qui laisserait une mauvaise impression **du
client**, pas de nous.

C'est le script généré qui porte cet état : il le connaît au moment où il est servi, et le cache de 60 secondes
borne le délai de bascule. La bulle grisée n'a ni lien ni gestionnaire de clic, porte « Messagerie WhatsApp
momentanément indisponible » en `title` et `aria-label` seulement (aucun texte visible, pas de traduction au
premier lot), et ne publie ni la phrase ni le numéro.

🔴 **GRISÉE SEULEMENT SANS NUMÉRO OU SUR UN NUMÉRO DÉLIÉ (`phone_numbers.delie_le`), JAMAIS SUR `health_status` À
`BLOCKED`.** Mesuré en production le 2026-10-02 : un compte BLOCKED (moyen de paiement en erreur, entreprise non
vérifiée) reçoit ET répond normalement dans la fenêtre de 24 h, seules les conversations ouvertes par l'entreprise
sont bloquées. Or le visiteur du widget écrit le premier : griser sur BLOCKED éteindrait un widget qui marche. Le
« compte suspendu » du paragraphe d'ouverture ne grise donc pas la bulle au lot 2 ; un numéro réellement banni par
Meta, s'il se mesure un jour, sera un état à part.

**Plafond horaire par widget**, comme `channelsme_links.max_par_heure` : une phrase publique peut être envoyée en
rafale, et un envoi de masse involontaire se facture au client.

## 7. Ce qui n'est pas dans ce lot

- **Les statistiques** (vues, ouvertures, clics). Elles demandent une route publique en ÉCRITURE, donc un plafond
  propre, une protection contre le gonflage des compteurs, et une décision sur ce qu'on dépose chez le visiteur.
  C'est un lot à soi. Le client mesure d'ici là ce qui compte vraiment : les conversations arrivées par la source
  du widget.
- **Le RCS.** Il n'existe pas d'équivalent de `wa.me` pour ouvrir une conversation RCS depuis un navigateur. À
  rouvrir seulement si la mesure dit le contraire.
- **Le chat dans la page.** Il sortirait du modèle WhatsApp : plus de fenêtre de 24 h, plus de numéro du visiteur,
  et une session anonyme à tenir en temps réel.

## 8. Ce qui clôt la feature

🔴 **Aucun test vert ne clôt ce lot.** Ce qui le clôt : la balise posée sur un VRAI site, un message envoyé depuis
un VRAI téléphone, la conversation qui arrive dans l'Inbox marquée de la bonne source, et le devenir du widget qui
prend effectivement la main. Puis le même essai avec le numéro délié, pour voir la bulle grisée.

Les tests couvrent ce qu'ils savent couvrir : le script ne contient aucun secret, l'unicité de la phrase, les
CHECK du devenir dans les deux sens, et le lien `wa.me` sur un numéro tel que Meta l'affiche.

## Questions encore ouvertes

- [ ] Le numéro de migration : à lire dans `db/migrations/` d'**origin** au moment d'écrire le fichier (0199 au 2026-10-02).
- [ ] Le texte exact de la bulle grisée, et s'il est traduit. (Lot 2 : « Messagerie WhatsApp momentanément
  indisponible », en `title` et `aria-label`, en français seulement.)
- [ ] La charge d'un site très fréquenté : deux lectures en base par chargement que Cloudflare ne met pas en
  cache. Vérifier que `/widget/*.js` y est bien mis en cache (l'en-tête `public, max-age=60` le permet), sinon
  un cache court en mémoire par code (`cacheCourt`) plutôt qu'un plafond qui refuserait des visiteurs.
- [ ] Faut-il limiter le nombre de widgets par espace, et à combien ?
- [ ] Que fait l'écran quand le client supprime un scénario utilisé par un widget : refus, ou widget rendu inerte ?
