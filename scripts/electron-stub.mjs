import { spawn } from "node:child_process";
import {
  createDevEnv,
  developmentEnvFile,
  developmentLogFile,
  openDevApp,
  quitDevApp,
  writeDevEnv,
} from "./dev-app.mjs";

writeDevEnv(developmentEnvFile(), createDevEnv(process.env));
openDevApp();
const tail = spawn("tail", ["-n", "+1", "-F", developmentLogFile()], {
  stdio: ["ignore", "inherit", "inherit"],
});

function shutdown() {
  tail.kill();
  quitDevApp();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
