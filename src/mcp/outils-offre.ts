import { ficheOutilMcp } from '../../web/lib/partage/catalogue-mcp';
import { DROITS_CLE_APPLICATION, VARIABLE_CLE, type ApiScope } from '../../web/lib/partage/droits-api';
import type { OutilMcp } from './outils';
import { RefusOutil, texteObligatoire, valeurOuRefus } from './saisie';
import { LOURDE, ecriture, plafondCouteux, signataire } from './outils-agent';
import { creerCleApi } from '../auth/creer-cle';
import { PRIX_PRO_HT_CENTIMES } from '../offres/offres';
import type { PeriodicitePro, RetourPro } from '../stripe/pro';
import type { Issue } from '../lib/issue';

/**
 * CE QU'UNE FREE FAIT DEPUIS CLAUDE CODE PLUTÔT QUE DANS LA CONSOLE (spec offres v2, livraison 4) : créer la clé de son
 * application, et payer le Pro. Les MÊMES fonctions que la console (`creerCleApi`, `ouvrirPro`) : l'outil n'y ajoute que
 * la personne (un consentement OAuth, que seul un administrateur donne) et le plafond des opérations lourdes.
 */
export interface DepsOffreMcp {
  /** Le paiement du Pro, la MÊME ouverture que `POST /offre/paiement` (`ouvrirPro`, `src/stripe/pro.ts`). */
  ouvrir(tenantId: string, periodicite: PeriodicitePro, payeur: string, retour: RetourPro): Promise<Issue<{ url: string; portail: boolean; essaiJours?: number }>>;
}

/**
 * Les droits qu'une clé créée par Claude peut porter : une clé à droits LIMITÉS (spec offres v2). Ni le MCP, ni les
 * webhooks, ni la suppression de contacts : une consigne glissée dans un message que Claude lit ne fabrique pas une clé
 * qui exfiltre ou efface, et qui survivrait à la révocation de Claude. Ces clés-là se créent dans la console.
 */
const DROITS_PAR_CLAUDE = ['contacts:read', 'contacts:write', 'sends:create', 'conversations:read', 'templates:write'] as const satisfies readonly ApiScope[];

const PERIODICITES: readonly PeriodicitePro[] = ['mois', 'an'];

export const OUTILS_OFFRE: OutilMcp[] = [
  {
    ...ficheOutilMcp('create_api_key'),
    fonction: null,
    description:
      'Creates an API key for the workspace\'s application, the one its code uses to call the API. The key is shown ONCE, '
      + 'in this result, and it passes through this conversation with the assistant: put it at once in the application\'s '
      + `.env file as ${VARIABLE_CLE} (a file git does not track), never in the code, and revoke it in the console (API keys) `
      + `if it leaks. Without scopes, the application key's: ${DROITS_CLE_APPLICATION.join(', ')}. Only limited scopes; a key `
      + 'with MCP, webhook or contact deletion scopes is created in the console. The plan caps active keys '
      + '(the refusal plan_limit_reached says so; revoking one frees a place). ' + LOURDE,
    // Une clé de plus à chaque appel ; rien ne sort chez un tiers.
    annotations: ecriture('Create an API key', false, false),
    entree: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 100, description: 'A name to recognise the key, e.g. "My application".' },
        scopes: {
          type: 'array', items: { type: 'string', enum: [...DROITS_PAR_CLAUDE] }, minItems: 1,
          description: 'The scopes of the key; omit for the application key\'s.',
        },
      },
      required: ['name'],
    },
    async executer(deps, tenantId, args, personne) {
      const auteur = signataire(personne);
      const nom = texteObligatoire(args, 'name', 100);
      const permis: readonly string[] = DROITS_PAR_CLAUDE;
      if (args.scopes !== undefined && (!Array.isArray(args.scopes) || !args.scopes.every((s) => typeof s === 'string' && permis.includes(s)))) {
        throw new RefusOutil('scopes : une liste de droits, parmi ' + DROITS_PAR_CLAUDE.join(', ')
          + ' ; une clé aux droits plus larges (MCP, webhooks, suppression de contacts) se crée dans la console');
      }
      const scopes = (args.scopes as string[] | undefined) ?? [...DROITS_CLE_APPLICATION];
      await plafondCouteux(deps, tenantId);
      const cle = valeurOuRefus(await creerCleApi(deps.cles, tenantId, nom, scopes, { userId: auteur, email: null }, 'mcp'));
      return { ...cle, variable: VARIABLE_CLE, montree_une_fois: true };
    },
  },
  {
    ...ficheOutilMcp('subscribe_pro'),
    fonction: null,
    description:
      'Opens the payment of the Pro plan and returns the URL of the Stripe checkout page; the payment itself is made by the '
      + `person on that page (monthly: €${PRIX_PRO_HT_CENTIMES.mois / 100}, yearly: €${PRIX_PRO_HT_CENTIMES.an / 100}, `
      + 'EXCLUDING TAX, the tax calculated by Stripe from the country and VAT number entered there). The plan switches '
      + 'once Stripe has confirmed it (get_plan). A workspace that never had Pro starts with a 14-day free trial '
      + '(essai_jours): the card is entered on that page, nothing is charged before the trial ends, and the plan switches at '
      + 'once; get_plan then tells when the trial ends. A workspace already on Pro gets its Stripe portal instead (portail: true); '
      + 'an Entreprise workspace is refused. ' + LOURDE,
    // Monde ouvert : elle crée une session chez Stripe. Non idempotente : une session de plus à chaque appel.
    annotations: ecriture('Open the Pro plan payment', false, true),
    entree: {
      type: 'object',
      properties: { periodicite: { type: 'string', enum: [...PERIODICITES], description: 'mois (monthly) or an (yearly).' } },
      required: ['periodicite'],
    },
    async executer(deps, tenantId, args, personne) {
      const payeur = signataire(personne);
      const periodicite = args.periodicite;
      if (periodicite !== 'mois' && periodicite !== 'an') throw new RefusOutil('periodicite : mois ou an');
      await plafondCouteux(deps, tenantId);
      // Retour sur la page publique « paiement reçu » : la personne de Claude Code n'a pas de session de console.
      const p = valeurOuRefus(await deps.offre.pro.ouvrir(tenantId, periodicite, payeur, 'claude'));
      // Le portail d'un espace déjà Pro n'est pas un paiement : aucun montant que Claude annoncerait « à payer ».
      if (p.portail) return { url: p.url, portail: true };
      return {
        url: p.url,
        periodicite,
        portail: false,
        montant_ht_eur: PRIX_PRO_HT_CENTIMES[periodicite] / 100,
        taxe: 'calculée par Stripe sur la page de paiement, selon le pays et le numéro de TVA saisis',
        // L'essai (spec offres v2) : rien n'est prélevé avant sa fin, la carte est demandée sur la page.
        ...(p.essaiJours ? { essai_jours: p.essaiJours } : {}),
      };
    },
  },
];

