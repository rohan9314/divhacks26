import { configDefaults, defineConfig } from "vitest/config";

// The DeepSpace backend (backend/), its old copy (backend-old/), the website (frontend/)
// and the MVP workspace (mvp/) are separate packages with their own dependencies and test runners.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "backend/**", "backend-old/**", "frontend/**", "mvp/**"],
  },
});
