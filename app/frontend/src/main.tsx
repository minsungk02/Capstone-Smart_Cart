import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { registerSW } from "virtual:pwa-register";
import "./index.css";
import App from "./App";
import { createAppQueryClient } from "./queryClient";

registerSW({ immediate: true });

const queryClient = createAppQueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter unstable_useTransitions={false}>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
