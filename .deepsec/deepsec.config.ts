import { defineConfig } from "deepsec/config";

export default defineConfig({
  projects: [
    { id: "popcorn", root: ".." },
    // <deepsec:projects-insert-above>
  ],
});
