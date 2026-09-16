# WIP

> Ce fichier ne porte QUE le travail en cours. Un lot déployé en sort le jour même : son fonctionnel va dans
> [features.md](features.md), sa technique durable dans [documentation.md](documentation.md), son RÉCIT dans
> [docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md), ce qui reste à faire dans [todo.md](todo.md).
>
> ⚠️ **Un lot déployé qui traîne ici ne vieillit pas, il MENT.** Vidé pour la sixième fois le 2026-09-16 :
> il annonçait encore `93a10c4` et répétait une mesure démentie depuis (voir plus bas).

## L'ÉTAT EXACT, AU 2026-09-16 AU MATIN

| | |
|---|---|
| `origin/main` | `ab898e8` |
| VPS (`mba-api`, `mba-worker`) | `237853b` — 🔴 **TROIS COMMITS DE RETARD**, le lot « tester depuis un bloc » n'est PAS déployé |
| Vercel (`engageme`) | suit `origin/main` tout seul, donc **déjà à `ab898e8`** |
| Migrations | **0151** (`workflow_runs.graphe_fige`), appliquée le 2026-09-16 et relue en base. **Prochaine libre : 0152** |
| CI | ✅ verte job par job sur les trois commits (`unit`/`securite`/`integration` pour les deux premiers, `web` pour le troisième, qui ne touche que `web/`) |
| Contrôle public | ⏳ à refaire après le déploiement du VPS |

🔴 **L'ÉCART FRONT / API EST UNE FENÊTRE OUVERTE, ET ELLE SE VOIT.** Vercel a déployé le bouton lecture ;
l'API du VPS ne sait pas encore lire le suffixe de bloc. Un lien cliqué maintenant n'est donc PAS reconnu
comme un jeton de test : il n'est pas consommé, et il part à l'agent de Meta comme un message de client
ordinaire, qui y répondra. Rien n'est cassé pour un vrai client, mais le bouton ne marche pas tant que
`mba-api` et `mba-worker` n'ont pas `ab898e8`. La migration est DÉJÀ passée : il n'y a rien à migrer.

## CE QU'UNE SESSION SUIVANTE DOIT SAVOIR

- 🔴 **LE DÉPÔT EST PUBLIC** depuis le 2026-09-15 (GitHub Actions gratuit). Rien de sensible ne s'écrit ici.
- 🔴 **LA CI EST DÉCOUPÉE EN DEUX WORKFLOWS**, et l'asymétrie est volontaire : `ci-web.yml` ne part que sur
  `web/**`, mais `ci.yml` garde un `paths-ignore` et jamais un filtre positif, parce que 43 tests de la
  racine LISENT des fichiers de `web/`. `tests/ci-decoupage.test.ts` tient la règle ET sa raison.
- ⚠️ **LA MESURE DU 2026-09-15 SUR META ÉTAIT FAUSSE, ET LA CORRECTION COMPTE PLUS QUE L'ERREUR.** Ce fichier,
  trois commentaires de code et `CLAUDE.md` ont affirmé toute une journée que « Meta acquitte nos envois avec
  DEUX MINUTES de retard ». C'était une erreur de LECTURE : les heures relevées étaient celles où NOTRE worker
  traitait l'accusé. L'horodatage que Meta inscrit vaut la seconde de l'envoi, et son webhook arrive une
  seconde après. Les deux minutes venaient de la file `webhook-status`, qui se vidait à deux accusés par
  minute. Corrigé partout le 2026-09-15 au soir.

## CE QUI ATTEND UN ESSAI RÉEL

🔴 **Aucun des chemins livrés le 2026-09-15 et le 2026-09-16 n'a tourné sur un vrai échange.** Ils sont verts,
déployés, et éprouvés par mutation ; aucun n'est éprouvé tout court. ⚠️ Et Julien a signalé le 2026-09-16 que
les numéros des deux incidents ne sont pas les siens : **il ne peut pas rejouer ces deux cas-là**, ce qui
déplace le poids sur la revue et sur les vérifications faites contre les vraies données.

### 1. L'agent de Meta répond après un silence

Écrire depuis un numéro dont la conversation dort depuis des jours : l'agent doit répondre, quel que soit le
délai et quel que soit le canal du dernier échange. Puis **répondre à un scénario qui pose une question** : le
scénario doit avancer et l'agent rester MUET. C'est cette troisième vérification qui prouve qu'on n'a rien
cassé, et c'est la plus importante des trois.

⚠️ **Ce qui peut être rejoué sans les numéros des clients** : mettre la conversation d'un numéro qu'on
contrôle dans l'état exact de l'incident (`app_workflow` + `control_changed_at` à null), ce qui est une
écriture réversible, puis écrire depuis ce numéro.

### 2. Le journal d'audit

Inviter quelqu'un, changer son rôle, créer puis révoquer une clé d'API, et ouvrir Sécurité > Audit : les
quatre lignes doivent y être, avec le bon auteur et le bon horodatage, et **aucune ne doit porter d'email
ailleurs que dans la colonne auteur**.

### 3. Tester un scénario À PARTIR D'UN BLOC (livré le 2026-09-16, à faire APRÈS le déploiement du VPS)

Quatre gestes, et le troisième est le seul qu'aucun test ne remplace :

1. **Cliquer le bouton lecture d'un bloc AU MILIEU d'un scénario**, scanner le QR, envoyer : c'est CE
   message-là qui doit arriver, pas le premier du scénario.
2. **Modifier le brouillon SANS publier**, recliquer le même bloc : le test doit suivre la modification.
3. 🔴 **Atteindre un bloc d'attente ou une question et RÉPONDRE** : le parcours doit continuer sur le
   BROUILLON. C'est la vérification du défaut que la migration 0151 répare, et elle ne se fait qu'à la main.
4. **Cliquer un bloc d'un scénario publié SANS brouillon en attente** : ce cas ne doit rien casser.

⚠️ **Et regarder la bulle WhatsApp** : `test-a7k2m9p3.<uuid>` ressemble à un nom de domaine, WhatsApp va
probablement l'afficher en lien bleu. Ça ne change pas le texte envoyé, mais personne ne l'a encore vu.

### 4. « Ça pousse ou ça intègre » (migration 0150), toujours dû depuis le 2026-09-15

Donner `testadd` (`POST /subscriber/add-tag`) à un agent IA en « ça pousse », l'essayer depuis le bac à sable,
puis **vérifier dans UChat que l'étiquette est réellement posée**. Refaire avec un appel qui intègre, cocher un
champ, vérifier que la valeur remonte mot pour mot. ⚠️ Le bac à sable est à revérifier en particulier : il
rendait zéro champ pour tout outil de connecteur depuis le 2026-09-02.

## UN POINT D'ÉCRAN QUI RESTE À FAIRE

La section des connexions échouées devra **dire qu'elle ne montre que les tentatives sur des comptes
existants**. `audit_log.tenant_id` est NOT NULL : une tentative sur une adresse inconnue n'appartient à aucun
espace et ne peut pas s'écrire. Sans cette phrase, on lira « aucune tentative » alors qu'il y en a eu.
