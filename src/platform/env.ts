export interface Secrets {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  OWNER_LOGIN_SECRET?: string;
}
export type Env = Secrets & {
  APP_ORIGIN: string;
  OWNER_ID: string;
  BOT_ID: string;
  BUILD_REVISION: string;
  CALLBACK_HOSTS: string;
  OAUTH_REDIRECT_URIS: string;
  MODERATOR: CloudflareBindings["MODERATOR"];
};
