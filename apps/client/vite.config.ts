import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

function bundleNoticesPlugin() {
  return {
    name: "bundle-notices",
    closeBundle: async () => {
      const rootDir = resolve(__dirname, "../..");
      const noticePath = resolve(rootDir, "NOTICE");
      const thirdPartyPath = resolve(rootDir, "THIRD_PARTY_LICENSES.md");
      let noticeContent = "";
      try {
        noticeContent = await readFile(noticePath, "utf8");
      } catch {
        noticeContent = "Lattice Legal Notices\n";
      }
      let thirdPartyContent = "";
      try {
        thirdPartyContent = await readFile(thirdPartyPath, "utf8");
      } catch {
        thirdPartyContent = "";
      }
      const combined = `${noticeContent}\n\n${thirdPartyContent}`.trim();
      const assetsDir = resolve(__dirname, "dist/assets");
      await mkdir(assetsDir, { recursive: true });
      await writeFile(resolve(assetsDir, "notices.txt"), combined, "utf8");
    },
  };
}

export default defineConfig({
  plugins: [react(), bundleNoticesPlugin()],
  server: {
    port: 5173,
    host: true,
  },
});
