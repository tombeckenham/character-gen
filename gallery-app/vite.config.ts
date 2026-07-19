import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// The gallery ships as ONE self-contained HTML file opened via file:// —
// fetch() and ES modules are blocked there, so every script/style is inlined.
export default defineConfig({
  base: "./",
  plugins: [react(), viteSingleFile()],
});
