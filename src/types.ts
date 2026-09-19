import type { components } from "@garage-opener/contract/bridge";

export type Schemas = components["schemas"];
export type DoorState = Schemas["DoorState"];
export type State = Schemas["State"];
export type CommandResult = Schemas["CommandResult"];
export type CommandAccepted = Schemas["CommandAccepted"];
export type Hold = Schemas["Hold"];
export type Alert = Schemas["Alert"];
export type AlertRule = Alert["rule"];
export type AlertAction = Alert["actions"][number];
export type VehiclePresence = Schemas["VehiclePresence"];
export type Health = Schemas["Health"];
export type Discovery = Schemas["Discovery"];
export type ApiError = Schemas["Error"];
export type DoorCommand = "open" | "close" | "toggle";

export interface AutoAction {
  id: string;
  rule: AlertRule;
  command: DoorCommand;
  at: string;
  undoUntil: string;
  auditId: number;
}

export const iso = (ms: number): string => new Date(ms).toISOString();
