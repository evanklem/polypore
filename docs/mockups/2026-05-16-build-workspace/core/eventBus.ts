import { TimelineEvent, VerifyRun, WorkflowNode } from './types';

export type AppEvent =
  | { type: 'timeline:event'; event: TimelineEvent }
  | { type: 'workflow:update'; nodes: WorkflowNode[] }
  | { type: 'verify:run-recorded'; run: VerifyRun }
  | { type: 'agent:connection-changed'; connected: boolean };

type Listener = (event: AppEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private ring: AppEvent[] = [];

  constructor(private readonly maxBufferedEvents = 250) {}

  publish(event: AppEvent) {
    this.ring = [...this.ring.slice(-(this.maxBufferedEvents - 1)), event];
    this.listeners.forEach((listener) => listener(event));
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return [...this.ring];
  }
}

export const appEventBus = new EventBus();
