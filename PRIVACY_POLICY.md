# Privacy Policy

**Last Updated:** September 3, 2026

Verum ("the Extension") is a Chrome browser extension that browses `w3://` dapps whose data is stored on the Ethereum blockchain and cryptographically verifies it locally with the Helios light client. This Privacy Policy explains how the Extension handles your information.

---

## Data Collection

### Data Stored Locally on Your Device

The Extension stores the following data locally in your browser using Chrome's storage APIs:

- **User Settings**: Your configured chains and their Ethereum execution RPC, consensus (beacon-chain) RPC, and optional Portal Network endpoints, the default chain, the optional checkpoint used to bootstrap the Helios light client, and verification preferences (e.g. developer mode, forced verification mode, state/history sources).
- **Verification Cache**: Cached proof data and block state-root data, kept so verification is faster on repeat visits. Derived from public chain data.
- **Session State**: Ephemeral values such as the trusted-reads toggle, Helios sync checkpoints, and per-dapp broadcast preferences. Stored in `chrome.storage.session` and cleared when the browser restarts.
- **Game High Score**: A single best-score number for the offline mini-game shown on the error screen.

**Important**: All of this data remains on your device. The Extension has no servers and collects nothing from you.

---

## Data Transmission

The Extension transmits data to the following endpoints, all of which are either local to your machine or user-configured:

| Service                            | Data Sent                                            | Purpose                                                                                               |
| ---------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Your Ethereum execution RPC**    | Standard `eth_call` / `eth_getProof` requests        | Fetch and verify on-chain content via the Helios light client (endpoint is your choice)                |
| **Your Ethereum consensus RPC**    | Standard beacon-chain API requests                   | Bootstrap and keep the Helios light client synced (endpoint is your choice; a default is provided)    |
| **Historical data sources**        | Requests for historical data | Fetch and verify older content (endpoints are your choice; defaults are provided)                     |
| **Your local node**                | Requests over `127.0.0.1` / `localhost`, including an optional Portal Network node | Download data from a node running on your own device                                 |
| **Your wallet**                    | Account, signature, and transaction requests (over local extension messaging or a local WebSocket) | Sign and send transactions through the wallet you choose                            |
| **A dapp's broadcast endpoint**    | A signed transaction, only with your per-transaction approval | Broadcast a transaction to the endpoint the dapp specifies (e.g. an MEV-protection relay) when you approve it |

No data is sent to the Extension developer or to any first-party Verum server — there is no such server.

---

## Data We Do NOT Collect

- Browsing history or the pages you visit
- Personal information (name, email, wallet addresses, etc.)
- Analytics or usage tracking
- Keystrokes or form inputs
- Any data from pages you visit

---

## Data Retention

- **Local Data**: Stored until you clear it via the Extension options page or uninstall the Extension.
- **Session Data**: Session state is cleared automatically when the browser restarts.
- **No Server Storage**: No servers are operated for this Extension; no data ever leaves your device except to the local and user-configured endpoints listed above.

---

## Data Deletion

You can delete your data at any time:

1. **Reset Settings**: Use the options page to reset RPC endpoints and clear your configuration.
2. **Uninstall**: Uninstall the Extension to remove all stored data.
3. **Browser Data**: Clear the Extension's storage from Chrome's `chrome://extensions` settings.

---

## Third-Party Services

The Extension itself has no backend. However, by configuring the Extension you choose third-party endpoints that it communicates with on your behalf:

- **Ethereum execution RPC**: Whatever provider you configure (e.g. your own node, or a public RPC). Subject to that provider's own terms and privacy policy. A default is provided but can be overridden.
- **Ethereum consensus RPC**: Same as above; 
- **Historical data sources**: Providers used to fetch older content; defaults are provided but can be overridden.
- **Ethereum mainnet**: Queries are made to read chain state. This is a public blockchain; the operator of the RPC endpoint you choose can observe your queries.

The Extension does not route your reads through any public gateway by default. Its entire purpose is to remove that trusted third party from the path.

---

## Security

- The Extension runs a light client (Helios) that cryptographically verifies Ethereum execution-layer state against a synced consensus header. It does not trust RPC responses blindly.
- All code and WebAssembly is bundled at build time; no remote code is fetched or executed at runtime.
- Untrusted dapp content runs inside a sandboxed frame with a restrictive Content Security Policy.

---

## Children's Privacy

The Extension is not intended for use by children under 13 years of age. No information is knowingly collected from children.

---

## Changes to This Policy

This Privacy Policy may be updated from time to time. Changes will be reflected in the "Last Updated" date at the top of this document.

---

## Contact

If you have questions about this Privacy Policy, you can reach out via:

- GitHub: Open an issue in the repository
- Email: verumlab@proton.me

---

## Open Source

Verum (`verum-extension`) is open source. You can review the code to verify these privacy practices.