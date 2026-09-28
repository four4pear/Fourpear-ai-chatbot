// Yazı tipleri kendi sunucumuzdan: ziyaretçinin IP'si Google'a gitmez.
import "@fontsource-variable/geist";
import "@fontsource/geist-mono/500.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
