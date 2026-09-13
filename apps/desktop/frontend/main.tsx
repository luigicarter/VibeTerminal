import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import App from "./App";
import VoiceOverlay from "./VoiceOverlay";
import "./styles.css";
import { initializeChatPersistence } from './chatPersistence';
document.documentElement.dataset.density = window.localStorage.getItem("vibe-terminal:chrome-density:v1") || "comfortable";

const root = ReactDOM.createRoot(document.getElementById('root')!);
const voice = new URLSearchParams(window.location.search).get('surface') === 'voice';
async function start() {
  try {
    if (!voice) await initializeChatPersistence();
    root.render(<React.StrictMode>{voice ? <VoiceOverlay /> : <App />}</React.StrictMode>);
  } catch (error) {
    root.render(<main style={{ padding: 32, color: '#eee', fontFamily: 'system-ui' }}><h1>Saved workspace could not be opened</h1><p>{String(error instanceof Error ? error.message : error)}</p><p>Your saved files have been kept. Retry after resolving the storage problem.</p><button onClick={() => location.reload()}>Retry</button></main>);
  }
}
void start();
