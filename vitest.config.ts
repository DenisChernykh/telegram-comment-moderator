import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          OWNER_LOGIN_SECRET: "test-owner-secret-at-least-32-characters",
          TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret-at-least-32-characters",
          TELEGRAM_BOT_TOKEN: "123456:test-only-token",
          BOT_ID: "123456",
        },
      },
    }),
  ],
});
