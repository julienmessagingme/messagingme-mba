# Node « Envoi de mail » (SMTP) dans les Scénarios

Date : 2026-08-18
Statut : design validé, prêt pour plan d'implémentation

## 1. Objectif

Ajouter un type de node « Envoi de mail » dans l'éditeur de Scénarios. Quand un parcours
atteint ce node, un email part vers une adresse définie dans le node (nous, le contact, ou
un tiers), depuis une boîte SMTP que le client a connectée, avec un modèle rédigé à l'avance.

Trois briques :

1. **Connexions SMTP** par client, plusieurs possibles, gérées depuis le menu en haut à droite.
2. **Modèles d'email** dans « Contenu », deux formats (basique et HTML), avec variables.
3. **Le node** dans le Scénario, qui choisit la boîte, le modèle et le destinataire.

## 2. Décisions structurantes

### 2.1 SMTP uniquement, boîte connectée par le client

Pas d'expéditeur partagé MessagingMe (Resend), pas de vérification de domaine, pas de
« Se connecter avec Google ». Décision de Julien : on connecte une vraie boîte en SMTP,
point.

Motif du rejet de Google Sign-In : l'envoi via Gmail exige le scope restreint `gmail.send`,
donc l'écran de consentement à faire vérifier par Google plus un audit sécurité (CASA),
soit plusieurs semaines et un coût récurrent, pour un résultat que le SMTP couvre déjà.
Le SMTP, lui, se réduit à quatre champs chiffrés et marche avec n'importe quelle boîte
(OVH, Gmail en mot de passe d'application, SendGrid, etc.).

Conséquence assumée, pas un frein : en SMTP pur, la déliverabilité et le volume dépendent
de la boîte connectée (une boîte grand public plafonne le débit quotidien et peut marquer
l'automatisation). Parfait pour l'alerte interne et le 1:1 ; pour du volume, une boîte pro
sur domaine dédié est à la charge du client.

### 2.2 Plusieurs boîtes par client, le node choisit laquelle

Le client peut connecter N boîtes SMTP (ex. « support », « commercial »). Chaque node
« Envoi de mail » désigne explicitement **quelle** boîte envoie. Pas de rotation ni de
répartition de charge automatique : le choix est manuel, par node. Le multi-expéditeur au
sens routage/rotation est hors périmètre (voir §10).

### 2.3 Le node est une action synchrone, non bloquante, best-effort

L'email n'est pas le canal WhatsApp : il n'ouvre pas de fenêtre 24 h et n'attend pas de
réponse. Le node se comporte comme un node `tag`/`action` (action synchrone puis on
enchaîne). Surtout, il est **best-effort** : un échec d'envoi (SMTP injoignable, modèle
supprimé, destinataire vide) est journalisé mais **n'arrête jamais** le parcours WhatsApp.

### 2.4 Le destinataire est un champ libre du node

Une seule entrée « destinataire », qui accepte soit une adresse en dur (`kind: 'literal'`),
soit une variable pointant un champ contact (`kind: 'field'`). Rappel structurant : les
contacts n'ont pas de colonne email en base (`0001_init.sql`). « Écrire au contact »
suppose donc que son email vive dans un `user_field` (collecté par un formulaire du flow ou
importé). Pour « nous » ou un tiers, l'adresse est saisie en dur.

### 2.5 Nouvelle dépendance : nodemailer

Aucun client SMTP dans le repo aujourd'hui (`resend.ts` est du HTTP, réservé au support).
On ajoute `nodemailer` (+ `@types/nodemailer`), le standard de fait, transport injectable
pour les tests.

## 3. Modèle de données

Migration **0060** (dernière migration sur disque : 0059). Deux tables. Le node lui-même
n'ajoute aucune migration : il vit dans le `graph` jsonb de `workflows`.

Les deux tables sont chiffrées/scopées sur le même patron que `waba_credentials` (0029) :
`tenant_id` obligatoire, secret chiffré via `src/crypto/secretbox.ts` (AES-256-GCM,
`ENCRYPTION_KEY`), suppression douce via `deleted_at` (patron `0049`) pour ne pas casser un
node qui référence une boîte/modèle retiré.

### 0060 — boîtes SMTP et modèles d'email

```sql
create table email_accounts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  label         text not null,              -- « support », « commercial »…
  host          text not null,
  port          integer not null,
  secure        boolean not null default true,   -- TLS implicite (465) vs STARTTLS
  username      text not null,
  password_enc  text not null,             -- chiffré (secretbox v1)
  from_address  text not null,
  from_name     text,
  reply_to      text,
  verified_at   timestamptz,               -- dernier « envoyer un test » réussi
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create unique index email_accounts_tenant_label
  on email_accounts (tenant_id, label) where deleted_at is null;
create index email_accounts_tenant on email_accounts (tenant_id) where deleted_at is null;

create table email_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  format      text not null check (format in ('basic','html')),
  subject     text not null,
  body        text not null,               -- texte pour 'basic', HTML brut pour 'html'
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create unique index email_templates_tenant_name
  on email_templates (tenant_id, name) where deleted_at is null;
create index email_templates_tenant on email_templates (tenant_id) where deleted_at is null;
```

### Données du node (dans `workflows.graph`, sans migration)

```ts
// node.data pour wfType === 'email'
{
  code: string,                 // minté serveur au save, comme les autres nodes
  emailAccountId: string,       // quelle boîte SMTP envoie
  templateId: string,           // quel modèle
  to:
    | { kind: 'literal', value: string }   // adresse en dur
    | { kind: 'field', field: string }     // clé d'un user_field portant l'email
}
```

Comme pour les autres types, `parseGraph` ne valide pas ce contenu (le `data` reste opaque) :
`actionOf` le lit défensivement et rend `null` si le node est incomplet.

## 4. Backend

### 4.1 Stores et résolveur (par tenant)

- `src/email/account-store.pg.ts` (`PgEmailAccountStore`) et `src/email/template-store.pg.ts`
  (`PgEmailTemplateStore`), calqués sur `PgWorkflowStore` : `list/getById/create/update/
  softDelete`, tous en `where tenant_id = $1 and deleted_at is null`.
- `src/email/credentials.ts` (`EmailAccountResolver`), calqué sur `MetaCredentialsResolver` :
  résout une boîte par id, déchiffre le mot de passe, met en cache le transport nodemailer,
  invalide le cache à chaque écriture sur la boîte.

### 4.2 Envoi SMTP

- `src/email/smtp.ts` : fabrique un transport nodemailer à partir d'une `email_account`
  déchiffrée, et expose `sendSmtpEmail(account, { to, subject, html?, text })`. La forme
  d'entrée reprend `SendEmailInput` de `resend.ts` pour rester homogène. Transport
  injectable (les tests passent un transport JSON nodemailer, aucun réseau).

### 4.3 Substitution de variables

- `src/crm/render.ts` : `renderText(text, contact, { html })` remplace les `{{champ}}` par
  la valeur du contact, en réutilisant les briques existantes (`valueOf`, `ParamSource`,
  `ResolvableContact` de `src/crm/template.ts`), c'est-à-dire la MÊME résolution de contact
  que l'envoi de template (le run porte déjà cette identité, téléphone ou BSUID), pas un
  nouveau chemin par téléphone. Pour `format = 'html'`, les valeurs
  injectées sont **échappées** par défaut (une valeur contact ne doit pas casser ni injecter
  du HTML). Appliqué au sujet, au corps, et au destinataire quand `to.kind === 'field'`.

### 4.4 Intégration au moteur de scénarios

Le node se greffe sur les quatre couches existantes (moteur pur, exécuteur, câblage IO,
front), l'envoi réel étant fait au **seul** endroit partagé api+worker (`wiring.ts`).

- `src/workflow/graph.ts` : ajouter `'email'` à `WORKFLOW_NODE_TYPES`.
- `src/workflow/engine.ts` : ajouter l'action `{ kind: 'sendEmail', emailAccountId,
  templateId, to }` à l'union ; gérer `'email'` dans `actionOf` (rend l'action, ou `null`
  si boîte/modèle/destinataire manquant) ; dans `walk`, le laisser dans la branche
  synchrone finale (empile l'action puis `nextNode`, jamais `waiting`).
- `src/workflow/executor.ts` : ajouter la dep `sendEmail` à `WorkflowExecutorDeps` et la
  dispatcher dans `apply`. **Ne pas** l'inscrire dans `aBesoinFenetre`. Entourer l'appel
  d'un try/catch : un échec est journalisé, n'alimente ni `refus` ni `partis`, et le run
  continue.
- `src/workflow/wiring.ts` : implémenter `sendEmail` dans `buildWorkflowRuntime`. Étapes :
  charger le modèle (scopé tenant), charger la boîte + déchiffrer (via `EmailAccountResolver`),
  résoudre le destinataire (littéral, ou champ via la résolution de contact déjà utilisée par
  l'envoi de template), rendre sujet/corps (`renderText`), envoyer (`sendSmtpEmail`). Sur
  succès, mettre à jour
  `verified_at` (optionnel).
- `src/workflow/node-list.ts` : cas `'email'` dans `summarize` (« Mail : <modèle> vers
  <destinataire> ») pour l'affichage Contenu > Blocs.

### 4.5 Routes HTTP

`src/http/email.ts`, montées sous `/tenants/:t/email/*`, groupe **admin-only** : chaque
handler d'écriture fait `scopeTenant` (403 si null) puis `forbidNonAdmin` (403 si non-admin),
patron identique à `http/workflows.ts`. Les lectures restent ouvertes à tout compte
authentifié du tenant.

- `GET/POST /tenants/:t/email/accounts`, `PATCH/DELETE /tenants/:t/email/accounts/:id`
  (DELETE = suppression douce).
- `POST /tenants/:t/email/accounts/:id/test` : envoie un mail de test à une adresse fournie,
  renvoie succès/erreur, met `verified_at` à jour si succès.
- `GET/POST /tenants/:t/email/templates`, `PATCH/DELETE /tenants/:t/email/templates/:id`.

Le mot de passe n'est **jamais** renvoyé au client (ni en clair ni chiffré). Les lectures
exposent `hasPassword: true` et masquent le reste du secret.

## 5. Frontend

### 5.1 Accès au réglage : menu en haut à droite (admin)

`web/components/AccountMenu.tsx` affiche déjà des entrées admin-only. Ajouter, dans le bloc
`isAdmin`, un `<Link href="/settings/email">` « Boîtes email », à côté de « Compte & équipe ».

### 5.2 Page de connexions SMTP

`web/app/settings/email/page.tsx` (nouvelle) : liste des boîtes (libellé, adresse d'envoi,
pastille « vérifiée »), formulaire d'ajout/édition (libellé, hôte, port, TLS, identifiant,
mot de passe, adresse d'envoi, nom affiché, reply-to), suppression, et un bouton **« Envoyer
un test »** (champ adresse + retour succès/échec). Le champ mot de passe est en écriture
seule (jamais pré-rempli).

### 5.3 Modèles d'email dans « Contenu »

Nouvelle section « Modèles d'email » dans la page Contenu, à côté des Blocs existants. Liste
plus éditeur : nom, bascule de format (basique/HTML), sujet, corps (zone de texte ; HTML brut
pour le format HTML). Aide d'insertion de variables `{{champ}}` en réutilisant le sélecteur
de variables déjà présent dans le builder si applicable.

### 5.4 Le node dans le builder

`web/components/WorkflowBuilder.tsx` et ses satellites :

- `web/lib/api.ts` : ajouter `'email'` à `WorkflowNodeType` et les fonctions client
  (comptes/modèles).
- `web/lib/nodeMeta.ts` : entrée `email` dans `NODE_META` (label « Envoi de mail », icône,
  couleur), ajout à une liste d'ordre **gatée** (comme `RCS_NODE_ORDER`) : le node est grisé
  tant qu'aucune boîte SMTP n'est connectée, avec une aide « connecte une boîte email ».
- `initialDataFor`, `summaryOf`, et une branche `wfType === 'email'` dans `ConfigPanel` :
  liste déroulante de la boîte, liste déroulante du modèle, champ destinataire (littéral ou
  variable). `WFNode` rend automatiquement (type de node unique `wf`) ; sortie unique en bas,
  aucun handle spécial.
- `web/app/workflows/page.tsx` : passer `emailEnabled` (au moins une boîte) comme
  `rcsEnabled`/`mbaEnabled`.

## 6. Flux d'envoi (runtime)

```
Scénario atteint le node email
  -> engine.walk : action { kind:'sendEmail', ... } empilée, on garde nextNode (non bloquant)
  -> executor.apply : deps.sendEmail(action, contact)   [try/catch best-effort]
       -> wiring.sendEmail :
            charge modèle (tenant)            -> si absent : log + skip, run continue
            charge boîte + déchiffre (tenant) -> si absente : log + skip, run continue
            résout destinataire (littéral | champ)  -> si vide : log + skip, run continue
            renderText(sujet, corps [, champ]) avec échappement HTML si format html
            sendSmtpEmail(boîte, { to, subject, html|text })  -> échec SMTP : log, run continue
            succès -> verified_at à jour
  -> le run enchaîne sur le node suivant, quel que soit le résultat de l'envoi
```

Le câblage unique couvre les deux process qui font tourner l'exécuteur : le worker pg-boss
(campagnes, automations, avance sur webhook, réveil des attentes) et l'api (lancement depuis
l'Inbox).

## 7. Gestion des erreurs et cas limites

- **Node incomplet** (pas de boîte/modèle/destinataire) : `actionOf` rend `null`, le node
  est ignoré, le run continue, un log le note.
- **Champ destinataire vide/invalide** sur le contact : envoi sauté, log, run continue.
- **SMTP en échec** (auth, serveur injoignable, refus) : capturé, log, run continue. Jamais
  d'arrêt du parcours WhatsApp.
- **Boîte ou modèle supprimé** référencé par un node : node inerte (no-op) plus log ; le
  résumé du node signale « boîte/modèle supprimé ».
- **HTML** : les valeurs de variables injectées dans un corps HTML sont échappées par défaut.
- **Secrets** : le mot de passe n'est jamais sérialisé vers le client.

## 8. Sécurité

- Mot de passe SMTP chiffré via `secretbox` (AES-256-GCM), `ENCRYPTION_KEY` côté serveur
  uniquement, jamais dans un bundle client.
- Toutes les routes d'écriture admin-only et scopées tenant (tenant tiré du JWT via
  `scopeTenant`, jamais de l'URL). Filtrage `tenant_id = $1` sur chaque requête.
- Le « test » utilise les identifiants SMTP du client (sa propre réputation) ; l'admin peut
  saisir n'importe quelle adresse de test.
- Ne pas journaliser les identifiants, ni les corps de mail porteurs de données personnelles
  au-delà du nécessaire.
- SMTP est une connexion sortante vers un hôte fourni par le client : valider le format
  hôte/port, pas de risque de type SSRF (on ne fetch pas une URL arbitraire).

## 9. Tests

- **Unitaires** : `renderText` (variable présente/absente, échappement HTML) ; résolution du
  destinataire (littéral vs champ) ; `EmailAccountResolver` (déchiffrement + invalidation de
  cache) ; `engine.actionOf('email')` rend l'action/`null` ; `walk` garde le node non
  bloquant.
- **Intégration** : routes CRUD admin-only (403 pour un agent), isolation tenant croisée, mot
  de passe jamais renvoyé, suppression douce.
- **Intégration best-effort** : un transport factice qui lève doit laisser le run avancer
  jusqu'au node suivant.
- **Non-régression dans les deux sens** (règle Julien) : le test qui prouve que le parcours
  continue malgré un échec SMTP doit d'abord **échouer** si on retire le try/catch de
  `executor.apply`, puis repasser une fois le garde remis.
- **E2E optionnel** : créer une boîte + un modèle, poser un node dans un scénario, lancer,
  et vérifier la tentative d'envoi via un transport nodemailer JSON.

## 10. Hors périmètre (YAGNI)

- Expéditeur partagé MessagingMe (Resend), vérification de domaine par tenant, envoi via
  Gmail/Google OAuth.
- Générateur/éditeur visuel de HTML (le HTML est collé brut).
- Suivi d'ouverture/clic, gestion des bounces, désinscription, assistance SPF/DKIM/DMARC.
- Limitation de débit dédiée à l'envoi de masse (le node est transactionnel, par contact,
  dans un scénario ; les plafonds du fournisseur SMTP relèvent du client).
- Rotation/répartition automatique entre plusieurs boîtes (elles coexistent, mais le node en
  désigne une explicitement).

## 11. Carte des touchpoints (repère pour le plan)

Backend :
- `src/workflow/graph.ts` (enum), `engine.ts` (action + `actionOf` + `walk`), `executor.ts`
  (dep + `apply`, hors `aBesoinFenetre`), `wiring.ts` (`sendEmail`), `node-list.ts` (résumé).
- Neuf : `src/email/{account-store.pg,template-store.pg,credentials,smtp}.ts`,
  `src/crm/render.ts`, `src/http/email.ts` (routes admin-only).
- `db/migrations/0060_email.sql`.

Frontend :
- `web/components/AccountMenu.tsx` (entrée), `web/app/settings/email/page.tsx` (neuf),
  section « Modèles d'email » dans Contenu, `web/components/WorkflowBuilder.tsx`,
  `web/lib/api.ts`, `web/lib/nodeMeta.ts`, `web/app/workflows/page.tsx` (gating).

Dépendance : `nodemailer` + `@types/nodemailer`.

## 12. Note de migration et de déploiement

- **Migration 0060** (`email_accounts` + `email_templates`). Un `0059_drop_return_behavior.sql`
  existe déjà sur disque (créé par une autre session) : confirmer le dernier numéro réellement
  appliqué avant de figer le numéro, pour ne pas collisionner.
- Les migrations ne sont pas auto-appliquées : appliquer 0060 sur le VPS **avant** de déployer
  le code qui l'attend (cf `DEPLOY.md` et la règle ferme du `~/CLAUDE.md`).
- `git log <commit-déployé>..HEAD` avant déploiement : plusieurs sessions poussent sur `main`,
  n'embarquer que ce chantier.
