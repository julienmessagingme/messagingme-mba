import { describe, it, expect } from 'vitest';
import { buildTemplateComponents } from '../src/meta/template-components';

describe('buildTemplateComponents', () => {
  it('header IMAGE -> paramètre type=image', () => {
    const c = buildTemplateComponents({ bodyParams: [], headerMediaUrl: 'https://x.fr/a.jpg', headerFormat: 'IMAGE' });
    expect(c).toEqual([{ type: 'header', parameters: [{ type: 'image', image: { link: 'https://x.fr/a.jpg' } }] }]);
  });

  it('header VIDEO -> paramètre type=video (pas image !)', () => {
    const c = buildTemplateComponents({ bodyParams: [], headerMediaUrl: 'https://x.fr/v.mp4', headerFormat: 'VIDEO' });
    expect(c).toEqual([{ type: 'header', parameters: [{ type: 'video', video: { link: 'https://x.fr/v.mp4' } }] }]);
  });

  it('header DOCUMENT -> paramètre type=document', () => {
    const c = buildTemplateComponents({ bodyParams: [], headerMediaUrl: 'https://x.fr/d.pdf', headerFormat: 'DOCUMENT' });
    expect(c).toEqual([{ type: 'header', parameters: [{ type: 'document', document: { link: 'https://x.fr/d.pdf' } }] }]);
  });

  it('format absent mais URL fournie -> image par défaut', () => {
    const c = buildTemplateComponents({ bodyParams: [], headerMediaUrl: 'https://x.fr/a.jpg' });
    expect((c[0] as { parameters: Array<{ type: string }> }).parameters[0]?.type).toBe('image');
  });

  it('variables du corps -> body avec paramètres texte, dans l ordre', () => {
    const c = buildTemplateComponents({ bodyParams: ['Julie', 'Lyon'] });
    expect(c).toEqual([{ type: 'body', parameters: [{ type: 'text', text: 'Julie' }, { type: 'text', text: 'Lyon' }] }]);
  });

  it('header média + corps -> les deux components, header en premier', () => {
    const c = buildTemplateComponents({ bodyParams: ['Julie'], headerMediaUrl: 'https://x.fr/a.jpg', headerFormat: 'IMAGE' });
    expect(c).toHaveLength(2);
    expect((c[0] as { type: string }).type).toBe('header');
    expect((c[1] as { type: string }).type).toBe('body');
  });

  it('rien -> aucun component', () => {
    expect(buildTemplateComponents({ bodyParams: [] })).toEqual([]);
  });
});
