import React from "react";
import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import App from "./App";
import VoiceOverlay from "./VoiceOverlay";
import "./styles.css";
document.documentElement.dataset.density = window.localStorage.getItem("vibe-terminal:chrome-density:v1") || "comfortable";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).get("surface") === "voice" ? <VoiceOverlay /> : <App />}
  </React.StrictMode>
);
