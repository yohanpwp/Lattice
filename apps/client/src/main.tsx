import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@lattice/ui-core";
import "@lattice/ui-core/styles.css";
import { bootstrapPlatform } from "./bootstrap";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Failed to find the root element");
}

bootstrapPlatform().then((platform) => {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App platform={platform} />
    </React.StrictMode>
  );
});

