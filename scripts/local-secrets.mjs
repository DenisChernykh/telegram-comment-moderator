import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

await mkdir(".local", { recursive: true, mode: 0o700 });
let token = process.env.TELEGRAM_BOT_TOKEN ?? "";
try {
  token ||= (await readFile(".local/telegram-token", "utf8")).trim();
} catch {
  /* optional */
}
const random = () => randomBytes(32).toString("base64url");
await writeFile(
  ".dev.vars",
  [
    `OWNER_LOGIN_SECRET=${random()}`,
    `TELEGRAM_WEBHOOK_SECRET=${random()}`,
    `TELEGRAM_BOT_TOKEN=${token}`,
    "",
  ].join("\n"),
  { flag: "wx", mode: 0o600 },
);
console.log(
  "Created .dev.vars with independent random secrets (mode 0600). Values are not printed.",
);
