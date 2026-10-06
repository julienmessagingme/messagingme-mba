import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import { registerContactVitrine, VITRINE } from '../src/http/contact-vitrine';
import type { ContactVitrineDeps } from '../src/http/contact-vitrine';

type Courriel = Parameters<ContactVitrineDeps['envoyer']>[0];

function monter(over: Partial<ContactVitrineDeps> = {}) {
  const envois: Courriel[] = [];
  const deps: ContactVitrineDeps = { enabled: true, envoyer: async (c) => { envois.push(c); }, ...over };
  return { app: buildServer({ queue: new FakeQueue(), contactVitrine: deps }), envois };
}

const FORMULAIRE = { 'content-type': 'application/x-www-form-urlencoded' };
const champs = (over: Record<string, string> = {}) => new URLSearchParams({
  nom: 'Léa Martin', societe: 'Odalys', email: 'lea@exemple.fr', telephone: '06 12 34 56 78',
  message: 'Bonjour,\nune démo des chaînes ?', site: '', ...over,
}).toString();
const poster = (app: ReturnType<typeof buildServer>, corps: string) =>
  app.inject({ method: 'POST', url: '/vitrine/contact', headers: FORMULAIRE, payload: corps });

describe('POST /vitrine/contact (formulaire de la vitrine)', () => {
  it('envoie le courriel et renvoie sur la page de remerciement de la vitrine', async () => {
    const { app, envois } = monter();
    const res = await poster(app, champs());
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`${VITRINE}/contact/merci/`);
    expect(envois).toHaveLength(1);
    expect(envois[0]!.sujet).toBe('[Vitrine Messaging Me] Léa Martin, Odalys');
    expect(envois[0]!.repondreA).toBe('lea@exemple.fr');
    expect(envois[0]!.texte).toContain('Téléphone : 06 12 34 56 78');
    expect(envois[0]!.texte).toContain('Bonjour,\nune démo des chaînes ?');
  });

  it('un retour à la ligne dans le nom ne passe pas dans le sujet', async () => {
    const { app, envois } = monter();
    await poster(app, champs({ nom: 'Léa\r\nBcc: x@y.fr', societe: '' }));
    expect(envois[0]!.sujet).toBe('[Vitrine Messaging Me] Léa Bcc: x@y.fr');
  });

  it.each([
    ['sans message', { message: '   ' }],
    ['sans nom', { nom: '' }],
    ['une adresse fausse', { email: 'pas-une-adresse' }],
    ['un message trop long', { message: 'x'.repeat(5001) }],
  ])('refuse %s : retour au formulaire, rien n’est envoyé', async (_cas, over) => {
    const { app, envois } = monter();
    const res = await poster(app, champs(over));
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe(`${VITRINE}/contact/?erreur=champs#formulaire`);
    expect(envois).toHaveLength(0);
  });

  it('le pot de miel : même réponse qu’un envoi réussi, rien n’est envoyé, et le plafond n’est pas entamé', async () => {
    const { app, envois } = monter();
    for (let i = 0; i < 12; i++) {
      const res = await poster(app, champs({ site: 'https://spam.example' }));
      expect(res.headers.location).toBe(`${VITRINE}/contact/merci/`);
    }
    expect(envois).toHaveLength(0);
    expect((await poster(app, champs())).headers.location).toBe(`${VITRINE}/contact/merci/`);
    expect(envois).toHaveLength(1);
  });

  it('au-delà de dix envois en dix minutes, le suivant est refusé', async () => {
    const { app, envois } = monter();
    for (let i = 0; i < 10; i++) await poster(app, champs());
    const res = await poster(app, champs());
    expect(res.headers.location).toBe(`${VITRINE}/contact/?erreur=trop#formulaire`);
    expect(envois).toHaveLength(10);
  });

  it('envoi non configuré ou en échec : retour au formulaire avec l’erreur d’envoi', async () => {
    const coupe = monter({ enabled: false });
    expect((await poster(coupe.app, champs())).headers.location).toBe(`${VITRINE}/contact/?erreur=envoi#formulaire`);
    expect(coupe.envois).toHaveLength(0);

    const erreur = vi.spyOn(console, 'error').mockImplementation(() => {});
    const panne = monter({ envoyer: async () => { throw new Error('Resend HTTP 500'); } });
    expect((await poster(panne.app, champs())).headers.location).toBe(`${VITRINE}/contact/?erreur=envoi#formulaire`);
    expect(erreur).toHaveBeenCalledTimes(1);
    erreur.mockRestore();
  });

  it('le lecteur de formulaire reste dans la portée de la route : ailleurs, un corps urlencoded est refusé', async () => {
    const app = Fastify({ logger: false });
    registerContactVitrine(app, { enabled: true, envoyer: async () => {} });
    app.post('/ailleurs', async () => ({ ok: true }));
    const res = await app.inject({ method: 'POST', url: '/ailleurs', headers: FORMULAIRE, payload: 'a=1' });
    expect(res.statusCode).toBe(415);
  });
});
