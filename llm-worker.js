// Runs the model off the main thread so typing and scrolling stay smooth.
import { WebWorkerMLCEngineHandler } from "./vendor/web-llm/index.js";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
