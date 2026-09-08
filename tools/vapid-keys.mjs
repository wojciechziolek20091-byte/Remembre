/*
  Prints a fresh VAPID key pair, which is what lets a push service believe the
  notifications really come from this deployment.

  Run: node tools/vapid-keys.mjs

  Paste the three lines into the project's environment variables and redeploy.
  Keep the private key private, and keep the pair: changing it invalidates every
  device that has already subscribed, and each one has to turn reminders on
  again.
*/

import { generateVapidKeys } from "../api/_push.js";

const { publicKey, privateKey } = generateVapidKeys();

console.log("VAPID_PUBLIC_KEY");
console.log(publicKey);
console.log();
console.log("VAPID_PRIVATE_KEY");
console.log(privateKey);
console.log();
console.log("VAPID_SUBJECT");
console.log("mailto:you@example.com   <- change this to your own address");
