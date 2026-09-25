// Way Cloud support chat (Chatwoot). Loaded from a same-origin file so the page keeps a strict script policy.
const BASE_URL = "https://chatwoot.waycloud.com.br";
window.chatwootSettings = { position: "right", type: "standard", launcherTitle: "" };

const sdk = document.createElement("script");
sdk.src = `${BASE_URL}/packs/js/sdk.js`;
sdk.async = true;
sdk.onload = () => window.chatwootSDK.run({ websiteToken: "faJ18E6eznJ1QscCrH1MxK4b", baseUrl: BASE_URL });
document.head.append(sdk);
