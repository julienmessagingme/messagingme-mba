import type { EcranAide } from './carte';

/**
 * LA CARTE DE LA CONSOLE, ÉMISE. Ne pas éditer à la main : lancer `npm run aide:carte`.
 *
 * Sa source est la barre de navigation (`web/lib/nav.ts`). `tests/aide-carte.test.ts` recalcule cette
 * liste et la compare à ce fichier, donc une carte périmée casse la CI plutôt que d'emmener les clients
 * vers la console d'hier.
 */
export const CARTE_CONSOLE: EcranAide[] = [
  {"cle":"accueil","href":"/accueil","fr":"Accueil","en":"Home","acces":"admin","chemin":[]},
  {"cle":"agents","href":"/agents","fr":"Agents","en":"Agents","acces":"admin","chemin":["AI Agent","Other AI agent"]},
  {"cle":"agents-credit","href":"/agents/credit","fr":"Crédit","en":"Credit","acces":"admin","chemin":["AI Agent","Other AI agent"]},
  {"cle":"api-docs","href":"/developers/api","fr":"Documentation API","en":"API documentation","acces":"admin","chemin":["Developers"]},
  {"cle":"api-keys","href":"/developers/keys","fr":"Clés d'API","en":"API keys","acces":"admin","chemin":["Developers"]},
  {"cle":"automations","href":"/automations","fr":"Automation","en":"Automation","acces":"admin","chemin":[]},
  {"cle":"campagnes","href":"/campaigns","fr":"Campagnes","en":"Campaigns","acces":"admin","chemin":[]},
  {"cle":"chaine","href":"/chaine","fr":"Chaîne","en":"Channel","acces":"admin","chemin":[]},
  {"cle":"connecteurs","href":"/connecteurs","fr":"Connecteurs API","en":"API connectors","acces":"admin","chemin":["Tools"]},
  {"cle":"connecteurs-mcp","href":"/connecteurs-mcp","fr":"Connecteurs MCP","en":"MCP connectors","acces":"admin","chemin":["Tools"]},
  {"cle":"contacts","href":"/contacts","fr":"mini-CRM","en":"mini-CRM","acces":"admin","chemin":[]},
  {"cle":"dashboard-quali","href":"/dashboard/quali","fr":"Analyse des conversations","en":"Conversation analysis","acces":"admin","chemin":[]},
  {"cle":"dashboard-tableaux","href":"/dashboard/tableaux","fr":"Mes tableaux","en":"My reports","acces":"admin","chemin":[]},
  {"cle":"email-templates","href":"/email-templates","fr":"Modèles","en":"Templates","acces":"admin","chemin":["Contenu","Email"]},
  {"cle":"fields","href":"/fields","fr":"Champs","en":"Fields","acces":"admin","chemin":["Contenu","Bibliothèque"]},
  {"cle":"flows","href":"/flows","fr":"Formulaires","en":"Forms","acces":"admin","chemin":["Contenu","WhatsApp"]},
  {"cle":"inbox","href":"/inbox","fr":"Inbox","en":"Inbox","acces":"tous","chemin":[]},
  {"cle":"mba-guide","href":"/mba","fr":"MBA, guide","en":"MBA, guide","acces":"admin","chemin":["AI Agent","MBA"]},
  {"cle":"mba-settings","href":"/mba/parametres","fr":"MBA, paramètres","en":"MBA, settings","acces":"admin","chemin":["AI Agent","MBA"]},
  {"cle":"mcp","href":"/developers/mcp","fr":"Serveur MCP","en":"MCP server","acces":"admin","chemin":["Developers"]},
  {"cle":"nodes","href":"/nodes","fr":"Blocs","en":"Blocks","acces":"admin","chemin":["Contenu","Bibliothèque"]},
  {"cle":"outils-espace","href":"/outils","fr":"Outils","en":"Tools","acces":"admin","chemin":["Tools"]},
  {"cle":"parametres","href":"/parametres","fr":"Paramètres","en":"Settings","acces":"admin","chemin":[]},
  {"cle":"perf-synthese","href":"/performance","fr":"Synthèse","en":"Summary","acces":"admin","chemin":[]},
  {"cle":"quanti-couts","href":"/dashboard/couts","fr":"Coûts","en":"Costs","acces":"admin","chemin":["Quantitatif"]},
  {"cle":"quanti-funnel","href":"/dashboard/funnel","fr":"Funnel","en":"Funnel","acces":"admin","chemin":["Quantitatif"]},
  {"cle":"quanti-messages","href":"/dashboard","fr":"Messages & contacts","en":"Messages & contacts","acces":"admin","chemin":["Quantitatif"]},
  {"cle":"rcs-messages","href":"/rcs-messages","fr":"Messages","en":"Messages","acces":"admin","chemin":["Contenu","RCS"]},
  {"cle":"securite-audit","href":"/securite/audit","fr":"Audit trails","en":"Audit trails","acces":"encadrement","chemin":["Sécurité"]},
  {"cle":"securite-consentement","href":"/securite/consentement","fr":"Consentement","en":"Consent","acces":"encadrement","chemin":["Sécurité"]},
  {"cle":"securite-erreurs","href":"/securite/erreurs","fr":"Journal des erreurs","en":"Error log","acces":"encadrement","chemin":["Sécurité"]},
  {"cle":"securite-ia","href":"/securite/ia","fr":"IA","en":"AI","acces":"encadrement","chemin":["Sécurité"]},
  {"cle":"support","href":"/support","fr":"Support","en":"Support","acces":"admin","chemin":[]},
  {"cle":"tags","href":"/tags","fr":"Étiquettes","en":"Tags","acces":"admin","chemin":["Contenu","Bibliothèque"]},
  {"cle":"templates","href":"/templates","fr":"Templates","en":"Templates","acces":"admin","chemin":["Contenu","WhatsApp"]},
  {"cle":"webhooks","href":"/webhooks","fr":"Webhooks","en":"Webhooks","acces":"admin","chemin":["Tools"]},
  {"cle":"workflows","href":"/workflows","fr":"Scénario","en":"Scenario","acces":"admin","chemin":["Contenu"]},
];
