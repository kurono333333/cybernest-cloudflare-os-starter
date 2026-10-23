declare namespace Cloudflare {
  interface Env {
    CUSTOM_NAME: string;
    CUSTOM_MESSAGE: string;
  }

  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "CustomGatekeeper" | "KnowledgeAccountAccess";
  }
}
