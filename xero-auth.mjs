#!/usr/bin/env node

/**
 * Xero OAuth helper — authenticates with Xero and updates .mcp.json with a fresh bearer token.
 *
 * Usage:
 *   node xero-auth.mjs          # Uses refresh token if available, otherwise opens browser
 *   node xero-auth.mjs --login  # Forces browser login (ignores saved refresh token)
 */

import http from "http";
import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_JSON_PATH = path.join(__dirname, ".mcp.json");
const REFRESH_TOKEN_PATH = path.join(__dirname, ".xero-refresh-token");
const REDIRECT_URI = "http://localhost:3000/callback";
const SCOPES = "openid profile email accounting.transactions accounting.contacts accounting.settings accounting.reports.read accounting.journals.read offline_access";

function readMcpConfig() {
  const raw = fs.readFileSync(MCP_JSON_PATH, "utf-8");
  return JSON.parse(raw);
}

function writeMcpConfig(config) {
  fs.writeFileSync(MCP_JSON_PATH, JSON.stringify(config, null, 2) + "\n");
}

function getCredentials() {
  const config = readMcpConfig();
  const env = config.mcpServers?.xero?.env;
  if (!env?.XERO_CLIENT_ID || !env?.XERO_CLIENT_SECRET) {
    console.error("Error: XERO_CLIENT_ID and XERO_CLIENT_SECRET not found in .mcp.json");
    process.exit(1);
  }
  return { clientId: env.XERO_CLIENT_ID, clientSecret: env.XERO_CLIENT_SECRET };
}

function basicAuth(clientId, clientSecret) {
  return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

function loadRefreshToken() {
  try {
    return fs.readFileSync(REFRESH_TOKEN_PATH, "utf-8").trim();
  } catch {
    return null;
  }
}

function saveRefreshToken(token) {
  fs.writeFileSync(REFRESH_TOKEN_PATH, token, "utf-8");
}

function updateBearerToken(accessToken) {
  const config = readMcpConfig();
  config.mcpServers.xero.env.XERO_CLIENT_BEARER_TOKEN = accessToken;
  if (config.mcpServers["xero-local"]?.env) {
    config.mcpServers["xero-local"].env.XERO_CLIENT_BEARER_TOKEN = accessToken;
  }
  writeMcpConfig(config);
}

async function exchangeToken(params, clientId, clientSecret) {
  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth(clientId, clientSecret)}`,
    },
    body: new URLSearchParams(params),
  });
  return res.json();
}

async function refreshFlow(clientId, clientSecret, refreshToken) {
  console.log("Attempting token refresh...");
  const tokens = await exchangeToken(
    { grant_type: "refresh_token", refresh_token: refreshToken },
    clientId,
    clientSecret,
  );

  if (tokens.error) {
    console.log(`Refresh failed: ${tokens.error_description || tokens.error}`);
    return null;
  }

  return tokens;
}

function browserFlow(clientId, clientSecret) {
  return new Promise((resolve, reject) => {
    const authUrl =
      `https://login.xero.com/identity/connect/authorize` +
      `?response_type=code&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&scope=${encodeURIComponent(SCOPES)}&state=xero-oauth`;

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      // Ignore anything that isn't the callback with a code (e.g. favicon, preflight)
      const code = url.searchParams.get("code");
      if (url.pathname !== "/callback" || !code) {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        const tokens = await exchangeToken(
          { grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI },
          clientId,
          clientSecret,
        );

        if (tokens.error) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`Token error: ${tokens.error_description || tokens.error}`);
          server.close();
          reject(new Error(tokens.error));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Authenticated! You can close this tab.</h1>");
        server.close();
        resolve(tokens);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Error: ${err.message}`);
        server.close();
        reject(err);
      }
    });

    server.listen(3000, () => {
      console.log("Opening browser for Xero login...");
      exec(`open "${authUrl}"`);
    });
  });
}

async function main() {
  const forceLogin = process.argv.includes("--login");
  const { clientId, clientSecret } = getCredentials();

  let tokens = null;

  // Try refresh token first (unless --login)
  if (!forceLogin) {
    const refreshToken = loadRefreshToken();
    if (refreshToken) {
      tokens = await refreshFlow(clientId, clientSecret, refreshToken);
    }
  }

  // Fall back to browser login
  if (!tokens) {
    console.log(forceLogin ? "Forcing browser login..." : "No valid refresh token, opening browser...");
    tokens = await browserFlow(clientId, clientSecret);
  }

  // Save tokens
  updateBearerToken(tokens.access_token);
  if (tokens.refresh_token) {
    saveRefreshToken(tokens.refresh_token);
  }

  const expiresMin = Math.round(tokens.expires_in / 60);
  console.log(`\nDone! .mcp.json updated with new bearer token (valid for ${expiresMin} min).`);
  console.log("Restart Claude Code to pick up the new token.");

  if (tokens.refresh_token) {
    console.log("Refresh token saved — next time run without --login to auto-refresh.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
