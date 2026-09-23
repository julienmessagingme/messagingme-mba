import type { TacheMba } from './api-mba';

/**
 * LE SEUL LIEN ENTRE UNE CLE DE TACHE DU SERVEUR ET UN ONGLET DE L ECRAN.
 *
 * 🔴 ELLE NE SE RECOPIE PAS. La route de completion (`src/mba/completion.ts`) rend une cle et une raison ;
 * elle ne sait pas comment l ecran est decoupe. Cette table est donc le seul endroit qui traduise
 * « il manque des compétences » en « ouvre l onglet Compétences », et une seconde copie divergerait au
 * premier ajout de tache. Elle vivait dans `MbaCompletion.tsx`, retiree le 2026-09-23 quand l en-tete
 * identitaire a remplace ce composant.
 *
 * ⚠️ `onglet` ABSENT = ca ne se regle pas sur cet ecran. Deux cas reels : le moyen de paiement, qui se pose
 * chez Meta, et les connecteurs, qui vivent sur la fiche d un agent IA. L etape reste AFFICHEE, sans lien :
 * la masquer ferait disparaitre une condition reelle d un ecran qui pretend les lister toutes.
 */
export const LIBELLES: Record<TacheMba['cle'], { fr: string; en: string; onglet?: string }> = {
  business_info: { fr: 'Informations', en: 'Business info', onglet: 'business' },
  faq: { fr: 'FAQ', en: 'FAQs', onglet: 'faq' },
  competences: { fr: 'Compétences', en: 'Skills', onglet: 'competences' },
  activation: { fr: 'Activation', en: 'Activation', onglet: 'activation' },
  paiement: { fr: 'Moyen de paiement', en: 'Payment method' },
  fichiers: { fr: 'Fichiers', en: 'Files', onglet: 'fichiers' },
  sites: { fr: 'Sites web', en: 'Websites', onglet: 'sites' },
  connecteurs: { fr: 'Connecteurs', en: 'Connectors' },
  outils: { fr: 'Outils', en: 'Tools' },
};
