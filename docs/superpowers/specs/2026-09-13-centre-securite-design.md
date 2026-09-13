# Le centre de Sécurité & compliance

**Demandé par Julien le 2026-09-13.** Un menu « Sécurité » au bas de la barre latérale, à côté de
Paramètres, Support et Developers, avec sa page d'accueil et quatre sous-menus.

## Ce qu'on construit

Une page d'accueil : « Bienvenue au centre de sécurité & compliance de Engage Me », puis autant de
boîtes que de sous-menus. La barre latérale reste à gauche et déplie les sous-menus sous « Sécurité ».

| Sous-menu | Ce qu'il porte | État de départ |
|---|---|---|
| **Consentement** | l'opt-out : sa règle, sa liste, ses exports | le gros morceau, cf. ci-dessous |
| **Audit trails** | déplacés depuis Paramètres | existe, change de place |
| **IA** | les réglages liés à l'AI Act | une seule bascule au départ |
| **Journal des erreurs** | celles du client ET celles du système | l'existant DÉMÉNAGE, le reste s'ajoute |

## 🔴 Le consentement : ce qui existe déjà, mesuré et non supposé

Avant de concevoir quoi que ce soit, l'existant a été lu :

- **`estDemandeArret`** (`src/crm/consentement.ts`) reconnaît un refus dans un message entrant et
  écrit `opted_out` **sans rien demander à l'opérateur**, sur WhatsApp **et** RCS.
- La règle est **ancrée en début de message** : `stop`, `stopper`, `unsubscribe`, `desabonner`,
  `arret`, `arrêt`. Le fichier explique pourquoi, et c'est un bon raisonnement : « stop » n'importe où
  attraperait « je ne peux pas m'arrêter là », « arrêt de bus », « non-stop ». **Un faux positif
  désabonne quelqu'un en silence, et personne ne s'en aperçoit : il cesse simplement de recevoir.**
- **`optInAllows`** (`src/campaign/guardrails.ts`) refuse un `opted_out` pour TOUT, marketing comme
  utility. La garantie que Julien demande existe donc déjà... **mais seulement là où elle est appelée.**

🔴 **ET ELLE N'EST APPELÉE QU'À DEUX ENDROITS** (mesuré : `src/campaign/build.ts` et
`src/api/sends-build.ts`). Un **scénario**, une **automation**, l'**agent IA** ou un **envoi depuis
l'Inbox** atteignent aujourd'hui quelqu'un qui a écrit STOP. C'est le trou réel, et c'est lui qui
compte le plus dans cette demande.

## Décision de Julien, 2026-09-13 : jusqu'où le blocage va

**Tout sauf la réponse manuelle d'un opérateur.** Campagnes et API publique (déjà faits), plus les
scénarios, les automations et l'agent IA. Un opérateur qui répond **à la main** dans l'Inbox reste
autorisé.

⚠️ **LA RAISON DE CETTE EXCEPTION EST CELLE QUI LA REND JUSTE, ET ELLE DOIT SURVIVRE À CE DOCUMENT** :
sans elle, un opérateur ne pourrait même plus accuser réception d'un opt-out, ni répondre à une
réclamation posée juste après. Bloquer l'humain qui traite la demande de la personne, au nom de cette
même demande, serait absurde. La machine se tait ; la personne peut encore répondre à la personne.

## 🔴 Élargir la détection : la mesure a été faite, et elle est vide

Julien veut reconnaître « arrêtez de me parler », « je voudrais me désabonner », et les formulations
voisines. Le code dit que l'élargissement doit se décider **sur de vrais messages, pas au jugé**. Julien
a choisi de mesurer d'abord.

**Mesure du 2026-09-13, sur la base de production** : 135 messages entrants porteurs de texte.
**ZÉRO** reconnu par la règle actuelle. **ZÉRO** reconnu par une règle élargie candidate.

🔴 **IL N'Y A DONC RIEN SUR QUOI CALIBRER AUJOURD'HUI, ET C'EST UN RÉSULTAT, PAS UN ÉCHEC.** Élargir
maintenant reviendrait exactement à ce que le code déconseille : décider au jugé. Mais ne rien faire
laisserait la question ouverte indéfiniment.

**La sortie, et c'est elle qui honore les deux exigences : instrumenter d'abord, décider ensuite.** La
règle élargie est écrite et exécutée **en OBSERVATION** : quand elle reconnaît un refus que la règle
actuelle n'aurait pas vu, elle **ne désabonne personne**, elle **journalise le message** et le fait
remonter dans l'écran Consentement, sous « refus possibles à confirmer ». L'opérateur confirme ou
écarte d'un clic, et chaque geste devient une donnée de calibrage.

Au bout de quelques semaines de vrais messages, on saura ce que l'élargissement attrape et ce qu'il
attrape à tort, et on décidera de le rendre automatique ou non. **La décision est reportée, pas
esquivée : ce qui est construit maintenant est ce qui permettra de la prendre.**

## L'écran Consentement

- **La liste des opt-out**, exportable.
- Un clic sur une personne donne **le résumé de la conversation** qui a mené au refus.
- Un clic de plus ouvre **la conversation dans l'Inbox**.
- On peut **télécharger la conversation entière** qui a abouti à l'opt-out.
- **Les refus possibles à confirmer** (cf. ci-dessus), avec le message qui les a déclenchés.
- Le réglage de **ce que l'espace fait au moment où un opt-out est déclaré**, avec accès à la liste des
  outils (Tools).

## Le sous-menu IA

Une première bascule, déplacée depuis la fiche de l'agent IA : **« l'IA se déclare comme telle »**.
C'est un réglage d'espace, pas un réglage d'agent : l'AI Act fait peser l'obligation sur la marque
déployante, qui n'a pas à la répéter agent par agent.

⚠️ **LE META BUSINESS AGENT N'EST PAS CONCERNÉ, et il ne faut pas le lui appliquer par symétrie** :
Meta écrit déjà « IA » sous ses messages. Ajouter notre propre déclaration ferait deux mentions.

⚠️ Le réglage existant a trois valeurs (`jamais`, `session`, ...) et un défaut choisi en connaissance de
cause le 2026-09-09. **Le remonter au niveau de l'espace ne doit pas changer le comportement des agents
existants** : c'est une migration de réglage, et un agent déjà configuré doit continuer à faire ce
qu'il faisait.

## Le journal des erreurs : LES DEUX, et la moitié existe déjà

Tranché par Julien le 2026-09-13 : « on a déjà un log d'erreurs (les erreurs d'envoi et autres erreurs
du système quand on a un retour d'api qui a pas fonctionné)... donc il faut les 2 ».

🔴 **ET LA MOITIÉ CLIENT EXISTE DÉJÀ, MESURÉE AVANT DE PLANIFIER QUOI QUE CE SOIT.**
`GET /tenants/:tenantId/erreurs-livraison` (`src/http/contacts.ts`) rend ce que Meta a répondu quand un
message n'est pas parti ou n'est pas arrivé : admin-only, avec sa recherche par texte, par téléphone et
par code Meta, et son écran (`web/components/ErreursLivraison.tsx`). **Il n'y a rien à recréer.**

⚠️ **ET IL EST RANGÉ AU MÊME ENDROIT QUE LES AUDIT TRAILS**, ce qui simplifie le déménagement : les deux
partent ensemble vers Sécurité, dans le même geste.

Ce qui s'AJOUTE, c'est la moitié système : les retours d'API qui n'ont pas fonctionné, et les échecs
d'avancement de parcours (`workflow_advance_failures`, migration 0108).

⚠️ **CE QUI PORTE LES NUMÉROS RESTE ADMIN-ONLY.** Le journal de livraison porte les numéros de
téléphone, délibérément (« quel message n'est pas arrivé » sans dire « à qui » ne répond à rien). Le
déplacer dans un centre de conformité ne doit pas l'ouvrir plus largement.

## Ce qui reste à cadrer avant de coder

1. **La portée de l'export** d'une conversation : RGPD, durée de conservation, qui a le droit.

## L'essai réel qui clôt la feature

Écrire « stop » depuis un vrai téléphone, constater que le contact passe en opt-out, **puis tenter de
l'atteindre par un scénario et par une automation** et constater que rien ne part. Et le sens inverse,
celui qui protège l'usage : un opérateur doit encore pouvoir lui répondre à la main.
