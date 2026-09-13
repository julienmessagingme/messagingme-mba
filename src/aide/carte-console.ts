import type { EcranAide } from './carte';

/**
 * LA CARTE DE LA CONSOLE, ÉMISE. Ne pas éditer à la main : lancer `npm run aide:carte`.
 *
 * Sa source est la barre de navigation (`web/lib/nav.ts`). `tests/aide-carte.test.ts` recalcule cette
 * liste et la compare à ce fichier, donc une carte périmée casse la CI plutôt que d'emmener les clients
 * vers la console d'hier.
 */
export const CARTE_CONSOLE: EcranAide[] = [
  {"cle":"accueil","href":"/accueil","fr":"Accueil","en":"Home","adminOnly":true,"chemin":[]},
  {"cle":"agents","href":"/agents","fr":"Agents","en":"Agents","adminOnly":true,"chemin":["AI Agent","Other AI agent"]},
  {"cle":"agents-credit","href":"/agents/credit","fr":"Crédit","en":"Credit","adminOnly":true,"chemin":["AI Agent","Other AI agent"]},
  {"cle":"api-docs","href":"/developers/api","fr":"Documentation API","en":"API documentation","adminOnly":true,"chemin":["Developers"]},
  {"cle":"api-keys","href":"/developers/keys","fr":"Clés d'API","en":"API keys","adminOnly":true,"chemin":["Developers"]},
  {"cle":"automations","href":"/automations","fr":"Automation","en":"Automation","adminOnly":true,"chemin":[]},
  {"cle":"campagnes","href":"/campaigns","fr":"Campagnes","en":"Campaigns","adminOnly":true,"chemin":[]},
  {"cle":"chaine","href":"/chaine","fr":"Chaîne","en":"Channel","adminOnly":true,"chemin":[]},
  {"cle":"connecteurs","href":"/connecteurs","fr":"Connecteurs API","en":"API connectors","adminOnly":true,"chemin":["Tools"]},
  {"cle":"contacts","href":"/contacts","fr":"mini-CRM","en":"mini-CRM","adminOnly":true,"chemin":[]},
  {"cle":"dashboard-quali","href":"/dashboard/quali","fr":"Qualitatif","en":"Qualitative","adminOnly":true,"chemin":[]},
  {"cle":"dashboard-tableaux","href":"/dashboard/tableaux","fr":"Mes tableaux","en":"My reports","adminOnly":true,"chemin":[]},
  {"cle":"email-templates","href":"/email-templates","fr":"Modèles","en":"Templates","adminOnly":true,"chemin":["Contenu","Email"]},
  {"cle":"fields","href":"/fields","fr":"Champs","en":"Fields","adminOnly":true,"chemin":["Contenu","Bibliothèque"]},
  {"cle":"flows","href":"/flows","fr":"Formulaires","en":"Forms","adminOnly":true,"chemin":["Contenu","WhatsApp"]},
  {"cle":"inbox","href":"/inbox","fr":"Inbox","en":"Inbox","adminOnly":false,"chemin":[]},
  {"cle":"mba-guide","href":"/mba","fr":"MBA, guide","en":"MBA, guide","adminOnly":true,"chemin":["AI Agent","MBA"]},
  {"cle":"mba-settings","href":"/mba/parametres","fr":"MBA, paramètres","en":"MBA, settings","adminOnly":true,"chemin":["AI Agent","MBA"]},
  {"cle":"mcp","href":"/developers/mcp","fr":"Serveur MCP","en":"MCP server","adminOnly":true,"chemin":["Developers"]},
  {"cle":"nodes","href":"/nodes","fr":"Blocs","en":"Blocks","adminOnly":true,"chemin":["Contenu","Bibliothèque"]},
  {"cle":"outils-espace","href":"/outils","fr":"Outils","en":"Tools","adminOnly":true,"chemin":["Tools"]},
  {"cle":"parametres","href":"/parametres","fr":"Paramètres","en":"Settings","adminOnly":true,"chemin":[]},
  {"cle":"perf-synthese","href":"/performance","fr":"Synthèse","en":"Summary","adminOnly":true,"chemin":[]},
  {"cle":"quanti-couts","href":"/dashboard/couts","fr":"Coûts","en":"Costs","adminOnly":true,"chemin":["Quantitatif"]},
  {"cle":"quanti-erreurs","href":"/dashboard/erreurs","fr":"Erreurs","en":"Errors","adminOnly":true,"chemin":["Quantitatif"]},
  {"cle":"quanti-funnel","href":"/dashboard/funnel","fr":"Funnel","en":"Funnel","adminOnly":true,"chemin":["Quantitatif"]},
  {"cle":"quanti-messages","href":"/dashboard","fr":"Messages & contacts","en":"Messages & contacts","adminOnly":true,"chemin":["Quantitatif"]},
  {"cle":"rcs-messages","href":"/rcs-messages","fr":"Messages","en":"Messages","adminOnly":true,"chemin":["Contenu","RCS"]},
  {"cle":"securite-audit","href":"/securite/audit","fr":"Audit trails","en":"Audit trails","adminOnly":true,"chemin":["Sécurité"]},
  {"cle":"securite-consentement","href":"/securite/consentement","fr":"Consentement","en":"Consent","adminOnly":true,"chemin":["Sécurité"]},
  {"cle":"securite-erreurs","href":"/securite/erreurs","fr":"Journal des erreurs","en":"Error log","adminOnly":true,"chemin":["Sécurité"]},
  {"cle":"securite-ia","href":"/securite/ia","fr":"IA","en":"AI","adminOnly":true,"chemin":["Sécurité"]},
  {"cle":"support","href":"/support","fr":"Support","en":"Support","adminOnly":true,"chemin":[]},
  {"cle":"tags","href":"/tags","fr":"Étiquettes","en":"Tags","adminOnly":true,"chemin":["Contenu","Bibliothèque"]},
  {"cle":"templates","href":"/templates","fr":"Templates","en":"Templates","adminOnly":true,"chemin":["Contenu","WhatsApp"]},
  {"cle":"webhooks","href":"/webhooks","fr":"Webhooks","en":"Webhooks","adminOnly":true,"chemin":["Tools"]},
  {"cle":"workflows","href":"/workflows","fr":"Scénario","en":"Scenario","adminOnly":true,"chemin":["Contenu"]},
];
