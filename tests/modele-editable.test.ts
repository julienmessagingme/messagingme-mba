import { describe, it, expect } from 'vitest';
import { resumeDuModele } from '../src/meta/templates';

/**
 * UN MODÈLE N'EST ÉDITABLE QUE SI L'ÉDITION SAIT REFAIRE CHACUN DE SES BOUTONS (lot 3 de la marche arrière). La lecture
 * des boutons (`buttonsOf`) ne connaît que la réponse rapide, le lien et le Flow, et lit tout autre bouton comme une
 * réponse rapide : une édition, dans la console comme par Claude, remplaçait donc un bouton téléphone ou « code à
 * copier » par une réponse rapide, sans rien dire. Un tel modèle se lit désormais non éditable.
 */
const modele = (boutons: Array<Record<string, unknown>>) => resumeDuModele({
  id: 'tpl-1', name: 'essai', status: 'APPROVED', category: 'UTILITY', language: 'fr',
  components: [{ type: 'BODY', text: 'Bonjour' }, { type: 'BUTTONS', buttons: boutons }],
});

describe('l’éditabilité d’un modèle et ses boutons', () => {
  it('réponse rapide, lien et Flow : éditable', () => {
    expect(modele([{ type: 'QUICK_REPLY', text: 'Oui' }, { type: 'URL', text: 'Voir', url: 'https://a.example' }, { type: 'FLOW', text: 'Remplir', flow_id: 'f1' }]).editable).toBe(true);
  });

  it('🔴 un bouton que la lecture ne sait pas refaire rend le modèle non éditable', () => {
    for (const type of ['PHONE_NUMBER', 'COPY_CODE', 'VOICE_CALL', 'CATALOG', 'OTP', undefined]) {
      expect(modele([{ type: 'QUICK_REPLY', text: 'Oui' }, { type, text: 'Appeler' }]).editable, String(type)).toBe(false);
    }
  });
});
