import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import type { Instance } from "./instance.js";
import { advertisedUrl } from "./bonjour.js";

/**
 * First-run pairing.
 *
 * `BRIDGE_TOKENS` is the admin credential, and asking someone to copy it out of their compose file into
 * their phone is both awkward and the worst habit to teach — it is the one secret that should never travel.
 * So while no phone has joined yet, the bridge mints an ordinary single-use invite (the same mechanism the
 * Family screen uses) and prints its link. The app's Join sheet takes the whole `garageopener://join?…` URL
 * or just the code, so nothing has to be retyped and nothing permanent is exposed.
 *
 * It stops once any phone has joined. Restarting reprints, which is the recovery path when the 15-minute
 * window closes; after that, new phones are invited from the app.
 */
export function printPairingInvite(inst: Instance, config: Config, logger: Logger): void {
  if (config.bridge.mode !== "live" || !config.pairingBanner) return;
  if (inst.members.list().some((m) => m.kind === "member")) return;

  const bridgeUrl = (config.publicUrl ?? advertisedUrl(config.port) ?? `http://localhost:${config.port}`).replace(/\/+$/, "");
  const inv = inst.members.createInvite("first-run");
  const expiresUnix = Math.floor(Date.parse(inv.expiresAt) / 1000);
  const joinUrl = `garageopener://join?v=1&b=${encodeURIComponent(bridgeUrl)}&c=${inv.code}&e=${expiresUnix}`;
  const minutes = Math.max(1, Math.round((Date.parse(inv.expiresAt) - Date.now()) / 60_000));

  const banner = [
    "",
    "  ┌──────────────────────────────────────────────────────────────────────────┐",
    "  │  Pair your phone                                                         │",
    "  └──────────────────────────────────────────────────────────────────────────┘",
    "",
    "  In the app: tap Join with an invite on the first screen and paste the link below",
    "  (or just the code), or open the link on the phone.",
    "",
    `    ${joinUrl}`,
    "",
    `    bridge  ${bridgeUrl}`,
    `    code    ${inv.code}`,
    `    expires in ${minutes} minutes — restart the container for a fresh one`,
    "",
    "  Single use. Do not put your BRIDGE_TOKENS value into the app; this replaces it.",
    "  This stops being printed once a phone has joined.",
    "",
  ].join("\n");
  logger.info(banner);
}
