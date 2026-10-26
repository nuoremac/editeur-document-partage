import crypto from 'node:crypto';
import { createClient } from 'redis';

export type RealtimeEvent = { type: string; payload: Record<string, unknown>; origin: string; target?: string };
export const realtimeInstanceId = crypto.randomUUID();

let publisher: ReturnType<typeof createClient> | undefined;
let subscriber: ReturnType<typeof createClient> | undefined;
let started = false;
let eventHandler: ((event: RealtimeEvent) => void | Promise<void>) | undefined;

export async function startRealtimeBus(handler: (event: RealtimeEvent) => void | Promise<void>) {
  eventHandler = handler;
  if (started || !process.env.REDIS_URL) return;
  publisher = createClient({ url: process.env.REDIS_URL });
  subscriber = publisher.duplicate();
  publisher.on('error', (error) => console.error('Erreur Redis (publication).', error));
  subscriber.on('error', (error) => console.error('Erreur Redis (abonnement).', error));
  try {
    await Promise.all([publisher.connect(), subscriber.connect()]);
    await subscriber.pSubscribe('atelier:*', (raw) => {
      try {
        const event = JSON.parse(raw) as RealtimeEvent;
        if (event.origin !== realtimeInstanceId && (!event.target || event.target === realtimeInstanceId)) void eventHandler?.(event);
      } catch (error) { console.error('Événement Redis invalide.', error); }
    });
    started = true;
  } catch (error) { console.error('Bus Redis indisponible; les événements resteront locaux.', error); }
}

export async function publishRealtimeEvent(type: string, payload: Record<string, unknown>, target?: string) {
  if (!publisher?.isOpen) return;
  const event: RealtimeEvent = { type, payload, origin: realtimeInstanceId, ...(target ? { target } : {}) };
  try { await publisher.publish('atelier:events', JSON.stringify(event)); }
  catch (error) { console.error(`Échec de publication de l’événement ${type}.`, error); }
}
