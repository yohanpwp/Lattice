import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.lattice.app",
  appName: "Lattice",
  webDir: "../client/dist",
  server: {
    androidScheme: "https",
    cleartext: false,
  },
};

export default config;
