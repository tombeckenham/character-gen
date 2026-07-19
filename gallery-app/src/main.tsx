import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { router } from "./router.tsx";
// Side-effect import by design: Vite inlines the stylesheet into the single file.
// oxlint-disable-next-line no-unassigned-import
import "./styles.css";

const rootElement = document.querySelector("#root");
if (!rootElement) throw new Error("gallery: #root element missing");
createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
