# messagingme-mba

Console SaaS plug-and-play qui déploie et pilote la stack native Meta pour WhatsApp
(Cloud API + Marketing Messages API / MM Lite + Meta Business Agent) pour des clients.

> « Envoie des campagnes WhatsApp qui se répondent toutes seules. »

Point d'entrée doc : [CLAUDE.md](CLAUDE.md). Cadrage produit (source de vérité) :
`messagingme-pilot/docs/PROJET-MBA-CONSOLE.md`.

## Démarrage

```bash
npm install
npm test          # baseline verte
npm run dev       # API Fastify (receiver webhooks) en watch
```

Voir [documentation.md](documentation.md) pour l'architecture et le schéma DB.
