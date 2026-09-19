import { EventEmitter } from "node:events";
import type { Alert, AutoAction, CommandResult, Hold, State, VehiclePresence } from "../types.js";
import type { ClassifiedEvent } from "../webhooks/classify.js";

export interface BusEvents {
  state: [State];
  command: [CommandResult];
  alert: [Alert];
  hold: [Hold];
  vehicle: [VehiclePresence];
  "auto-action": [AutoAction];
  "protect-event": [ClassifiedEvent];
}

export class Bus extends EventEmitter<BusEvents> {}
