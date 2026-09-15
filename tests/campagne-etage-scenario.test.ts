import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * L'ÉCRAN D'UNE CAMPAGNE LANCÉE : CE QU'ELLE A ENVOYÉ.
 *
 * 🔴 CONSTATÉ PAR JULIEN LE 2026-09-15, et mesuré en base : une campagne « modèle + scénario » ne stocke
 * AUCUN `template_name` dans `campaign_etages` (le modèle est le PREMIER BLOC du parcours). L'écran
 * affichait donc « WhatsApp : contenu inconnu · puis le scénario 40f4a189 », c'est-à-dire un aveu
 * d'ignorance juste à côté de la réponse, et un code à la place d'un nom.
 */
const store = readFileSync(resolve(__dirname, '../src/campaign/store.pg.ts'), 'utf8');
const ecran = readFileSync(resolve(__dirname, '../web/app/campaigns/page.tsx'), 'utf8');
const funnel = readFileSync(resolve(__dirname, '../web/app/dashboard/funnel/page.tsx'), 'utf8');
const carte = readFileSync(resolve(__dirname, '../web/components/analytics/cartes.tsx'), 'utf8');

describe('le nom du scénario', () => {
  it('🔴 il est JOINT à la lecture, jamais écrit dans l’étage', () => {
    // Le figer dans la campagne créerait une seconde vérité qui vieillirait : un scénario se renomme.
    expect(store).toContain('left join workflows w on w.id = e.workflow_id');
    expect(store).toContain('workflowName: e.workflow_name');
    // Et la colonne n'existe pas à l'écriture : la liste des colonnes insérées ne la porte pas.
    const insert = store.slice(store.indexOf('insert into campaign_etages'));
    expect(insert.slice(0, 200)).not.toContain('workflow_name');
  });

  it('🔴 la jointure est EXTERNE : un scénario supprimé ne fait pas disparaître l’étage', () => {
    // Un `join` simple perdrait la ligne entière, donc la campagne paraîtrait n'avoir rien envoyé.
    const bloc = store.slice(store.indexOf('from campaign_etages e'), store.indexOf('where e.campaign_id'));
    expect(bloc).toContain('left join');
  });

  it('🔴 l’écran montre le NOM, et l’identifiant seulement à défaut', () => {
    expect(ecran).toContain('e.workflowName ? `« ${e.workflowName} »` : e.workflowId.slice(0, 8)');
    // Et il DIT que le scénario a été supprimé, au lieu d'afficher un code nu sans explication.
    expect(ecran).toContain("{!e.workflowName && <span");
  });

  it('🔴 « contenu inconnu » ne s’affiche PLUS quand il y a un scénario', () => {
    // L'ordre des branches est le sujet : `workflowId` doit être testé AVANT le repli.
    const bloc = ecran.slice(ecran.indexOf('{e.templateName'), ecran.indexOf('{e.workflowId && ('));
    expect(bloc.indexOf('e.workflowId')).toBeGreaterThan(-1);
    expect(bloc.indexOf("t('contenu inconnu'")).toBeGreaterThan(bloc.indexOf('e.workflowId'));
  });
});

describe('le chemin vers les résultats', () => {
  it('🔴 l’écran des campagnes mène au funnel FILTRÉ sur la campagne', () => {
    expect(ecran).toContain('/dashboard/funnel?campagne=${encodeURIComponent(detail.id)}');
  });

  it('🔴 et le funnel LIT ce paramètre, sinon le lien ne filtrerait rien', () => {
    // Le maillon du milieu : c'est exactement celui qui manquait au filtre par membre de l'Inbox.
    expect(funnel).toContain("useSearchParams().get('campagne')");
    expect(funnel).toContain('initiale={demandee ? [demandee] : undefined}');
    expect(carte).toContain('initiale?: string[]');
  });

  it('⚠️ un identifiant périmé rend l’écran NORMAL, jamais un entonnoir vide', () => {
    // Un lien partagé survit à la suppression de la campagne : il doit retomber sur le défaut, pas sur
    // un funnel à zéro qui se lirait « cette campagne n'a rien envoyé ».
    expect(carte).toContain('.filter((id) => campaigns.some((c) => c.id === id))');
  });

  it('⚠️ et le choix de l’utilisateur GAGNE toujours sur le filtre de l’adresse', () => {
    expect(carte).toContain('choisies.length > 0 ? choisies : parDefaut');
  });
});
