/**
 * Dev server: runs locally with production data, no WhatsApp connection.
 * Usage: npm run dev:local
 *
 * Serves the full API + static frontend on port 3001.
 * Uses events-prod.db (downloaded from Railway) so you can iterate on
 * frontend and API changes without waiting for Railway redeployment.
 *
 * Env vars PORT, DB_PATH, ADMIN_TOKEN are set in the npm script.
 */
import { config } from "./config";
import { startServer } from "./server";
import { EventStore } from "./store";
import { RelationshipStore } from "./apps/relationship/store";
import { createRelationshipRouter } from "./apps/relationship/routes";
import { AnalyzeProgress } from "./apps/relationship/analyzer";
import { MetacrisisStore } from "./apps/metacrisis/store";
import { createMetacrisisRouter } from "./apps/metacrisis/routes";
import { FriendsStore } from "./apps/friends/store";
import { createFriendsRouter, SendProgress } from "./apps/friends/routes";
import { createRecordingRouter } from "./apps/recording/routes";
import { createCallsRouter } from "./apps/calls/routes";

async function main() {
  console.log("=== DEV SERVER (no WhatsApp) ===");
  console.log(`Database: ${config.dbPath}`);
  console.log(`Port: ${config.port}`);
  console.log("");

  const store = new EventStore();
  console.log("Event store initialized.");

  const relationshipStore = new RelationshipStore();
  console.log("Relationship store initialized.");

  const metacrisisStore = new MetacrisisStore();
  console.log("Metacrisis store initialized.");

  const friendsStore = new FriendsStore();
  console.log("Friends store initialized.");

  // Stub functions for WhatsApp-dependent operations
  const notAvailable = async () => {
    throw new Error("Not available in dev mode (no WhatsApp connection)");
  };
  const notAvailableNum = async (): Promise<number> => {
    throw new Error("Not available in dev mode (no WhatsApp connection)");
  };

  const appRouters: { path: string; router: any; authLevel?: "admin" | "auth" }[] = [];

  // Relationship router
  const analyzeProgress: AnalyzeProgress = {
    active: false,
    phase: "idle",
    messageCount: 0,
    currentDay: 0,
    totalDays: 0,
    log: [],
  };
  appRouters.push({
    path: "/api/relationship",
    router: createRelationshipRouter(
      relationshipStore, notAvailable, notAvailableNum,
      notAvailableNum, notAvailable, analyzeProgress
    ),
    authLevel: "auth",
  });

  appRouters.push({
    path: "/api/recording",
    router: createRecordingRouter(relationshipStore),
  });

  appRouters.push({
    path: "/api/metacrisis",
    router: createMetacrisisRouter(
      metacrisisStore, notAvailable, notAvailable, notAvailable,
      notAvailableNum, notAvailableNum, undefined, undefined
    ),
  });

  const sendProgress: SendProgress = {
    active: false, phase: "idle", total: 0, sent: 0, failed: 0,
  };
  appRouters.push({
    path: "/api/friends",
    router: createFriendsRouter(
      friendsStore, notAvailableNum, notAvailableNum,
      async () => { throw new Error("Not available in dev mode"); },
      sendProgress, notAvailableNum, notAvailableNum,
      async () => ({ merged: 0, deleted: 0, remaining: 0 })
    ),
  });

  appRouters.push({
    path: "/api/calls",
    router: createCallsRouter(friendsStore),
  });

  startServer({
    store,
    statusChecker: () => ({ whatsappConnected: false }),
    qrCodeGetter: () => null,
    backfillTrigger: async () => { throw new Error("Not available in dev mode"); },
    backfillProgressGetter: () => ({
      active: false, phase: "idle" as const,
      totalMessages: 0, processedMessages: 0, eventsFound: 0,
      groupsScanned: 0, totalGroups: 0,
    }),
    appRouters,
  });

  console.log(`\n  Dev server ready at: http://localhost:${config.port}`);
  console.log(`  Friends:      http://localhost:${config.port}/friends.html`);
  console.log(`  Metacrisis:   http://localhost:${config.port}/metacrisis.html`);
  console.log(`  Relationship: http://localhost:${config.port}/relationship.html`);
  console.log(`  Events:       http://localhost:${config.port}/`);
  console.log(`\n  Login: email=${config.adminEmail} password=${config.adminPassword}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
