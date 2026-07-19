import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import tailwindcss from "@tailwindcss/vite";

// The gallery ships as ONE self-contained HTML file opened via file:// —
// fetch() and ES modules are blocked there, so every script/style is inlined.
export default defineConfig({
  base: "./",
  plugins: [tailwindcss(), react(), viteSingleFile()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("src", import.meta.url)) },
  },
});
