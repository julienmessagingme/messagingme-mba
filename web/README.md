# messagingme-mba-web

Console MBA (frontend Next.js) : login, contacts + import CSV. Consomme l'API Fastify du repo.

## Lancer en local

1. Backend (à la racine du repo) : `npm run migrate && npm run seed && npm run dev` (API sur `:8095`).
   Le seed crée `admin@demo.test` / `demo1234` (tenant démo + numéro `demo-pn`).
2. Frontend (dans `web/`) :
   ```
   cp .env.local.example .env.local   # BACKEND_URL=http://localhost:8095
   npm install
   npm run dev                        # http://localhost:3000
   ```
3. Se connecter avec le compte démo, importer un CSV, voir la liste des contacts.

## Notes

- Le navigateur appelle `/api/backend/*` (même origine) ; Next relaie vers `BACKEND_URL` en
  forwardant l'en-tête `Authorization`. Pas de CORS à gérer.
- Le token JWT est stocké en `localStorage` (`mba.session`). Auth vérifiée côté client (garde
  de route) ; l'API reste la source de vérité (401 -> retour login).
- Prochaines tranches : campagnes (création + suivi), inbox conversations.
