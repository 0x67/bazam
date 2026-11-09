import { serveProcessPlugin } from "@bazam/core/plugin";
import manifest from "./manifest.ts";

await serveProcessPlugin(manifest);
