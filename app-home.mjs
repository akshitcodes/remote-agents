// Reliability modules historically import this name. Re-export the shared
// portability config authority so every bridge-owned file resolves the same
// REMOTE_AGENTS_HOME rather than maintaining two nearly-identical helpers.
export { configDir as remoteAgentsHome } from "./config.mjs";
