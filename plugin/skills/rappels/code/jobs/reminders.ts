import { messagingme } from '../lib/messagingme';
import { saveReminder, tomorrowsAppointments } from '../lib/calendar';

// Run once a day, the evening before (a cron of your host). The template appointment_reminder has two variables,
// the first name then the time, and two quick reply buttons: Confirm and Reschedule.
export async function dayBeforeReminders(): Promise<void> {
  for (const appointment of await tomorrowsAppointments()) {
    const send = await messagingme.POST('/v1/sends', {
      body: {
        target: { template: { name: 'appointment_reminder', language: 'en' } },
        recipients: [{ phone: appointment.phone, variables: { firstName: appointment.firstName, time: appointment.time } }],
        params: [
          { position: 1, source: { type: 'variable', key: 'firstName' } },
          { position: 2, source: { type: 'variable', key: 'time' } },
        ],
      },
      // Run twice for the same appointment, the job does not send twice.
      idempotencyKey: `reminder-${appointment.id}`,
    });
    await saveReminder(appointment, send.sendId);
  }
}
