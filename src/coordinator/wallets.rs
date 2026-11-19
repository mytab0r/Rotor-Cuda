//! Rich-address wallet databases: an in-domain storefront and a streaming
//! mirror for the MIT-licensed Rich-Address-Wallet release files.
//!
//! The upstream URL is built only from a fixed per-chain allowlist; request
//! input selects a chain, never a host, path or file. Downloads are streamed
//! with a bounded timeout and a hard size cap so a stuck or oversized upstream
//! cannot buffer gigabytes in coordinator memory.

use std::io::{Read, Take};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tiny_http::{Request, Response, StatusCode};

use super::{
    App, breadcrumb_ld, breadcrumb_nav, client_ip, escape_attr, header, html_document, hub_head,
    respond_json, respond_rate_limited, site_header,
};

/// Public upstream project. No URL is exposed in customer-facing HTML.
pub const SOURCE_NAME: &str = "Rich-Address-Wallet";
/// Upstream license copied into `apps/site/wallets.LICENSE.txt`.
pub const LICENSE_TEXT: &str = include_str!("../../apps/site/wallets.LICENSE.txt");
pub const LICENSE_URL: &str = "/wallets/LICENSE.txt";
pub const LICENSE_NAME: &str = "MIT";
pub const COPYRIGHT: &str = "Copyright (c) 2022 MMDRZA";

/// Release mirror used when no operator override is configured. Server-side
/// constant only: no request field can influence it.
const DEFAULT_UPSTREAM: &str = "https://github.com/Pymmdrza/Rich-Address-Wallet/releases/download";
/// Hard cap for one proxied dataset. The largest listed file is the Bitcoin
/// rich list (~1.1 GB gzipped); anything bigger is refused before streaming.
const MAX_DOWNLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
/// Downloads are heavy: one every five seconds per IP with a burst of two.
const DOWNLOAD_RATE_PER_SECOND: f64 = 0.2;
const DOWNLOAD_BURST: f64 = 2.0;

pub struct Dataset {
    pub slug: &'static str,
    pub name: &'static str,
    pub symbol: &'static str,
    pub address_types: &'static str,
    pub icon: &'static str,
    /// Release tag on the upstream project.
    tag: &'static str,
    /// Asset file name inside that release.
    file: &'static str,
}

/// The chain allowlist. The order is the display order on the storefront.
pub const DATASETS: [Dataset; 6] = [
    Dataset {
        slug: "bitcoin",
        name: "Bitcoin",
        symbol: "BTC",
        address_types: "P2PKH · P2SH · Bech32",
        icon: "chain-bitcoin",
        tag: "Bitcoin",
        file: "Latest_Rich_Bitcoin_Address.txt.gz",
    },
    Dataset {
        slug: "ethereum",
        name: "Ethereum",
        symbol: "ETH",
        address_types: "EVM accounts",
        icon: "chain-ethereum",
        tag: "Ethereum",
        file: "Latest_Rich_Ethereum_Addresses.txt.gz",
    },
    Dataset {
        slug: "litecoin",
        name: "Litecoin",
        symbol: "LTC",
        address_types: "P2PKH · P2SH · Bech32",
        icon: "chain-litecoin",
        tag: "Litecoin",
        file: "Latest_Rich_Litecoin_Addresses.txt.gz",
    },
    Dataset {
        slug: "dogecoin",
        name: "Dogecoin",
        symbol: "DOGE",
        address_types: "P2PKH",
        icon: "chain-dogecoin",
        tag: "Dogecoin",
        file: "Latest_Rich_Dogecoin_Addresses.txt.gz",
    },
    Dataset {
        slug: "bitcoin-cash",
        name: "Bitcoin Cash",
        symbol: "BCH",
        address_types: "P2PKH",
        icon: "chain-bitcoin-cash",
        tag: "BitcoinCash",
        file: "Latest_Rich_BitcoinCash_Addresses.txt.gz",
    },
    Dataset {
        slug: "dash",
        name: "Dash",
        symbol: "DASH",
        address_types: "P2PKH",
        icon: "ui-wallet",
        tag: "Dash",
        file: "Latest_Rich_Dash_Addresses.txt.gz",
    },
];

pub fn dataset(slug: &str) -> Option<&'static Dataset> {
    DATASETS.iter().find(|dataset| dataset.slug == slug)
}

/// Public JSON projection of one dataset. Deliberately omits the upstream URL:
/// clients only see our proxy route.
fn dataset_json(dataset: &Dataset) -> Value {
    json!({
        "chain": dataset.slug,
        "name": dataset.name,
        "symbol": dataset.symbol,
        "address_types": dataset.address_types,
        "format": "gzip-compressed text, one address per line",
        "license": LICENSE_NAME,
        "download": format!("/api/v1/wallets/{}/download", dataset.slug),
    })
}

pub fn catalog_json() -> Value {
    let datasets: Vec<_> = DATASETS.iter().map(dataset_json).collect();
    json!({
        "source": SOURCE_NAME,
        "license": {
            "name": LICENSE_NAME,
            "copyright": COPYRIGHT,
            "notice_url": LICENSE_URL,
            "attribution": "Rich-address datasets by MMDRZA (Rich-Address-Wallet), used under the MIT License.",
        },
        "access": "Datasets are mirrored unchanged under the MIT License. Packaged, historical or commercial access is arranged on request through /donate; online checkout is not implemented.",
        "datasets": datasets,
    })
}

/// Serve every `GET /api/v1/wallets*` route. Returns after responding.
pub(super) fn handle(app: &App, request: Request, path: &str) {
    let Some(rest) = path.strip_prefix("/api/v1/wallets") else {
        return respond_json(request, 404, &json!({"error": "not found"}));
    };
    let ip = client_ip(&request, app.trust_proxy);
    if rest.is_empty() {
        if !app.rate.allow(&format!("wallets:{ip}")) {
            return respond_rate_limited(request);
        }
        return respond_json(request, 200, &catalog_json());
    }
    let Some(rest) = rest.strip_prefix('/') else {
        return respond_json(request, 404, &json!({"error": "not found"}));
    };
    if rest.is_empty() || rest.ends_with('/') {
        return respond_json(request, 404, &json!({"error": "not found"}));
    }
    if let Some(slug) = rest.strip_suffix("/download") {
        if !app.rate.allow_with(
            &format!("wallets-download:{ip}"),
            DOWNLOAD_RATE_PER_SECOND,
            DOWNLOAD_BURST,
        ) {
            return respond_rate_limited(request);
        }
        let Some(dataset) = dataset(slug) else {
            return respond_json(request, 404, &json!({"error": "unknown chain"}));
        };
        return download(app, request, dataset);
    }
    // Unknown chains are throttled too, so 404 probing costs the same as a hit.
    if !app.rate.allow(&format!("wallets:{ip}")) {
        return respond_rate_limited(request);
    }
    match dataset(rest) {
        Some(dataset) => respond_json(request, 200, &dataset_json(dataset)),
        None => respond_json(request, 404, &json!({"error": "unknown chain"})),
    }
}

/// Map an upstream HTTP status to our proxy status: a missing dataset stays a
/// 404, every other upstream failure is a clean 502.
fn upstream_error_status(status: u16) -> u16 {
    if status == 404 { 404 } else { 502 }
}

fn respond_upstream_error(request: Request, status: u16, message: &str) {
    respond_json(request, status, &json!({ "error": message }));
}

fn build_agent() -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new()
        .user_agent("rotor-coord/2.0 wallet-database-mirror")
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .timeout_write(WRITE_TIMEOUT);
    // ureq only uses native-tls when the connector is attached explicitly.
    if let Ok(connector) = ureq::native_tls::TlsConnector::new() {
        builder = builder.tls_connector(Arc::new(connector));
    }
    builder.build()
}

fn download(app: &App, request: Request, dataset: &Dataset) {
    let base = app.wallets_upstream.as_deref().unwrap_or(DEFAULT_UPSTREAM);
    let url = format!(
        "{}/{}/{}",
        base.trim_end_matches('/'),
        dataset.tag,
        dataset.file
    );
    let agent = build_agent();
    let response = match agent.get(&url).call() {
        Ok(response) => response,
        Err(ureq::Error::Status(status, _)) => {
            let status = upstream_error_status(status);
            return respond_upstream_error(
                request,
                status,
                if status == 404 {
                    "dataset is not available upstream"
                } else {
                    "upstream download failed"
                },
            );
        }
        Err(ureq::Error::Transport(_)) => {
            return respond_upstream_error(request, 502, "upstream download failed");
        }
    };

    let length = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok());
    if length.is_some_and(|length| length > MAX_DOWNLOAD_BYTES) {
        return respond_upstream_error(request, 502, "dataset exceeds the mirror size limit");
    }
    let data_length = length.and_then(|value| usize::try_from(value).ok());
    // `Take` caps unknown-length streams too; upstream always sends a
    // Content-Length, so this is a belt-and-braces limit.
    let body: Take<Box<dyn Read + Send + Sync>> = response
        .into_reader()
        .take(MAX_DOWNLOAD_BYTES.saturating_add(1));

    let headers = vec![
        header("Content-Type", "application/gzip"),
        header(
            "Content-Disposition",
            &format!("attachment; filename=\"{}\"", dataset.file),
        ),
        header("Cache-Control", "no-store"),
        header("X-Content-Type-Options", "nosniff"),
        header("X-Robots-Tag", "noindex"),
        // MIT requires the notice to travel with the data; point every copy at
        // the license file served next to the storefront.
        header(
            "Link",
            "</wallets/LICENSE.txt>; rel=\"license\"; type=\"text/plain\"",
        ),
    ];
    let response = Response::new(StatusCode(200), headers, body, data_length, None);
    let _ = request.respond(response);
}

fn dataset_card(dataset: &Dataset) -> String {
    format!(
        "<div class=\"address-db-card\">\
         <span class=\"address-db-name\"><svg class=\"icon\" aria-hidden=\"true\"><use href=\"/icons.svg#{icon}\"></use></svg> {name} <span class=\"muted\">{symbol}</span></span>\
         <span class=\"address-db-meta\">Rich addresses · {address_types}</span>\
         <span style=\"display:flex;flex-wrap:wrap;gap:8px;margin-top:10px\">\
         <a class=\"button primary\" href=\"/api/v1/wallets/{slug}/download\">Download dataset</a>\
         <a class=\"button\" href=\"/donate\">Request access</a></span>\
         </div>",
        icon = dataset.icon,
        name = dataset.name,
        symbol = dataset.symbol,
        address_types = dataset.address_types,
        slug = dataset.slug,
    )
}

pub(super) fn render_page(base: &str) -> String {
    let canonical = format!("{base}/wallets");
    let title = "Wallet databases — rich-address lists for six chains | Rotor";
    let description = "Download daily rich-address lists for Bitcoin, Ethereum, Litecoin, Dogecoin, Bitcoin Cash and Dash. Every file is streamed through Rotor under the MIT License.";
    let items: Vec<Value> = DATASETS
        .iter()
        .enumerate()
        .map(|(index, dataset)| {
            json!({
                "@type": "ListItem",
                "position": index + 1,
                "name": format!("{} rich addresses", dataset.name),
                "url": format!("{base}/wallets#{}", dataset.slug),
            })
        })
        .collect();
    let ld_items = json!({
        "@context": "https://schema.org",
        "@type": "ItemList",
        "name": "Rich-address wallet databases",
        "numberOfItems": DATASETS.len(),
        "itemListElement": items,
    });
    let ld_crumbs = breadcrumb_ld(base, &[("Home", Some("/")), ("Wallets", Some("/wallets"))]);
    let head = hub_head(&canonical, title, description, &[ld_items, ld_crumbs]);

    let mut cards = String::new();
    for dataset in &DATASETS {
        cards.push_str(&dataset_card(dataset));
    }
    let license_block = escape_attr(LICENSE_TEXT);
    let body = format!(
        "{header}<main class=\"key-page\">{crumbs}\
         <section class=\"hero\">\
         <h1>Rich-address wallet databases</h1>\
         <p>Daily rich-address lists for Bitcoin, Ethereum, Litecoin, Dogecoin, Bitcoin Cash and Dash. Every download is served from this site; the upstream release host is never contacted by your browser.</p>\
         </section>\
         <section class=\"card\"><h2>Datasets</h2>\
         <div class=\"address-db-grid\">{cards}</div>\
         <p class=\"muted\">Files are gzip-compressed text with one address per line. Sizes change as the upstream snapshots update; the mirror refuses any file above its 2 GB safety cap.</p>\
         </section>\
         <section class=\"card\" id=\"license\"><h2>License / access</h2>\
         <p>These lists come from the <strong>{source}</strong> project by MMDRZA and are provided under the <strong>{license}</strong> License. The required copyright and permission notice is reproduced below and in the <a href=\"{license_url}\">license file</a>.</p>\
         <pre class=\"mono\" style=\"white-space:pre-wrap\">{license_block}</pre>\
         <p class=\"muted\">Rotor mirrors the published snapshots; it does not claim exclusivity or ownership, and it does not invent prices. Lists are provided under the MIT terms above. Packaged, historical or commercial access can be requested through the <a href=\"/donate\">donate / contact</a> page; online checkout is not implemented, so the action is labelled <em>Request access</em> rather than a checkout.</p>\
         </section>\
         </main>",
        header = site_header(),
        crumbs = breadcrumb_nav(&[("Home", Some("/")), ("Wallets", None)]),
        cards = cards,
        source = SOURCE_NAME,
        license = LICENSE_NAME,
        license_url = LICENSE_URL,
        license_block = license_block,
    );
    html_document(title, &head, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chain_allowlist_is_strict() {
        assert_eq!(DATASETS.len(), 6);
        assert!(dataset("bitcoin").is_some());
        assert!(dataset("BitcoinCash").is_none());
        assert!(dataset("../Bitcoin").is_none());
        assert!(dataset("").is_none());
    }

    #[test]
    fn upstream_status_mapping_is_clean() {
        assert_eq!(upstream_error_status(404), 404);
        assert_eq!(upstream_error_status(500), 502);
        assert_eq!(upstream_error_status(403), 502);
    }

    #[test]
    fn catalog_json_leaks_no_upstream_host() {
        let body = catalog_json().to_string();
        assert!(!body.contains("github.com"));
        assert!(body.contains("/api/v1/wallets/bitcoin/download"));
        assert!(body.contains(COPYRIGHT));
    }
}
