import { describe, it, expect } from 'vitest';
import { renderBrandedEmail, renderInvitationEmail, escapeHtml } from '../src/support/email-templates';

describe('escapeHtml', () => {
  it('échappe les caractères dangereux', () => {
    expect(escapeHtml('<b>A & B "x" \'y\'</b>')).toBe('&lt;b&gt;A &amp; B &quot;x&quot; &#39;y&#39;&lt;/b&gt;');
  });
});

describe('renderBrandedEmail (shell réutilisable)', () => {
  const html = renderBrandedEmail({
    title: 'Un titre',
    bodyHtml: '<p>Corps</p>',
    ctaLabel: 'Agir maintenant',
    ctaUrl: 'https://mba.messagingme.app/x/TOK',
  });

  it('rend un document HTML complet avec le CTA et son URL', () => {
    expect(html).toContain('<!DOCTYPE html');
    expect(html).toContain('Agir maintenant');
    expect(html).toContain('https://mba.messagingme.app/x/TOK');
    // Bouton construit en table (pas de <button>).
    expect(html).not.toContain('<button');
  });

  it('porte l\'identité de marque (wordmark + tagline)', () => {
    expect(html).toContain('Messaging Me');
    expect(html).toContain('Business Agent');
    // Les 3 couleurs de la marque (barre d'accent) sont présentes.
    expect(html).toContain('#181C40');
    expect(html).toContain('#009AFE');
    expect(html).toContain('#17C74E');
  });

  it('n\'écrit JAMAIS « UChat »', () => {
    expect(html.toLowerCase()).not.toContain('uchat');
  });

  it('échappe le titre et l\'URL du CTA (données non fiables)', () => {
    const evil = renderBrandedEmail({
      title: '<script>alert(1)</script>',
      bodyHtml: '<p>ok</p>',
      ctaLabel: 'Go',
      ctaUrl: 'https://x.test/"><img>',
    });
    expect(evil).not.toContain('<script>alert(1)</script>');
    expect(evil).toContain('&lt;script&gt;');
    expect(evil).toContain('https://x.test/&quot;&gt;&lt;img&gt;');
  });
});

describe('renderInvitationEmail', () => {
  const acceptUrl = 'https://mba.messagingme.app/invite/INVITE_RAW';

  it('personnalise avec le nom de l\'invitant, l\'espace et le lien d\'acceptation', () => {
    const html = renderInvitationEmail({ inviterName: 'Julien', workspaceName: 'Acme Corp', acceptUrl, role: 'agent' });
    expect(html).toContain('Julien');
    expect(html).toContain('Acme Corp');
    expect(html).toContain(acceptUrl);
    // Rôle traduit dans le corps.
    expect(html).toContain('agent');
    // Jamais « UChat ».
    expect(html.toLowerCase()).not.toContain('uchat');
    // C'est bien le shell brandé (CTA présent).
    expect(html).toContain('Activer mon compte');
  });

  it('traduit le rôle admin', () => {
    const html = renderInvitationEmail({ inviterName: 'Boss', workspaceName: 'Acme', acceptUrl, role: 'admin' });
    expect(html).toContain('administrateur');
  });

  it('retombe sur une formulation générique sans nom d\'invitant ni d\'espace', () => {
    const html = renderInvitationEmail({ inviterName: null, workspaceName: null, acceptUrl, role: 'agent' });
    expect(html).toContain(acceptUrl);
    expect(html).toContain('un espace de travail');
    expect(html).toContain('Activer mon compte');
  });

  it('échappe un nom d\'invitant/espace malveillant (pas d\'injection de markup)', () => {
    const html = renderInvitationEmail({
      inviterName: '<img src=x onerror=alert(1)>',
      workspaceName: 'A & B <script>',
      acceptUrl,
      role: 'agent',
    });
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x');
    expect(html).toContain('A &amp; B');
  });
});
