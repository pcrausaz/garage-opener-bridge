import type { Alert } from "../types.js";

export interface NotificationTransport {
  readonly name: string;
  notify(alert: Alert): Promise<void>;
}

export interface OutboundEvent {
  id: string;
  type: "door.state" | "door.command" | "alert" | "hold" | "vehicle" | "auto-action";
  at: string;
  data: unknown;
}
