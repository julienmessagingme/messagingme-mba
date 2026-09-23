# Engage Me

**La plateforme conversationnelle qui comprend chaque conversation.**

Console SaaS qui déploie et pilote la stack conversationnelle d'un client : WhatsApp (Cloud API, Marketing
Messages, Meta Business Agent), RCS et e-mail. Un client y branche son numéro, importe ses contacts, construit
des scénarios, envoie des campagnes, répond dans une boîte de réception, et laisse un agent IA tenir une
partie des conversations.

⚠️ Le dépôt garde son nom technique `messagingme-mba`, comme l'identifiant du serveur MCP : les renommer
casserait les connexions déjà configurées chez les clients.

## Par où commencer

| Ce que vous cherchez | Le fichier |
|---|---|
| comment le système est fait, et ce qu'il ne faut pas casser | **[documentation.md](documentation.md)**, le manuel technique |
| ce que le produit fait, vu du client | [features.md](features.md) |
| comment déployer, et comment revenir en arrière | [DEPLOY.md](DEPLOY.md) |
| ce sur quoi on travaille en ce moment | [wip.md](wip.md) |
| ce qui reste à faire | [todo.md](todo.md) |
| pourquoi telle décision a été prise il y a trois mois | [docs/JOURNAL-TECHNIQUE.md](docs/JOURNAL-TECHNIQUE.md), l'archive |
| les commandes, les règles de travail, le compteur de migrations | [CLAUDE.md](CLAUDE.md) |

⚠️ **L'archive ne fait jamais autorité sur l'état actuel.** Elle décrit l'état au moment de chaque livraison.
Une phrase trouvée dedans se revérifie dans le manuel avant d'être crue.

## La topologie, en un coup d'oeil

```
 navigateur                         Meta, contacts, opérateur télécom
     |                                           |
 engageme.messagingme.app                    Cloudflare
 console, Vercel direct                   /              \
                            api.messagingme.app    mba.messagingme.app
                             API + worker VPS       ancienne console
                                     |              + adresses historiques
                                  Supabase
```

Trois noms, deux hébergeurs. Le détail, et surtout ce qu'il faut faire **avant** d'éteindre le VPS, est dans
le § « Le système en dix minutes » du manuel.

## Démarrer en local

**Prérequis** : Node >= 22 et un Postgres. Le second n'est nécessaire que pour le worker et les migrations ;
l'API et les tests unitaires tournent sans.

```bash
npm install
cp .env.example .env        # puis remplir AUTH_SECRET et DATABASE_URL au minimum
npm run migrate             # applique db/migrations/ sur la base de DATABASE_URL
npm run dev                 # API Fastify en watch
npm run worker              # les files et les balayeurs, dans un second terminal
```

Le front vit à part :

```bash
cd web && npm install && npm run dev    # Next.js sur :3000, proxifie /api/backend/*
```

## Tester sans rien casser

```bash
npm test              # unitaires, sans base. Sûr, toujours.
npm run typecheck     # tsc --noEmit
cd web && npm test    # unitaires du front
cd web && npx playwright test    # bout en bout, l'API étant simulée
```

🔴 **Ne lancez PAS `npm run test:integration` en local.** Le `DATABASE_URL` du `.env` de travail pointe la
base de **production** : ces tests y créeraient et y supprimeraient des tenants. La CI monte un Postgres
jetable pour eux, et **c'est le run GitHub qui fait foi** : un `npm test` vert en local n'a vérifié que la
moitié.

## Ce qui garde le dépôt

- **CI** sur chaque push : `unit`, `integration` (Postgres jetable), `web`. Le verdict se lit job par job.
- **gitleaks** en pre-commit, sur tous les dépôts de cette machine : aucun secret ne peut être commité.
- **`tests/documentation-hygiene.test.ts`** : le manuel ne peut plus recopier un compteur calculable, porter
  un titre daté, ni pointer vers un fichier absent.

## Contribuer

Une seule branche vivante, `main`, et on commite dessus. Les règles de travail (revue systématique, rayon de
souffle, zéro dette cumulée, `git commit --only`) vivent dans [CLAUDE.md](CLAUDE.md) : elles ne sont pas
décoratives, chacune vient d'un incident réel.
