import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { COEXISTENCE_BOUTON, COEXISTENCE_PHRASES, optionsFenetreMeta } from './fenetre-meta';
import { PREREQUIS_META } from './partage/etapes-meta';
import { LocaleFixe } from './i18n';
import { ParcoursNumero } from '@/components/ParcoursNumero';
import type { ApiConnexionNumero } from './api/connexion-numero';

/**
 * LA FENÊTRE DE META EN COEXISTENCE (plan `docs/superpowers/plans/2026-10-24-coexistence.md`, tâche 3) : le numéro reste
 * dans l'application WhatsApp Business. 🔴 Le parcours d'aujourd'hui ne bouge pas d'un caractère : seule la coexistence
 * ajoute son `featureType`.
 */
describe('optionsFenetreMeta', () => {
  it('🔴 hors coexistence : exactement les options d’aujourd’hui', () => {
    expect(optionsFenetreMeta('cfg-1', false)).toEqual({
      config_id: 'cfg-1', response_type: 'code', override_default_response_type: true, extras: { setup: {} },
    });
  });

  it('🔴 en coexistence : le featureType de Meta et la version 3 des informations de session, rien d’autre', () => {
    const o = optionsFenetreMeta('cfg-1', true);
    expect(o.extras).toEqual({ setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' });
    expect({ ...o, extras: undefined }).toEqual({ config_id: 'cfg-1', response_type: 'code', override_default_response_type: true, extras: undefined });
  });
});

/** Le parcours ouvert par un lien de Claude Code en mode `coexistence` : rendu côté serveur, sans navigateur. */
function rendre(locale: 'fr' | 'en'): string {
  const api = new Proxy({}, { get: () => () => new Promise(() => {}) }) as ApiConnexionNumero;
  return renderToStaticMarkup(createElement(LocaleFixe, { locale }, createElement(ParcoursNumero, {
    tenantId: 't1', api, choixInitial: 'coexistence', retour: 'brancher', connecte: false, surConnexion: () => {},
  })));
}

describe('le parcours en coexistence', () => {
  it('🔴 le choix déjà fait montre le bouton et ses deux phrases, et rien des autres choix', () => {
    const html = rendre('fr');
    const carte = html.slice(html.indexOf('data-testid="choix-coexistence-ouvert"'));
    expect(carte).not.toBe('');
    expect(carte).toContain(COEXISTENCE_BOUTON.fr);
    for (const p of COEXISTENCE_PHRASES) expect(carte).toContain(p.fr);
    expect(html).not.toContain('data-testid="choix-fourni"');
    expect(html).not.toContain('data-testid="choix-apporte-ouvert"');
    // Le prérequis du numéro n'est pas dit : le numéro de l'application est déjà choisi.
    expect(html).not.toContain(PREREQUIS_META[2]!.fr);
  });

  it('les mêmes, en anglais', () => {
    const html = rendre('en');
    expect(html).toContain(COEXISTENCE_BOUTON.en);
    for (const p of COEXISTENCE_PHRASES) expect(html).toContain(p.en.replace(/'/g, '&#x27;'));
  });

  it('🔴 le troisième prérequis de Meta cite ce bouton sous son nom exact', () => {
    // Il se lit partout (console, Claude, FAQ, vitrine, fiche) : renommer le bouton sans lui ferait citer un bouton absent.
    expect(PREREQUIS_META[2]!.fr).toContain(`« ${COEXISTENCE_BOUTON.fr} »`);
    expect(PREREQUIS_META[2]!.en).toContain(`“${COEXISTENCE_BOUTON.en}”`);
  });

  it('🔴 les textes exacts du plan : rien de « gratuit » pour ce qui part par Messaging Me', () => {
    expect(COEXISTENCE_BOUTON).toEqual({ fr: 'Garder mon application WhatsApp Business', en: 'Keep my WhatsApp Business app' });
    expect(COEXISTENCE_PHRASES.map((p) => p.fr)).toEqual([
      'Votre numéro reste dans l’application, où les messages que vous tapez restent gratuits ; ceux qui partent par Messaging Me '
        + 'sont facturés par Meta. L’application perd ses listes de diffusion, son catalogue, ses messages d’absence et ses '
        + 'étiquettes, et ses appareils liés sont déliés.',
      'Pas encore de compte Meta Business ? La fenêtre de Meta le crée en chemin, avec votre profil Facebook. Avant le premier '
        + 'modèle, Meta vous demandera un moyen de paiement sur votre compte WhatsApp.',
    ]);
    expect(COEXISTENCE_PHRASES.map((p) => p.en)).toEqual([
      'Your number stays in the app, where the messages you type stay free; those sent through Messaging Me are billed by Meta. '
        + 'The app loses its broadcast lists, catalogue, away messages and labels, and its linked devices are unlinked.',
      'No Meta Business account yet? Meta\'s window creates one on the way, with your Facebook profile. Before the first '
        + 'template, Meta will ask for a payment method on your WhatsApp account.',
    ]);
  });
});
